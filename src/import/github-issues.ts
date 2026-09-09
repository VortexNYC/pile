import { z } from "zod";

import { findOrCreateCycleByName } from "../global/cycles.js";
import type { D1Client } from "../global/db.js";
import { findUserByGithubLogin } from "../global/github-users.js";
import { findLabelsByWorkspaceAndNames } from "../global/labels.js";
import { createRepoIssue, findRepoIssue } from "../global/repo-issues.js";
import { VortexError } from "../platform/errors.js";
import type { IssueInput } from "../types/workspace.js";
import type {
  ImportBatchResult,
  ImportContext,
  ImportRunState,
  ImportSource,
  ImportValidationResult,
} from "./types.js";

const GITHUB_API_BASE = "https://api.github.com";

export const githubIssuesCredentialsSchema = z.object({
  token: z.string().min(1),
});

export type GithubIssuesCredentials = z.infer<
  typeof githubIssuesCredentialsSchema
>;

export const githubIssuesOptionsSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  teamId: z.string().optional(),
  state: z.enum(["open", "closed", "all"]).optional().default("open"),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export type GithubIssuesOptions = z.infer<typeof githubIssuesOptionsSchema>;

const githubUserSchema = z.object({
  login: z.string(),
});

const githubIssueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  state_reason: z
    .enum(["completed", "not_planned", "reopened"])
    .nullable()
    .optional(),
  user: githubUserSchema.nullable(),
  assignee: githubUserSchema.nullable(),
  milestone: z
    .object({
      title: z.string(),
    })
    .nullable()
    .optional(),
  labels: z
    .array(
      z.object({
        name: z.string(),
      })
    )
    .default([]),
  pull_request: z.unknown().optional(),
});

type GithubIssue = z.infer<typeof githubIssueSchema>;

async function githubRequest<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: response.status,
      message: `GitHub API request failed: ${response.statusText}`,
    });
  }
  return response.json() as Promise<T>;
}

async function getGithubRepository(token: string, owner: string, repo: string) {
  const raw = await githubRequest<unknown>(token, `/repos/${owner}/${repo}`);
  const parsed = z
    .object({
      id: z.number(),
      full_name: z.string(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 500,
      message: "Invalid GitHub repository response",
    });
  }
  return parsed.data;
}

async function listGithubIssues(
  token: string,
  owner: string,
  repo: string,
  issueState: string,
  page: number,
  perPage: number
): Promise<{ issues: GithubIssue[]; hasMore: boolean }> {
  const raw = await githubRequest<unknown[]>(
    token,
    `/repos/${owner}/${repo}/issues?state=${issueState}&per_page=${perPage}&page=${page}`
  );
  const parsed = z.array(githubIssueSchema).safeParse(raw);
  if (!parsed.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 500,
      message: "Invalid GitHub issues response",
    });
  }
  return { issues: parsed.data, hasMore: parsed.data.length === perPage };
}

function githubStateToVortexStatus(
  state: GithubIssue["state"],
  stateReason: GithubIssue["state_reason"]
): IssueInput["status"] {
  if (state === "open") return "backlog";
  if (stateReason === "completed") return "done";
  return "canceled";
}

async function resolveGithubUser(
  db: D1Client,
  organizationId: string,
  login: string | null | undefined,
  fallbackId: string
): Promise<string> {
  if (!login) return fallbackId;
  const mapping = await findUserByGithubLogin(db, organizationId, login);
  return mapping?.userId ?? fallbackId;
}

async function syncGithubIssue(
  ctx: ImportContext,
  issue: GithubIssue,
  repo: string,
  teamId: string | undefined
): Promise<"created" | "updated"> {
  if (issue.pull_request) {
    return "created";
  }

  const actorId = await resolveGithubUser(
    ctx.db,
    ctx.organizationId,
    issue.user?.login,
    ctx.importerId
  );
  const assigneeId = issue.assignee
    ? (
        await findUserByGithubLogin(
          ctx.db,
          ctx.organizationId,
          issue.assignee.login
        )
      )?.userId
    : undefined;
  const cycleId = issue.milestone
    ? await findOrCreateCycleByName(
        ctx.db,
        ctx.organizationId,
        issue.milestone.title
      )
    : undefined;

  const labelNames = issue.labels.map((label) => label.name);
  const matched = await findLabelsByWorkspaceAndNames(
    ctx.db,
    ctx.organizationId,
    labelNames
  );
  const labelIds =
    matched.length > 0 ? matched.map((l) => l.id).join(",") : undefined;

  const status = githubStateToVortexStatus(
    issue.state,
    issue.state_reason ?? null
  );

  const mapping = await findRepoIssue(ctx.db, repo, issue.number, "github");

  if (mapping) {
    await ctx.stub.updateIssue(
      mapping.issueId,
      {
        title: issue.title,
        description: issue.body ?? undefined,
        status,
        assigneeId,
        cycleId,
        labelIds,
        repo,
        teamId,
      },
      actorId
    );
    return "updated";
  }

  const created = await ctx.stub.createIssue(
    {
      title: issue.title,
      description: issue.body ?? undefined,
      status,
      assigneeId,
      cycleId,
      labelIds,
      repo,
      teamId,
    },
    actorId
  );
  await createRepoIssue(
    ctx.db,
    ctx.organizationId,
    repo,
    issue.number,
    created.id,
    "github"
  );
  return "created";
}

export const githubIssuesImportSource: ImportSource<
  GithubIssuesCredentials,
  GithubIssuesOptions
> = {
  name: "github-issues",

  validate(credentials): ImportValidationResult {
    const parsed = githubIssuesCredentialsSchema.safeParse(credentials);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.message };
    }
    return { ok: true };
  },

  async run(ctx, credentials, options, runState): Promise<ImportBatchResult> {
    const { token } = credentials;
    const parsedOptions = githubIssuesOptionsSchema.parse(options ?? {});
    const { owner, repo, teamId, state: issueState } = parsedOptions;
    const limit = runState?.limit ?? parsedOptions.limit;
    const startPage = runState?.cursor
      ? parseInt(runState.cursor, 10)
      : parsedOptions.cursor
        ? parseInt(parsedOptions.cursor, 10)
        : 1;
    const fullRepo = `${owner}/${repo}`;

    await getGithubRepository(token, owner, repo);

    let created = 0;
    let updated = 0;
    let errors = 0;
    let processed = 0;
    let page = startPage;
    const perPage = Math.min(limit ?? 100, 100);
    let nextCursor: string | null = null;

    while (true) {
      const { issues, hasMore } = await listGithubIssues(
        token,
        owner,
        repo,
        issueState,
        page,
        perPage
      );
      if (issues.length === 0) break;

      for (const issue of issues) {
        try {
          const result = await syncGithubIssue(ctx, issue, fullRepo, teamId);
          if (result === "created") created++;
          else updated++;
        } catch {
          errors++;
        }
      }

      processed += issues.length;

      const hasNextPage = hasMore && (limit === undefined || processed < limit);
      if (!hasNextPage) {
        if (hasMore && limit !== undefined && processed >= limit) {
          nextCursor = String(page + 1);
        }
        break;
      }
      page++;
    }

    return {
      counts: {
        issues: created + updated,
        created,
        updated,
        errors,
      },
      nextCursor,
    };
  },
};
