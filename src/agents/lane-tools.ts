// Purpose-built lane tool surface (PILE-284). Every GitHub/git operation a
// lane needs is a named tool with one required capability, so a lane's
// permission tier decides exactly which operations it can perform — instead
// of "has a shell + installation token or not". The MCP server in
// src/mcp/lane-server.ts exposes only the tools the tier grants and re-checks
// the capability on every call.
import { z } from "zod";

import { GITHUB_USER_AGENT } from "../global/github-auth.js";
import type { PileRepoConfig } from "../global/pile-repo-config.js";

const GITHUB_API = "https://api.github.com";
const MAX_TEXT = 200_000;

export const LANE_CAPABILITIES = [
  "lane:report",
  "repo:read",
  "checks:read",
  "issue:write",
  "review:write",
  "pr:write",
  "contents:write",
  "checks:write",
  "pr:merge",
] as const;

export type LaneCapability = (typeof LANE_CAPABILITIES)[number];

export type LaneTier = NonNullable<PileRepoConfig["lane"]>["tier"];

export const DEFAULT_LANE_TIER: LaneTier = "write";

const READ_CAPABILITIES: readonly LaneCapability[] = [
  "lane:report",
  "repo:read",
  "checks:read",
];
const REVIEW_CAPABILITIES: readonly LaneCapability[] = [
  ...READ_CAPABILITIES,
  "issue:write",
  "review:write",
];
const WRITE_CAPABILITIES: readonly LaneCapability[] = [
  ...REVIEW_CAPABILITIES,
  "pr:write",
  "contents:write",
  "checks:write",
];

const TIER_CAPABILITIES: Record<LaneTier, readonly LaneCapability[]> = {
  read: READ_CAPABILITIES,
  review: REVIEW_CAPABILITIES,
  write: WRITE_CAPABILITIES,
  maintain: [...WRITE_CAPABILITIES, "pr:merge"],
};

export function laneTierCapabilities(
  tier: LaneTier
): ReadonlySet<LaneCapability> {
  return new Set(TIER_CAPABILITIES[tier]);
}

export function resolveLaneTier(config: PileRepoConfig | null): LaneTier {
  return config?.lane?.tier ?? DEFAULT_LANE_TIER;
}

/** Failure surfaced to the agent as an MCP tool error (isError: true). */
export class LaneToolError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "LaneToolError";
    this.status = status;
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export interface LaneGithubRequest {
  query?: Query;
  body?: unknown;
  /** Accept header override, e.g. the diff media type. */
  accept?: string;
}

/** Server-side GitHub client; the installation token never reaches the lane. */
export interface LaneGithub {
  rest(
    method: string,
    path: string,
    init?: LaneGithubRequest
  ): Promise<unknown>;
  text(path: string, init?: LaneGithubRequest): Promise<string>;
  graphql(query: string, variables: Record<string, unknown>): Promise<unknown>;
}

export interface LaneSessionOps {
  reportProgress(
    message: string,
    payload?: Record<string, unknown>
  ): Promise<void>;
  setOutput(output: { result?: string; prUrl?: string }): Promise<void>;
}

export interface LaneToolContext {
  /** `owner/name` of the session issue's repository. */
  repo: string;
  /** The lane's own head branch — the only branch write tools act on. */
  branch: string;
  tier: LaneTier;
  github: LaneGithub;
  session: LaneSessionOps;
  /** Mint a git push credential downscoped to this repo's contents. */
  mintPushToken(): Promise<string | undefined>;
}

interface LaneToolDefinition<S extends z.ZodObject> {
  name: string;
  description: string;
  capability: LaneCapability;
  input: S;
  run(ctx: LaneToolContext, input: z.output<S>): Promise<unknown>;
}

export interface LaneTool {
  name: string;
  description: string;
  capability: LaneCapability;
  readOnly: boolean;
  input: z.ZodObject;
  call(ctx: LaneToolContext, raw: unknown): Promise<unknown>;
}

