import { z } from "zod";

import { GITHUB_USER_AGENT } from "../global/github-auth.js";

// PILE-284 — purpose-built lane tool surface. Instead of handing a lane a raw
// shell + installation token for GitHub ops, Pile exposes named tools that
// wrap the GitHub API server-side. Every tool declares one permission; a
// lane's tier grants a permission set, and per-repo policy can deny single
// tools. The installation token never leaves the Worker and every call is
// pinned to the session issue's repository.

export const LANE_TOOL_PERMISSIONS = [
  "repo:read",
  "pr:write",
  "review:write",
  "checks:write",
  "lane:report",
] as const;

export type LaneToolPermission = (typeof LANE_TOOL_PERMISSIONS)[number];

export const LANE_TOOL_TIERS = {
  readonly: ["repo:read", "lane:report"],
  review: ["repo:read", "lane:report", "review:write"],
  contribute: ["repo:read", "lane:report", "pr:write", "review:write"],
  maintain: [
    "repo:read",
    "lane:report",
    "pr:write",
    "review:write",
    "checks:write",
  ],
} as const satisfies Record<string, readonly LaneToolPermission[]>;

export type LaneToolTier = keyof typeof LANE_TOOL_TIERS;

export const DEFAULT_LANE_TOOL_TIER: LaneToolTier = "contribute";

export interface LaneToolPolicy {
  tier: LaneToolTier;
  permissions: ReadonlySet<LaneToolPermission>;
  /** Tool names denied regardless of tier. */
  deny: ReadonlySet<string>;
}

function isTier(value: unknown): value is LaneToolTier {
  return typeof value === "string" && Object.hasOwn(LANE_TOOL_TIERS, value);
}

export function laneToolPolicy(
  tier: LaneToolTier,
  deny: Iterable<string> = []
): LaneToolPolicy {
  return {
    tier,
    permissions: new Set<LaneToolPermission>(LANE_TOOL_TIERS[tier]),
    deny: new Set(deny),
  };
}

/** Repo-level lane tool policy lives in organization.metadata.laneTools keyed
 *  by "owner/name" (or "*" for the workspace default). An entry is either a
 *  tier name or `{ tier?, deny?: string[] }`. Absent or malformed falls back
 *  to DEFAULT_LANE_TOOL_TIER with nothing denied. */
export function laneToolPolicyForRepo(
  orgMetadata: Record<string, unknown> | null,
  repo: string
): LaneToolPolicy {
  const table = orgMetadata?.laneTools;
  if (typeof table !== "object" || table === null) {
    return laneToolPolicy(DEFAULT_LANE_TOOL_TIER);
  }
  const entries = table as Record<string, unknown>;
  const entry = Object.hasOwn(entries, repo) ? entries[repo] : entries["*"];
  if (isTier(entry)) return laneToolPolicy(entry);
  if (typeof entry !== "object" || entry === null) {
    return laneToolPolicy(DEFAULT_LANE_TOOL_TIER);
  }
  const cfg = entry as Record<string, unknown>;
  const tier = isTier(cfg.tier) ? cfg.tier : DEFAULT_LANE_TOOL_TIER;
  const deny = Array.isArray(cfg.deny)
    ? cfg.deny.filter((d): d is string => typeof d === "string")
    : [];
  return laneToolPolicy(tier, deny);
}

export function laneToolAllowed(
  policy: LaneToolPolicy,
  tool: Pick<LaneTool, "name" | "permission">
): boolean {
  return policy.permissions.has(tool.permission) && !policy.deny.has(tool.name);
}

// ---- GitHub client -------------------------------------------------------

export class LaneToolError extends Error {}

const GITHUB_API = "https://api.github.com";
/** Log/diff payloads are tail/head-truncated so a tool result stays small. */
const MAX_TEXT_CHARS = 60_000;

export interface LaneGithub {
  request(
    method: string,
    path: string,
    body?: unknown,
    accept?: string
  ): Promise<unknown>;
  text(path: string, accept?: string): Promise<string>;
  graphql(query: string, variables: Record<string, unknown>): Promise<unknown>;
}

