import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { getInstallationToken } from "../global/github-auth.js";
import { findGithubInstallation } from "../global/github-installations.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const reconcileResponseSchema = z.object({
  id: z.string(),
  prUrl: z.string().nullable(),
  prState: z.string().nullable(),
  prCheckState: z.string().nullable(),
  status: z.string(),
});

const reconcilePrRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/issues/{id}/reconcile",
  tags: ["pr"],
  middleware: [rls("write", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "PR state reconciled",
      content: {
        "application/json": { schema: reconcileResponseSchema },
      },
    },
    400: { description: "Bad request" },
    404: { description: "Issue not found" },
    502: { description: "GitHub API failure" },
  },
});

const getPrStatusRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{id}/pr",
  tags: ["pr"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "PR status",
      content: {
        "application/json": { schema: reconcileResponseSchema },
      },
    },
    404: { description: "Issue not found" },
  },
});

function parsePrUrl(prUrl: string) {
  const match = prUrl.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/
  );
  if (!match) return undefined;
  return { owner: match[1], name: match[2], number: Number(match[3]) };
}

function normalizePrState(pr: {
  state: string;
  merged: boolean;
  draft: boolean;
}) {
  if (pr.merged) return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.draft) return "draft";
  return "open";
}

function normalizeCheckState(
  checkRuns: { status: string; conclusion: string | null }[]
) {
  if (checkRuns.length === 0) return null;
  const failureConclusions = new Set([
    "failure",
    "action_required",
    "cancelled",
    "skipped",
    "stale",
    "timed_out",
  ]);
  const hasFailure = checkRuns.some(
    (run) => run.conclusion && failureConclusions.has(run.conclusion)
  );
  if (hasFailure) return "failure";
  const hasPending = checkRuns.some((run) => run.status !== "completed");
  if (hasPending) return "pending";
  const allSuccess = checkRuns.every(
    (run) => run.conclusion === "success" || run.conclusion === "neutral"
  );
  return allSuccess ? "success" : "unknown";
}

async function fetchGitHubPull(
  token: string,
  owner: string,
  name: string,
  number: number
) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${name}/pulls/${number}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  if (!res.ok) return undefined;
  const raw: unknown = await res.json();
  const parsed = z
    .object({
      state: z.string(),
      merged: z.boolean(),
      draft: z.boolean(),
      head: z.object({ sha: z.string() }),
    })
    .safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

async function fetchGitHubCheckRuns(
  token: string,
  owner: string,
  name: string,
  ref: string
) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${name}/commits/${ref}/check-runs`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  if (!res.ok) return [];
  const raw: unknown = await res.json();
  const parsed = z
    .object({
      check_runs: z.array(
        z.object({
          status: z.string(),
          conclusion: z.string().nullable(),
        })
      ),
    })
    .safeParse(raw);
  return parsed.success ? parsed.data.check_runs : [];
}

export function registerPrRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(reconcilePrRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const issue = await stub.getIssue(id);
    if (!issue) {
      return c.json({ message: "Issue not found" }, 404);
    }
    if (!issue.prUrl) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Issue has no prUrl",
      });
    }

    const parsed = parsePrUrl(issue.prUrl);
    if (!parsed) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Issue prUrl is not a GitHub pull request URL",
      });
    }

    const repo = `${parsed.owner}/${parsed.name}`;
    const db = createD1(c.env.D1);
    const installation = await findGithubInstallation(db, repo);
    if (!installation) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "GitHub installation not found for repo",
      });
    }

    const token = await getInstallationToken(
      c.env,
      installation.installationId
    );
    if (!token) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "GitHub installation token unavailable",
      });
    }

    const pr = await fetchGitHubPull(
      token,
      parsed.owner,
      parsed.name,
      parsed.number
    );
    if (!pr) {
      throw new VortexError({
        code: "BAD_GATEWAY",
        status: 502,
        message: "GitHub pull request API failed",
      });
    }

    const checkRuns = await fetchGitHubCheckRuns(
      token,
      parsed.owner,
      parsed.name,
      pr.head.sha
    );

    const prState = normalizePrState(pr);
    const prCheckState =
      normalizeCheckState(checkRuns) ?? issue.prCheckState ?? null;

    const identity = c.var.workspaceIdentity;
    const updated = await stub.reconcileIssuePr(
      issue.id,
      issue.prUrl,
      prState,
      prCheckState ?? "unknown",
      identity.id
    );
    if (!updated) {
      return c.json({ message: "Issue not found" }, 404);
    }

    return c.json({
      id: updated.id,
      prUrl: updated.prUrl,
      prState: updated.prState,
      prCheckState: updated.prCheckState,
      status: updated.status,
    });
  });

  app.openapi(getPrStatusRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const issue = await stub.getIssue(id);
    if (!issue) {
      return c.json({ message: "Issue not found" }, 404);
    }

    return c.json({
      id: issue.id,
      prUrl: issue.prUrl,
      prState: issue.prState,
      prCheckState: issue.prCheckState,
      status: issue.status,
    });
  });
}
