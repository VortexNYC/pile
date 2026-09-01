import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { createD1 } from "../global/db.js";
import { findRepoBranch } from "../global/repo-branches.js";
import {
  createRepoIssue,
  deleteRepoIssue,
  findRepoIssue,
  findRepoWorkspace,
} from "../global/repo-issues.js";
import { hmacSha256Hex, timingSafeEqualHex } from "../platform/crypto.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../api/middleware.js";

const pullRequestPayloadSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    state: z.string(),
    html_url: z.string(),
    head: z.object({
      ref: z.string(),
      repo: z.object({
        full_name: z.string(),
      }),
    }),
  }),
});

const issuePayloadSchema = z.object({
  action: z.enum([
    "opened",
    "edited",
    "closed",
    "reopened",
    "deleted",
    "labeled",
    "unlabeled",
    "assigned",
    "unassigned",
  ]),
  issue: z.object({
    number: z.number().int(),
    title: z.string(),
    body: z.string().nullable(),
    state: z.enum(["open", "closed"]),
    html_url: z.string(),
    labels: z
      .array(
        z.object({
          name: z.string(),
        })
      )
      .default([]),
  }),
  repository: z.object({
    full_name: z.string(),
  }),
});

export const githubWebhookRoute = createRoute({
  method: "post",
  path: "/github",
  tags: ["github"],
  responses: {
    200: {
      description: "Webhook processed",
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean() }),
        },
      },
    },
  },
});

function extractWorkspaceIdFromLabels(
  labels: Array<{ name: string }>
): string | undefined {
  const label = labels.find((l) => l.name.startsWith("vortex:"));
  return label?.name.split(":")[1]?.trim();
}

export async function processGithubWebhook(
  c: Context<AppContext>
): Promise<{ ok: true }> {
  const signature = c.req.header("x-hub-signature-256") ?? "";
  const rawBody = await c.req.text();

  if (c.env.GITHUB_WEBHOOK_SECRET) {
    const expected = `sha256=${await hmacSha256Hex(
      c.env.GITHUB_WEBHOOK_SECRET,
      rawBody
    )}`;
    if (!timingSafeEqualHex(signature, expected)) {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Invalid GitHub signature",
      });
    }
  }

  const event = c.req.header("x-github-event");
  if (event === "pull_request") {
    return processPullRequest(c, rawBody);
  }
  if (event === "issues") {
    return processGitHubIssue(c, rawBody);
  }
  return { ok: true };
}

async function processPullRequest(
  c: Context<AppContext>,
  rawBody: string
): Promise<{ ok: true }> {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid JSON",
    });
  }

  const payload = pullRequestPayloadSchema.safeParse(parsedBody);
  if (!payload.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid pull_request payload",
      hint: payload.error.message,
    });
  }

  const { pull_request } = payload.data;
  const repo = pull_request.head.repo.full_name;
  const branch = pull_request.head.ref;
  const prUrl = pull_request.html_url;
  const prState = pull_request.state;

  const db = createD1(c.env.D1);
  const record = await findRepoBranch(db, repo, branch);
  if (!record) {
    return { ok: true };
  }

  const doId = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(record.workspaceId);
  const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(doId);
  await stub.updatePrState(repo, branch, prUrl, prState);

  return { ok: true };
}

async function processGitHubIssue(
  c: Context<AppContext>,
  rawBody: string
): Promise<{ ok: true }> {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid JSON",
    });
  }

  const payload = issuePayloadSchema.safeParse(parsedBody);
  if (!payload.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Invalid issues payload",
      hint: payload.error.message,
    });
  }

  const { action, issue, repository } = payload.data;
  const repo = repository.full_name;
  const db = createD1(c.env.D1);

  let workspaceId = extractWorkspaceIdFromLabels(issue.labels);
  if (!workspaceId) {
    const record = await findRepoWorkspace(db, repo);
    workspaceId = record?.workspaceId;
  }

  if (!workspaceId) {
    return { ok: true };
  }

  const doId = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(workspaceId);
  const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(doId);
  const mapping = await findRepoIssue(db, repo, issue.number);

  if (action === "opened" || action === "reopened") {
    const status = action === "reopened" ? "todo" : "backlog";
    if (mapping) {
      const updated = await stub.updateIssue(mapping.issueId, {
        title: issue.title,
        description: issue.body ?? undefined,
        status,
        repo,
      });
      if (!updated) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Mapped issue not found in workspace",
        });
      }
      return { ok: true };
    }
    const created = await stub.createIssue({
      title: issue.title,
      description: issue.body ?? undefined,
      repo,
    });
    await createRepoIssue(db, workspaceId, repo, issue.number, created.id);
    return { ok: true };
  }

  if (action === "edited") {
    if (!mapping) {
      return { ok: true };
    }
    const updated = await stub.updateIssue(mapping.issueId, {
      title: issue.title,
      description: issue.body ?? undefined,
      repo,
    });
    if (!updated) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Mapped issue not found in workspace",
      });
    }
    return { ok: true };
  }

  if (action === "closed") {
    if (!mapping) {
      return { ok: true };
    }
    const updated = await stub.updateIssue(mapping.issueId, { status: "done" });
    if (!updated) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Mapped issue not found in workspace",
      });
    }
    return { ok: true };
  }

  if (action === "deleted") {
    if (mapping) {
      await stub.updateIssue(mapping.issueId, { status: "canceled" });
      await deleteRepoIssue(db, repo, issue.number);
    }
    return { ok: true };
  }

  return { ok: true };
}