export function createLaneGithub(
  token: string,
  ghFetch: typeof fetch = fetch
): LaneGithub {
  const call = async (
    method: string,
    path: string,
    body: unknown,
    accept: string
  ): Promise<Response> => {
    const res = await ghFetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": GITHUB_USER_AGENT,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new LaneToolError(
        `github ${method} ${path} -> ${res.status} ${detail}`
      );
    }
    return res;
  };
  return {
    async request(method, path, body, accept = "application/vnd.github+json") {
      const res = await call(method, path, body, accept);
      if (res.status === 204) return null;
      const text = await res.text();
      return text === "" ? null : (JSON.parse(text) as unknown);
    },
    async text(path, accept = "application/vnd.github+json") {
      const res = await call("GET", path, undefined, accept);
      return res.text();
    },
    async graphql(query, variables) {
      const res = await call(
        "POST",
        "/graphql",
        { query, variables },
        "application/json"
      );
      const json = (await res.json()) as {
        data?: unknown;
        errors?: { message?: string }[];
      };
      if (json.errors && json.errors.length > 0) {
        throw new LaneToolError(
          `github graphql: ${json.errors.map((e) => e.message ?? "error").join("; ")}`
        );
      }
      return json.data ?? null;
    },
  };
}

// ---- Tool definitions ----------------------------------------------------

export interface LaneToolContext {
  gh: LaneGithub;
  owner: string;
  repo: string;
  /** The lane's own branch — pr:write tools only act on PRs headed here. */
  branch: string;
  report(input: {
    message?: string;
    result?: string;
    prUrl?: string;
  }): Promise<void>;
  policy: LaneToolPolicy;
}

interface LaneToolDef<S extends z.ZodObject> {
  name: string;
  description: string;
  permission: LaneToolPermission;
  inputSchema: S;
  run(ctx: LaneToolContext, input: z.infer<S>): Promise<unknown>;
}

export interface LaneTool {
  name: string;
  description: string;
  permission: LaneToolPermission;
  inputSchema: z.ZodObject;
  /** Parses `input` against inputSchema before running. */
  run(ctx: LaneToolContext, input: unknown): Promise<unknown>;
}

function defineTool<S extends z.ZodObject>(def: LaneToolDef<S>): LaneTool {
  return {
    name: def.name,
    description: def.description,
    permission: def.permission,
    inputSchema: def.inputSchema,
    run: async (ctx, input) => def.run(ctx, def.inputSchema.parse(input)),
  };
}

const prNumber = z.number().int().positive().describe("Pull request number");
const issueNumber = z.number().int().positive().describe("Issue number");

function repoPath(ctx: LaneToolContext, suffix = ""): string {
  return `/repos/${encodeURIComponent(ctx.owner)}/${encodeURIComponent(ctx.repo)}${suffix}`;
}

function truncateHead(text: string): string {
  return text.length > MAX_TEXT_CHARS
    ? `${text.slice(0, MAX_TEXT_CHARS)}\n…[truncated ${text.length - MAX_TEXT_CHARS} chars]`
    : text;
}

function truncateTail(text: string): string {
  return text.length > MAX_TEXT_CHARS
    ? `…[truncated ${text.length - MAX_TEXT_CHARS} chars]\n${text.slice(-MAX_TEXT_CHARS)}`
    : text;
}

interface GhPullHead {
  head?: { ref?: string; repo?: { full_name?: string } | null };
}

/** pr:write tools act only on the lane's own PR — head branch is the lane
 *  branch, in this repository (no fork heads). */
async function requireLanePull(
  ctx: LaneToolContext,
  number: number
): Promise<void> {
  const pull = (await ctx.gh.request(
    "GET",
    repoPath(ctx, `/pulls/${number}`)
  )) as GhPullHead;
  const fullName = `${ctx.owner}/${ctx.repo}`.toLowerCase();
  if (
    pull.head?.ref !== ctx.branch ||
    pull.head.repo?.full_name?.toLowerCase() !== fullName
  ) {
    throw new LaneToolError(
      `PR #${number} is not this lane's PR (head must be ${ctx.owner}:${ctx.branch})`
    );
  }
}