const READ_ONLY_CAPABILITIES = new Set<LaneCapability>([
  "repo:read",
  "checks:read",
]);

function defineLaneTool<S extends z.ZodObject>(
  def: LaneToolDefinition<S>
): LaneTool {
  return {
    name: def.name,
    description: def.description,
    capability: def.capability,
    readOnly: READ_ONLY_CAPABILITIES.has(def.capability),
    input: def.input,
    call: async (ctx, raw) => {
      const parsed = def.input.safeParse(raw ?? {});
      if (!parsed.success) {
        throw new LaneToolError(
          `Invalid input for ${def.name}: ${z.prettifyError(parsed.error)}`,
          400
        );
      }
      return def.run(ctx, parsed.data);
    },
  };
}

function repoPath(ctx: LaneToolContext, suffix = ""): string {
  return `/repos/${ctx.repo}${suffix}`;
}

function truncate(text: string): string {
  return text.length > MAX_TEXT
    ? `${text.slice(0, MAX_TEXT)}\n…[truncated ${text.length - MAX_TEXT} chars]`
    : text;
}

const pullNumber = z.number().int().positive();
const issueNumber = z.number().int().positive();
const perPage = z.number().int().min(1).max(100).optional();

const prHeadSchema = z.object({
  number: z.number(),
  html_url: z.string(),
  head: z.object({
    ref: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});

/** Write tools on an existing PR only act on the lane's own PR. */
async function requireLanePull(ctx: LaneToolContext, number: number) {
  const raw = await ctx.github.rest("GET", repoPath(ctx, `/pulls/${number}`));
  const pr = prHeadSchema.parse(raw);
  if (pr.head.ref !== ctx.branch || pr.head.repo?.full_name !== ctx.repo) {
    throw new LaneToolError(
      `Permission denied: PR #${number} is not this lane's PR (head ${pr.head.ref}, lane branch ${ctx.branch})`,
      403
    );
  }
  return pr;
}

const defaultBranchSchema = z.object({ default_branch: z.string() });

async function defaultBranch(ctx: LaneToolContext): Promise<string> {
  const raw = await ctx.github.rest("GET", repoPath(ctx));
  return defaultBranchSchema.parse(raw).default_branch;
}

const contentFileSchema = z.object({
  type: z.literal("file"),
  path: z.string(),
  sha: z.string(),
  size: z.number(),
  encoding: z.string().optional(),
  content: z.string().optional(),
});

function decodeBase64(input: string): string {
  const bin = atob(input.replaceAll("\n", ""));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(input: string): string {
  let bin = "";
  for (const byte of new TextEncoder().encode(input)) {
    bin += String.fromCharCode(byte);
  }
  return btoa(bin);
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 50) {
            nodes { databaseId author { login } body createdAt }
          }
        }
      }
    }
  }
}`;

const RESOLVE_THREAD_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

const THREAD_PR_QUERY = `query($threadId: ID!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread { pullRequest { number } }
  }
}`;

const threadPrSchema = z.object({
  node: z.object({ pullRequest: z.object({ number: z.number() }) }).nullable(),
});

export const LANE_TOOLS: readonly LaneTool[] = [
  // ── lane:report ─────────────────────────────────────────────────────────
  defineLaneTool({
    name: "get_lane_context",
    description:
      "Describe this lane: repository, lane branch, permission tier, granted capabilities, and the tools it may call.",
    capability: "lane:report",
    input: z.object({}),
    run: async (ctx) => ({
      repo: ctx.repo,
      branch: ctx.branch,
      tier: ctx.tier,
      capabilities: [...laneTierCapabilities(ctx.tier)],
      tools: laneToolsForTier(ctx.tier).map((tool) => tool.name),
    }),
  }),
  defineLaneTool({
    name: "report_progress",
    description:
      "Append a progress note to this lane's Pile session timeline and bump its progress heartbeat.",
    capability: "lane:report",
    input: z.object({
      message: z.string().min(1).max(2000),
      data: z.record(z.string(), z.unknown()).optional(),
    }),
    run: async (ctx, input) => {
      await ctx.session.reportProgress(input.message, input.data);
      return { ok: true };
    },
  }),
  defineLaneTool({
    name: "set_output",
    description:
      "Record this lane's result summary and/or PR URL on its Pile session (does not end the session).",
    capability: "lane:report",
    input: z.object({
      result: z.string().max(20_000).optional(),
      prUrl: z.url().optional(),
    }),
    run: async (ctx, input) => {
      await ctx.session.setOutput(input);
      return { ok: true };
    },
  }),
  defineLaneTool({
    name: "select_mode",
    description:
      "Declare which mode this lane is working in (records it on the session timeline). Does not widen the lane's tier.",
    capability: "lane:report",
    input: z.object({
      mode: z.enum([
        "implement",
        "fix",
        "review",
        "address_feedback",
        "triage",
      ]),
      reason: z.string().max(2000).optional(),
    }),
    run: async (ctx, input) => {
      await ctx.session.reportProgress(`Mode: ${input.mode}`, {
        mode: input.mode,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      return { mode: input.mode, tier: ctx.tier };
    },
  }),

  // ── repo:read ───────────────────────────────────────────────────────────
  defineLaneTool({
    name: "get_repository",
    description: "Get repository metadata (default branch, visibility, …).",
    capability: "repo:read",
    input: z.object({}),
    run: (ctx) => ctx.github.rest("GET", repoPath(ctx)),
  }),
  defineLaneTool({
    name: "get_file_contents",
    description:
      "Read a file (decoded text) or list a directory at a ref (defaults to the lane branch).",
    capability: "repo:read",
    input: z.object({
      path: z.string(),
      ref: z.string().optional(),
    }),
    run: async (ctx, input) => {
      const raw = await ctx.github.rest(
        "GET",
        repoPath(
          ctx,
          `/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`
        ),
        { query: { ref: input.ref ?? ctx.branch } }
      );
      const file = contentFileSchema.safeParse(raw);
      if (!file.success) return raw;
      const { content, encoding, ...rest } = file.data;
      return {
        ...rest,
        content:
          content !== undefined && encoding === "base64"
            ? truncate(decodeBase64(content))
            : (content ?? null),
      };
    },
  }),
  defineLaneTool({
    name: "get_branch",
    description: "Get a branch and its head commit.",
    capability: "repo:read",
    input: z.object({ branch: z.string() }),
    run: (ctx, input) =>
      ctx.github.rest(
        "GET",
        repoPath(ctx, `/branches/${encodeURIComponent(input.branch)}`)
      ),
  }),
  defineLaneTool({
    name: "compare_commits",
    description: "Compare two refs (commits ahead/behind and changed files).",
    capability: "repo:read",
    input: z.object({ base: z.string(), head: z.string() }),
    run: (ctx, input) =>
      ctx.github.rest(
        "GET",
        repoPath(
          ctx,
          `/compare/${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}`
        )
      ),
  }),
  defineLaneTool({
    name: "list_pull_requests",
    description: "List pull requests, optionally filtered by state/head/base.",
    capability: "repo:read",
    input: z.object({
      state: z.enum(["open", "closed", "all"]).optional(),
      head: z.string().optional(),
      base: z.string().optional(),
      perPage,
    }),
    run: (ctx, input) =>
      ctx.github.rest("GET", repoPath(ctx, "/pulls"), {
        query: {
          state: input.state,
          head: input.head,
          base: input.base,
          per_page: input.perPage,
        },
      }),
  }),
  defineLaneTool({
    name: "get_pull_request",
    description: "Get a pull request.",
    capability: "repo:read",
    input: z.object({ pullNumber }),
    run: (ctx, input) =>
      ctx.github.rest("GET", repoPath(ctx, `/pulls/${input.pullNumber}`)),
  }),
  defineLaneTool({
    name: "get_pull_request_diff",
    description: "Get a pull request's unified diff.",
    capability: "repo:read",
    input: z.object({ pullNumber }),
    run: async (ctx, input) =>
      truncate(
        await ctx.github.text(repoPath(ctx, `/pulls/${input.pullNumber}`), {
          accept: "application/vnd.github.diff",
        })
      ),
  }),
  defineLaneTool({
    name: "list_pull_request_files",
    description: "List files changed in a pull request.",
    capability: "repo:read",
    input: z.object({ pullNumber, perPage }),
    run: (ctx, input) =>
      ctx.github.rest(
        "GET",
        repoPath(ctx, `/pulls/${input.pullNumber}/files`),
        {
          query: { per_page: input.perPage ?? 100 },
        }
      ),
  }),
  defineLaneTool({
    name: "list_pull_request_reviews",
    description: "List reviews submitted on a pull request.",
    capability: "repo:read",
    input: z.object({ pullNumber }),
    run: (ctx, input) =>
      ctx.github.rest(
        "GET",
        repoPath(ctx, `/pulls/${input.pullNumber}/reviews`)
      ),
  }),
  defineLaneTool({
    name: "list_review_comments",
    description: "List inline review comments on a pull request.",
    capability: "repo:read",
    input: z.object({ pullNumber, perPage }),
    run: (ctx, input) =>
      ctx.github.rest(
        "GET",
        repoPath(ctx, `/pulls/${input.pullNumber}/comments`),
        { query: { per_page: input.perPage ?? 100 } }
      ),
  }),
  defineLaneTool({
    name: "list_review_threads",
    description:
      "List review threads on a pull request with resolution state and thread ids (for resolve_review_thread).",
    capability: "repo:read",
    input: z.object({ pullNumber }),
    run: (ctx, input) => {
      const [owner, name] = ctx.repo.split("/");
      return ctx.github.graphql(REVIEW_THREADS_QUERY, {
        owner,
        name,
        number: input.pullNumber,
      });
    },
  }),
  defineLaneTool({
    name: "get_issue",
    description: "Get a GitHub issue (or PR, as an issue).",
    capability: "repo:read",
    input: z.object({ issueNumber }),
    run: (ctx, input) =>
      ctx.github.rest("GET", repoPath(ctx, `/issues/${input.issueNumber}`)),
  }),
  defineLaneTool({
    name: "list_issue_comments",
    description: "List conversation comments on an issue or pull request.",
    capability: "repo:read",
    input: z.object({ issueNumber, perPage }),
    run: (ctx, input) =>
      ctx.github.rest(
        "GET",
        repoPath(ctx, `/issues/${input.issueNumber}/comments`),
        { query: { per_page: input.perPage ?? 100 } }
      ),
  }),
  defineLaneTool({
    name: "find_similar_issues",
    description:
      "Search this repository's issues for ones similar to a query (dedupe before filing or fixing).",
    capability: "repo:read",
    input: z.object({
      query: z.string().min(1).max(256),
      state: z.enum(["open", "closed"]).optional(),
      perPage,
    }),
    run: (ctx, input) =>
      ctx.github.rest("GET", "/search/issues", {
        query: {
          q: [
            `repo:${ctx.repo}`,
            "is:issue",
            input.state ? `is:${input.state}` : null,
            input.query,
          ]
            .filter((part) => part !== null)
            .join(" "),
          per_page: input.perPage ?? 10,
        },
      }),
  }),

  // ── checks:read ─────────────────────────────────────────────────────────
  defineLaneTool({
    name: "list_check_runs",
    description: "List check runs for a ref (defaults to the lane branch).",
    capability: "checks:read",
    input: z.object({ ref: z.string().optional() }),
    run: (ctx, input) =>
      ctx.github.rest(
        "GET",
        repoPath(
          ctx,
          `/commits/${encodeURIComponent(input.ref ?? ctx.branch)}/check-runs`
        ),
        { query: { per_page: 100 } }
      ),
  }),
  defineLaneTool({
    name: "get_check_run",
    description: "Get a check run, including its output summary.",
    capability: "checks:read",
    input: z.object({ checkRunId: z.number().int().positive() }),
    run: (ctx, input) =>
      ctx.github.rest("GET", repoPath(ctx, `/check-runs/${input.checkRunId}`)),
  }),
  defineLaneTool({
    name: "list_workflow_runs",
    description:
      "List GitHub Actions workflow runs (defaults to the lane branch).",
    capability: "checks:read",
    input: z.object({
      branch: z.string().optional(),
      status: z.string().optional(),
      perPage,
    }),
    run: (ctx, input) =>
      ctx.github.rest("GET", repoPath(ctx, "/actions/runs"), {
        query: {
          branch: input.branch ?? ctx.branch,
          status: input.status,
          per_page: input.perPage ?? 20,
        },
      }),
  }),
  defineLaneTool({
    name: "list_workflow_run_jobs",
    description: "List the jobs of a workflow run (job ids feed get_job_logs).",
    capability: "checks:read",
    input: z.object({ runId: z.number().int().positive() }),
    run: (ctx, input) =>
      ctx.github.rest(
        "GET",
        repoPath(ctx, `/actions/runs/${input.runId}/jobs`)
      ),
  }),
  defineLaneTool({
    name: "get_job_logs",
    description:
      "Get the tail of a GitHub Actions job's log (default last 400 lines).",
    capability: "checks:read",
    input: z.object({
      jobId: z.number().int().positive(),
      tailLines: z.number().int().min(1).max(5000).optional(),
    }),
    run: async (ctx, input) => {
      const text = await ctx.github.text(
        repoPath(ctx, `/actions/jobs/${input.jobId}/logs`)
      );
      const lines = text.split("\n");
      return {
        text: truncate(lines.slice(-(input.tailLines ?? 400)).join("\n")),
      };
    },
  }),

  // ── issue:write ─────────────────────────────────────────────────────────
  defineLaneTool({
    name: "create_issue_comment",
    description: "Comment on an issue or pull request conversation.",
    capability: "issue:write",
    input: z.object({ issueNumber, body: z.string().min(1).max(65_536) }),
    run: (ctx, input) =>
      ctx.github.rest(
        "POST",
        repoPath(ctx, `/issues/${input.issueNumber}/comments`),
        { body: { body: input.body } }
      ),
  }),
  defineLaneTool({
    name: "add_labels",
    description: "Add labels to an issue or pull request.",
    capability: "issue:write",
    input: z.object({
      issueNumber,
      labels: z.array(z.string().min(1)).min(1).max(20),
    }),
    run: (ctx, input) =>
      ctx.github.rest(
        "POST",
        repoPath(ctx, `/issues/${input.issueNumber}/labels`),
        { body: { labels: input.labels } }
      ),
  }),
  defineLaneTool({
    name: "remove_label",
    description: "Remove a label from an issue or pull request.",
    capability: "issue:write",
    input: z.object({ issueNumber, label: z.string().min(1) }),
    run: (ctx, input) =>
      ctx.github.rest(
        "DELETE",
        repoPath(
          ctx,
          `/issues/${input.issueNumber}/labels/${encodeURIComponent(input.label)}`
        )
      ),
  }),

  // ── review:write ────────────────────────────────────────────────────────
  defineLaneTool({
    name: "create_pull_request_review",
    description:
      "Submit a review on a pull request, optionally with inline comments.",
    capability: "review:write",
    input: z.object({
      pullNumber,
      event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
      body: z.string().max(65_536).optional(),
      commitId: z.string().optional(),
      comments: z
        .array(
          z.object({
            path: z.string(),
            line: z.number().int().positive(),
            side: z.enum(["LEFT", "RIGHT"]).optional(),
            startLine: z.number().int().positive().optional(),
            body: z.string().min(1),
          })
        )
        .max(50)
        .optional(),
    }),
    run: (ctx, input) =>
      ctx.github.rest(
        "POST",
        repoPath(ctx, `/pulls/${input.pullNumber}/reviews`),
        {
          body: {
            event: input.event,
            body: input.body,
            commit_id: input.commitId,
            comments: input.comments?.map((comment) => ({
              path: comment.path,
              line: comment.line,
              side: comment.side,
              start_line: comment.startLine,
              body: comment.body,
            })),
          },
        }
      ),
  }),
  defineLaneTool({
    name: "reply_to_review_comment",
    description: "Reply in the thread of an inline review comment.",
    capability: "review:write",
    input: z.object({
      pullNumber,
      commentId: z.number().int().positive(),
      body: z.string().min(1).max(65_536),
    }),
    run: (ctx, input) =>
      ctx.github.rest(
        "POST",
        repoPath(
          ctx,
          `/pulls/${input.pullNumber}/comments/${input.commentId}/replies`
        ),
        { body: { body: input.body } }
      ),
  }),
  defineLaneTool({
    name: "resolve_review_thread",
    description:
      "Resolve a review thread on this lane's PR (thread id from list_review_threads).",
    capability: "review:write",
    input: z.object({ threadId: z.string().min(1) }),
    run: async (ctx, input) => {
      const owner = threadPrSchema.parse(
        await ctx.github.graphql(THREAD_PR_QUERY, { threadId: input.threadId })
      );
      if (!owner.node) {
        throw new LaneToolError(
          `Review thread ${input.threadId} not found`,
          404
        );
      }
      await requireLanePull(ctx, owner.node.pullRequest.number);
      return ctx.github.graphql(RESOLVE_THREAD_MUTATION, {
        threadId: input.threadId,
      });
    },
  }),

  // ── pr:write ────────────────────────────────────────────────────────────
  defineLaneTool({
    name: "create_pull_request",
    description:
      "Open a pull request from the lane branch (head is always the lane branch; base defaults to the repo default branch).",
    capability: "pr:write",
    input: z.object({
      title: z.string().min(1).max(256),
      body: z.string().max(65_536).optional(),
      base: z.string().optional(),
      draft: z.boolean().optional(),
    }),
    run: async (ctx, input) =>
      ctx.github.rest("POST", repoPath(ctx, "/pulls"), {
        body: {
          title: input.title,
          body: input.body,
          head: ctx.branch,
          base: input.base ?? (await defaultBranch(ctx)),
          draft: input.draft,
        },
      }),
  }),
  defineLaneTool({
    name: "update_pull_request",
    description: "Edit this lane's pull request (title, body, base, state).",
    capability: "pr:write",
    input: z.object({
      pullNumber,
      title: z.string().min(1).max(256).optional(),
      body: z.string().max(65_536).optional(),
      base: z.string().optional(),
      state: z.enum(["open", "closed"]).optional(),
    }),
    run: async (ctx, input) => {
      await requireLanePull(ctx, input.pullNumber);
      return ctx.github.rest(
        "PATCH",
        repoPath(ctx, `/pulls/${input.pullNumber}`),
        {
          body: {
            title: input.title,
            body: input.body,
            base: input.base,
            state: input.state,
          },
        }
      );
    },
  }),
  defineLaneTool({
    name: "request_reviewers",
    description: "Request reviewers on this lane's pull request.",
    capability: "pr:write",
    input: z.object({
      pullNumber,
      reviewers: z.array(z.string().min(1)).max(15).optional(),
      teamReviewers: z.array(z.string().min(1)).max(15).optional(),
    }),
    run: async (ctx, input) => {
      await requireLanePull(ctx, input.pullNumber);
      return ctx.github.rest(
        "POST",
        repoPath(ctx, `/pulls/${input.pullNumber}/requested_reviewers`),
        {
          body: {
            reviewers: input.reviewers,
            team_reviewers: input.teamReviewers,
          },
        }
      );
    },
  }),

  // ── contents:write ──────────────────────────────────────────────────────
  defineLaneTool({
    name: "create_branch",
    description:
      "Create the lane branch from a base ref (defaults to the repo default branch). No-op when it already exists.",
    capability: "contents:write",
    input: z.object({ base: z.string().optional() }),
    run: async (ctx, input) => {
      const base = input.base ?? (await defaultBranch(ctx));
      const ref = z
        .object({ object: z.object({ sha: z.string() }) })
        .parse(
          await ctx.github.rest(
            "GET",
            repoPath(ctx, `/git/ref/heads/${encodeURIComponent(base)}`)
          )
        );
      try {
        await ctx.github.rest("POST", repoPath(ctx, "/git/refs"), {
          body: { ref: `refs/heads/${ctx.branch}`, sha: ref.object.sha },
        });
        return { branch: ctx.branch, created: true, sha: ref.object.sha };
      } catch (error) {
        if (error instanceof LaneToolError && error.status === 422) {
          return { branch: ctx.branch, created: false };
        }
        throw error;
      }
    },
  }),
  defineLaneTool({
    name: "upload_file",
    description:
      "Create or update a file on the lane branch in one commit (UTF-8 text, or base64 for binary). Returns the commit and the file's raw URL.",
    capability: "contents:write",
    input: z.object({
      path: z.string().min(1),
      content: z.string(),
      encoding: z.enum(["utf-8", "base64"]).default("utf-8"),
      message: z.string().min(1).max(500),
    }),
    run: async (ctx, input) => {
      const path = repoPath(
        ctx,
        `/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`
      );
      let sha: string | undefined;
      try {
        sha = z
          .object({ sha: z.string() })
          .parse(
            await ctx.github.rest("GET", path, { query: { ref: ctx.branch } })
          ).sha;
      } catch (error) {
        if (!(error instanceof LaneToolError && error.status === 404)) {
          throw error;
        }
      }
      const written = z
        .object({
          content: z.object({
            path: z.string(),
            download_url: z.string().nullable(),
          }),
          commit: z.object({ sha: z.string() }),
        })
        .parse(
          await ctx.github.rest("PUT", path, {
            body: {
              message: input.message,
              branch: ctx.branch,
              content:
                input.encoding === "base64"
                  ? input.content
                  : encodeBase64(input.content),
              ...(sha ? { sha } : {}),
            },
          })
        );
      return {
        path: written.content.path,
        url: written.content.download_url,
        commit: written.commit.sha,
      };
    },
  }),
  defineLaneTool({
    name: "get_push_credential",
    description:
      "Mint a short-lived git credential for pushing the lane branch. The token is downscoped to this repository's contents.",
    capability: "contents:write",
    input: z.object({}),
    run: async (ctx) => {
      const token = await ctx.mintPushToken();
      if (!token) {
        throw new LaneToolError("No installation token for repository", 502);
      }
      return {
        username: "x-access-token",
        token,
        remote: `https://github.com/${ctx.repo}.git`,
        branch: ctx.branch,
      };
    },
  }),

  // ── checks:write ────────────────────────────────────────────────────────
  defineLaneTool({
    name: "rerun_failed_jobs",
    description: "Re-run the failed jobs of a workflow run.",
    capability: "checks:write",
    input: z.object({ runId: z.number().int().positive() }),
    run: async (ctx, input) => {
      await ctx.github.rest(
        "POST",
        repoPath(ctx, `/actions/runs/${input.runId}/rerun-failed-jobs`)
      );
      return { ok: true };
    },
  }),

  // ── pr:merge ────────────────────────────────────────────────────────────
  defineLaneTool({
    name: "merge_pull_request",
    description: "Merge this lane's pull request.",
    capability: "pr:merge",
    input: z.object({
      pullNumber,
      method: z.enum(["merge", "squash", "rebase"]).optional(),
      sha: z.string().optional(),
    }),
    run: async (ctx, input) => {
      await requireLanePull(ctx, input.pullNumber);
      return ctx.github.rest(
        "PUT",
        repoPath(ctx, `/pulls/${input.pullNumber}/merge`),
        { body: { merge_method: input.method ?? "squash", sha: input.sha } }
      );
    },
  }),
];

export function laneToolsForTier(tier: LaneTier): LaneTool[] {
  const granted = laneTierCapabilities(tier);
  return LANE_TOOLS.filter((tool) => granted.has(tool.capability));
}

export interface LaneToolResult {
  ok: boolean;
  text: string;
}

/**
 * Single enforcement point: resolves the tool, checks its capability against
 * the lane tier, validates input, and runs it.
 */
export async function callLaneTool(
  ctx: LaneToolContext,
  name: string,
  args: unknown
): Promise<LaneToolResult> {
  const tool = LANE_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { ok: false, text: `Unknown lane tool: ${name}` };
  if (!laneTierCapabilities(ctx.tier).has(tool.capability)) {
    return {
      ok: false,
      text: `Permission denied: ${name} requires ${tool.capability}; lane tier "${ctx.tier}" does not grant it`,
    };
  }
  try {
    const result = await tool.call(ctx, args);
    return {
      ok: true,
      text:
        typeof result === "string" ? result : JSON.stringify(result ?? null),
    };
  } catch (error) {
    if (error instanceof LaneToolError)
      return { ok: false, text: error.message };
    if (error instanceof z.ZodError) {
      return {
        ok: false,
        text: `Unexpected GitHub response for ${name}: ${z.prettifyError(error)}`,
      };
    }
    throw error;
  }
}