const REVIEW_THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      reviewThreads(first:100){
        nodes{ id isResolved isOutdated path line
          comments(first:20){ nodes{ databaseId author{login} body createdAt } } }
      }
    }
  }
}`;

const THREAD_REPO_QUERY = `query($id:ID!){
  node(id:$id){ ... on PullRequestReviewThread { pullRequest { headRefName repository { nameWithOwner } } } }
}`;

const RESOLVE_THREAD_MUTATION = `mutation($id:ID!){
  resolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } }
}`;

export const LANE_TOOLS: readonly LaneTool[] = [
  // ---- lane:report ----
  defineTool({
    name: "get_lane_context",
    description:
      "Describe this lane: repository, branch, permission tier, and the tools it may call.",
    permission: "lane:report",
    inputSchema: z.object({}),
    async run(ctx) {
      return {
        repository: `${ctx.owner}/${ctx.repo}`,
        branch: ctx.branch,
        tier: ctx.policy.tier,
        permissions: [...ctx.policy.permissions],
        tools: LANE_TOOLS.filter((t) => laneToolAllowed(ctx.policy, t)).map(
          (t) => t.name
        ),
      };
    },
  }),
  defineTool({
    name: "report_progress",
    description:
      "Post a progress line to the lane's event stream (also a liveness heartbeat).",
    permission: "lane:report",
    inputSchema: z.object({ message: z.string().min(1).max(2000) }),
    async run(ctx, input) {
      await ctx.report({ message: input.message });
      return { ok: true };
    },
  }),
  defineTool({
    name: "set_output",
    description:
      "Record the lane's result summary and/or PR URL on the session without ending it.",
    permission: "lane:report",
    inputSchema: z.object({
      result: z.string().max(20_000).optional(),
      prUrl: z.string().url().optional(),
    }),
    async run(ctx, input) {
      if (input.prUrl !== undefined) {
        const prefix = `https://github.com/${ctx.owner}/${ctx.repo}/pull/`;
        if (!input.prUrl.toLowerCase().startsWith(prefix.toLowerCase())) {
          throw new LaneToolError(`prUrl must be a PR in ${prefix}`);
        }
      }
      await ctx.report({ result: input.result, prUrl: input.prUrl });
      return { ok: true };
    },
  }),

  // ---- repo:read ----
  defineTool({
    name: "get_repository",
    description: "Repository metadata (default branch, visibility, topics).",
    permission: "repo:read",
    inputSchema: z.object({}),
    run: (ctx) => ctx.gh.request("GET", repoPath(ctx)),
  }),
  defineTool({
    name: "get_file_contents",
    description: "Read a file (UTF-8) or list a directory at an optional ref.",
    permission: "repo:read",
    inputSchema: z.object({
      path: z.string().min(1),
      ref: z.string().optional(),
    }),
    async run(ctx, input) {
      const qs = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : "";
      const path = input.path
        .replace(/^\/+/, "")
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      const raw = await ctx.gh.request(
        "GET",
        repoPath(ctx, `/contents/${path}${qs}`)
      );
      if (Array.isArray(raw)) {
        return raw.map((entry: { name?: string; type?: string }) => ({
          name: entry.name,
          type: entry.type,
        }));
      }
      const file = raw as { content?: string; encoding?: string; sha?: string };
      if (file.encoding !== "base64" || typeof file.content !== "string") {
        return raw;
      }
      const bytes = Uint8Array.from(
        atob(file.content.replaceAll("\n", "")),
        (c) => c.charCodeAt(0)
      );
      return {
        path: input.path,
        sha: file.sha,
        content: truncateHead(new TextDecoder().decode(bytes)),
      };
    },
  }),
  defineTool({
    name: "list_pull_requests",
    description: "List pull requests in the repository.",
    permission: "repo:read",
    inputSchema: z.object({
      state: z.enum(["open", "closed", "all"]).optional(),
      head: z.string().optional().describe("Branch name (same repo)"),
      base: z.string().optional(),
    }),
    run(ctx, input) {
      const qs = new URLSearchParams({ per_page: "50" });
      if (input.state) qs.set("state", input.state);
      if (input.head) qs.set("head", `${ctx.owner}:${input.head}`);
      if (input.base) qs.set("base", input.base);
      return ctx.gh.request("GET", repoPath(ctx, `/pulls?${qs}`));
    },
  }),
  defineTool({
    name: "get_pull_request",
    description: "Pull request details (state, head/base, mergeable).",
    permission: "repo:read",
    inputSchema: z.object({ number: prNumber }),
    run: (ctx, input) =>
      ctx.gh.request("GET", repoPath(ctx, `/pulls/${input.number}`)),
  }),
  defineTool({
    name: "get_pull_request_diff",
    description: "Unified diff of a pull request (truncated when large).",
    permission: "repo:read",
    inputSchema: z.object({ number: prNumber }),
    async run(ctx, input) {
      const diff = await ctx.gh.text(
        repoPath(ctx, `/pulls/${input.number}`),
        "application/vnd.github.diff"
      );
      return truncateHead(diff);
    },
  }),
  defineTool({
    name: "list_pull_request_files",
    description: "Files changed by a pull request.",
    permission: "repo:read",
    inputSchema: z.object({ number: prNumber }),
    run: (ctx, input) =>
      ctx.gh.request(
        "GET",
        repoPath(ctx, `/pulls/${input.number}/files?per_page=100`)
      ),
  }),
  defineTool({
    name: "list_pull_request_reviews",
    description: "Submitted reviews on a pull request.",
    permission: "repo:read",
    inputSchema: z.object({ number: prNumber }),
    run: (ctx, input) =>
      ctx.gh.request(
        "GET",
        repoPath(ctx, `/pulls/${input.number}/reviews?per_page=100`)
      ),
  }),
  defineTool({
    name: "list_review_comments",
    description: "Inline review comments on a pull request.",
    permission: "repo:read",
    inputSchema: z.object({ number: prNumber }),
    run: (ctx, input) =>
      ctx.gh.request(
        "GET",
        repoPath(ctx, `/pulls/${input.number}/comments?per_page=100`)
      ),
  }),
  defineTool({
    name: "list_review_threads",
    description:
      "Review threads on a pull request with resolution state and thread ids (for resolve_review_thread).",
    permission: "repo:read",
    inputSchema: z.object({ number: prNumber }),
    async run(ctx, input) {
      const data = (await ctx.gh.graphql(REVIEW_THREADS_QUERY, {
        owner: ctx.owner,
        name: ctx.repo,
        number: input.number,
      })) as {
        repository?: {
          pullRequest?: { reviewThreads?: { nodes?: unknown[] } } | null;
        } | null;
      } | null;
      return data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    },
  }),
  defineTool({
    name: "list_check_runs",
    description: "Check runs for a commit SHA or branch.",
    permission: "repo:read",
    inputSchema: z.object({ ref: z.string().min(1) }),
    run: (ctx, input) =>
      ctx.gh.request(
        "GET",
        repoPath(
          ctx,
          `/commits/${encodeURIComponent(input.ref)}/check-runs?per_page=100`
        )
      ),
  }),
  defineTool({
    name: "get_check_run_logs",
    description:
      "Log tail for a GitHub Actions check run (the check run id is the job id).",
    permission: "repo:read",
    inputSchema: z.object({ checkRunId: z.number().int().positive() }),
    async run(ctx, input) {
      const logs = await ctx.gh.text(
        repoPath(ctx, `/actions/jobs/${input.checkRunId}/logs`)
      );
      return truncateTail(logs);
    },
  }),
  defineTool({
    name: "get_issue",
    description: "A GitHub issue (or PR conversation) by number.",
    permission: "repo:read",
    inputSchema: z.object({ number: issueNumber }),
    run: (ctx, input) =>
      ctx.gh.request("GET", repoPath(ctx, `/issues/${input.number}`)),
  }),
  defineTool({
    name: "list_issue_comments",
    description: "Conversation comments on an issue or pull request.",
    permission: "repo:read",
    inputSchema: z.object({ number: issueNumber }),
    run: (ctx, input) =>
      ctx.gh.request(
        "GET",
        repoPath(ctx, `/issues/${input.number}/comments?per_page=100`)
      ),
  }),
  defineTool({
    name: "find_similar_issues",
    description:
      "Search this repository's issues and PRs by keywords (duplicate / prior-art check).",
    permission: "repo:read",
    inputSchema: z.object({
      query: z.string().min(1).max(256),
      state: z.enum(["open", "closed"]).optional(),
    }),
    async run(ctx, input) {
      const q = [
        `repo:${ctx.owner}/${ctx.repo}`,
        input.state ? `state:${input.state}` : "",
        input.query,
      ]
        .filter(Boolean)
        .join(" ");
      const res = (await ctx.gh.request(
        "GET",
        `/search/issues?per_page=20&q=${encodeURIComponent(q)}`
      )) as {
        items?: {
          number?: number;
          title?: string;
          state?: string;
          html_url?: string;
          pull_request?: unknown;
        }[];
      };
      return (res.items ?? []).map((item) => ({
        number: item.number,
        title: item.title,
        state: item.state,
        url: item.html_url,
        isPullRequest: item.pull_request !== undefined,
      }));
    },
  }),
  defineTool({
    name: "compare_commits",
    description: "Compare two refs (ahead/behind, commits, files).",
    permission: "repo:read",
    inputSchema: z.object({ base: z.string().min(1), head: z.string().min(1) }),
    run: (ctx, input) =>
      ctx.gh.request(
        "GET",
        repoPath(
          ctx,
          `/compare/${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}`
        )
      ),
  }),

  // ---- pr:write (lane's own PR only) ----
  defineTool({
    name: "create_pull_request",
    description:
      "Open a pull request from the lane branch. head is always the lane branch.",
    permission: "pr:write",
    inputSchema: z.object({
      title: z.string().min(1).max(256),
      body: z.string().max(65_000).optional(),
      base: z.string().optional().describe("Defaults to the default branch"),
      draft: z.boolean().optional(),
    }),
    async run(ctx, input) {
      let base = input.base;
      if (!base) {
        const repo = (await ctx.gh.request("GET", repoPath(ctx))) as {
          default_branch?: string;
        };
        base = repo.default_branch ?? "main";
      }
      const pull = (await ctx.gh.request("POST", repoPath(ctx, "/pulls"), {
        title: input.title,
        body: input.body ?? "",
        head: ctx.branch,
        base,
        draft: input.draft ?? false,
      })) as { number?: number; html_url?: string };
      if (pull.html_url) await ctx.report({ prUrl: pull.html_url });
      return { number: pull.number, url: pull.html_url };
    },
  }),
  defineTool({
    name: "update_pull_request",
    description: "Edit the lane's PR title/body/base or close/reopen it.",
    permission: "pr:write",
    inputSchema: z.object({
      number: prNumber,
      title: z.string().min(1).max(256).optional(),
      body: z.string().max(65_000).optional(),
      base: z.string().optional(),
      state: z.enum(["open", "closed"]).optional(),
    }),
    async run(ctx, input) {
      await requireLanePull(ctx, input.number);
      const { number, ...patch } = input;
      return ctx.gh.request("PATCH", repoPath(ctx, `/pulls/${number}`), patch);
    },
  }),
  defineTool({
    name: "comment_on_pull_request",
    description: "Post a conversation comment on the lane's PR.",
    permission: "pr:write",
    inputSchema: z.object({
      number: prNumber,
      body: z.string().min(1).max(65_000),
    }),
    async run(ctx, input) {
      await requireLanePull(ctx, input.number);
      return ctx.gh.request(
        "POST",
        repoPath(ctx, `/issues/${input.number}/comments`),
        { body: input.body }
      );
    },
  }),
  defineTool({
    name: "add_labels",
    description: "Add labels to the lane's PR.",
    permission: "pr:write",
    inputSchema: z.object({
      number: prNumber,
      labels: z.array(z.string().min(1)).min(1).max(20),
    }),
    async run(ctx, input) {
      await requireLanePull(ctx, input.number);
      return ctx.gh.request(
        "POST",
        repoPath(ctx, `/issues/${input.number}/labels`),
        { labels: input.labels }
      );
    },
  }),
  defineTool({
    name: "update_pull_request_branch",
    description:
      "Merge the base branch into the lane's PR branch (GitHub update-branch).",
    permission: "pr:write",
    inputSchema: z.object({ number: prNumber }),
    async run(ctx, input) {
      await requireLanePull(ctx, input.number);
      return ctx.gh.request(
        "PUT",
        repoPath(ctx, `/pulls/${input.number}/update-branch`),
        {}
      );
    },
  }),

  // ---- review:write ----
  defineTool({
    name: "create_pull_request_review",
    description:
      "Submit a review (COMMENT or REQUEST_CHANGES; APPROVE only on PRs that are not the lane's own) with optional inline comments.",
    permission: "review:write",
    inputSchema: z.object({
      number: prNumber,
      event: z.enum(["COMMENT", "REQUEST_CHANGES", "APPROVE"]),
      body: z.string().max(65_000).optional(),
      comments: z
        .array(
          z.object({
            path: z.string().min(1),
            line: z.number().int().positive(),
            side: z.enum(["LEFT", "RIGHT"]).optional(),
            body: z.string().min(1),
          })
        )
        .max(50)
        .optional(),
    }),
    async run(ctx, input) {
      if (input.event === "APPROVE") {
        const pull = (await ctx.gh.request(
          "GET",
          repoPath(ctx, `/pulls/${input.number}`)
        )) as GhPullHead;
        if (pull.head?.ref === ctx.branch) {
          throw new LaneToolError("A lane cannot approve its own PR");
        }
      }
      const { number, ...review } = input;
      return ctx.gh.request(
        "POST",
        repoPath(ctx, `/pulls/${number}/reviews`),
        review
      );
    },
  }),
  defineTool({
    name: "reply_to_review_comment",
    description: "Reply in the thread of an inline review comment.",
    permission: "review:write",
    inputSchema: z.object({
      number: prNumber,
      commentId: z.number().int().positive(),
      body: z.string().min(1).max(65_000),
    }),
    run: (ctx, input) =>
      ctx.gh.request(
        "POST",
        repoPath(
          ctx,
          `/pulls/${input.number}/comments/${input.commentId}/replies`
        ),
        { body: input.body }
      ),
  }),
  defineTool({
    name: "resolve_review_thread",
    description:
      "Resolve a review thread on the lane's PR (thread id from list_review_threads).",
    permission: "review:write",
    inputSchema: z.object({ threadId: z.string().min(1) }),
    async run(ctx, input) {
      const data = (await ctx.gh.graphql(THREAD_REPO_QUERY, {
        id: input.threadId,
      })) as {
        node?: {
          pullRequest?: {
            headRefName?: string;
            repository?: { nameWithOwner?: string };
          };
        } | null;
      } | null;
      const pr = data?.node?.pullRequest;
      if (
        pr?.repository?.nameWithOwner?.toLowerCase() !==
          `${ctx.owner}/${ctx.repo}`.toLowerCase() ||
        pr.headRefName !== ctx.branch
      ) {
        throw new LaneToolError("Review thread is not on this lane's PR");
      }
      return ctx.gh.graphql(RESOLVE_THREAD_MUTATION, { id: input.threadId });
    },
  }),

  // ---- checks:write ----
  defineTool({
    name: "rerun_failed_jobs",
    description: "Re-run the failed jobs of a GitHub Actions workflow run.",
    permission: "checks:write",
    inputSchema: z.object({ runId: z.number().int().positive() }),
    async run(ctx, input) {
      await ctx.gh.request(
        "POST",
        repoPath(ctx, `/actions/runs/${input.runId}/rerun-failed-jobs`)
      );
      return { ok: true };
    },
  }),
];

export function allowedLaneTools(policy: LaneToolPolicy): LaneTool[] {
  return LANE_TOOLS.filter((tool) => laneToolAllowed(policy, tool));
}