function buildUrl(path: string, query?: Query): string {
  const url = new URL(`${GITHUB_API}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function githubError(response: Response): Promise<LaneToolError> {
  const text = await response.text();
  let message = text.slice(0, 2000);
  try {
    const parsed = z
      .object({ message: z.string() })
      .safeParse(JSON.parse(text));
    if (parsed.success) message = parsed.data.message;
  } catch {
    // non-JSON error body — keep the raw text
  }
  return new LaneToolError(
    `GitHub ${response.status}: ${message}`,
    response.status
  );
}

/**
 * LaneGithub backed by the GitHub REST/GraphQL APIs. `token` is minted
 * lazily once per client and reused for every call in the request.
 */
export function createLaneGithub(
  mintToken: () => Promise<string | undefined>
): LaneGithub {
  let pending: Promise<string> | null = null;
  const token = () => {
    pending ??= mintToken().then((value) => {
      if (!value) {
        throw new LaneToolError("No installation token for repository", 502);
      }
      return value;
    });
    return pending;
  };
  const headers = async (accept?: string, json = false) => ({
    Authorization: `Bearer ${await token()}`,
    Accept: accept ?? "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": GITHUB_USER_AGENT,
    ...(json ? { "Content-Type": "application/json" } : {}),
  });

  return {
    async rest(method, path, init = {}) {
      const hasBody = method !== "GET" && init.body !== undefined;
      const response = await fetch(buildUrl(path, init.query), {
        method,
        headers: await headers(init.accept, hasBody),
        ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      });
      if (!response.ok) throw await githubError(response);
      if (response.status === 204) return null;
      const text = await response.text();
      return text ? (JSON.parse(text) as unknown) : null;
    },
    async text(path, init = {}) {
      // Log downloads 302 to a pre-signed blob URL that rejects the GitHub
      // bearer, so follow the redirect manually without credentials.
      const response = await fetch(buildUrl(path, init.query), {
        headers: await headers(init.accept),
        redirect: "manual",
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        const blob = await fetch(location);
        if (!blob.ok) throw await githubError(blob);
        return blob.text();
      }
      if (!response.ok) throw await githubError(response);
      return response.text();
    },
    async graphql(query, variables) {
      const response = await fetch(`${GITHUB_API}/graphql`, {
        method: "POST",
        headers: await headers(undefined, true),
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) throw await githubError(response);
      const parsed = z
        .object({
          data: z.unknown().optional(),
          errors: z.array(z.object({ message: z.string() })).optional(),
        })
        .parse(await response.json());
      if (parsed.errors && parsed.errors.length > 0) {
        throw new LaneToolError(
          `GitHub GraphQL: ${parsed.errors.map((e) => e.message).join("; ")}`
        );
      }
      return parsed.data ?? null;
    },
  };
}
