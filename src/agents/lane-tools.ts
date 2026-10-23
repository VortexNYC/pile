import { z } from "zod";

import { GITHUB_USER_AGENT } from "../global/github-auth.js";
import { normalizeDomain } from "../workspace/data/index.js";
import {
  type AudienceCandidateMerchant,
  buildRepMorningBrief,
  queryDynamicAudience,
  runMerchantLeadPlay,
} from "../workspace/lead-play-engine.js";
import {
  applyInboundReplyOutcome,
  classifyInboundReply,
  createStatementReceivedChecklist,
} from "../workspace/reply-funnel-engine.js";
import {
  evaluateSendGate,
  type EmailVerificationStatus,
  type TouchChannel,
} from "../workspace/send-gate.js";
import {
  computeSmbMatchKey,
  DEFAULT_ICP_RULES,
  DEFAULT_SIGNAL_RULES,
  detectPosTechnographics,
  type MerchantSignal,
  parseCustomerSignalFacts,
  planDetectiveWaterfall,
  rankMerchantSignals,
} from "../workspace/signals-engine.js";
import {
  type MerchantSourceRow,
  type NonPosSmbPresetId,
  PRESET_NON_POS_SMB_SOURCES,
  pullSource,
  scoreCandidate,
} from "./collectors.js";
import { sessionPlanSchema, type SessionPlan } from "./session-plan.js";
import { runUsageSchema, type AgentRunUsage } from "./spend.js";

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
  "ws:read",
  "ws:write",
  "web:fetch",
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
  // Pipeline lanes (Scout & co.) — workspace records + outbound fetch, no
  // repo surface. The profile's tools allowlist narrows further via deny.
  pipeline: ["lane:report", "ws:read", "ws:write", "web:fetch"],
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
    plan?: SessionPlan;
  }): Promise<void>;
  policy: LaneToolPolicy;
  /** Names of the workspace-domain tools served alongside the repo tools —
   *  get_lane_context reports the whole callable set. */
  workspaceToolNames?: readonly string[];
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
        tools: [
          ...LANE_TOOLS.filter((t) => laneToolAllowed(ctx.policy, t)).map(
            (t) => t.name
          ),
          ...(ctx.workspaceToolNames ?? []),
        ],
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
  defineTool({
    name: "set_plan",
    description:
      "Publish the lane's plan checklist on the session (PILE-426). Ordered items, each {content, status: pending|inProgress|completed|canceled}; every call replaces the whole plan — resend all items, not just the changed ones.",
    permission: "lane:report",
    inputSchema: z.object({ plan: sessionPlanSchema }),
    async run(ctx, input) {
      await ctx.report({ plan: input.plan });
      return { ok: true, items: input.plan.length };
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

// ---- workspace-domain tools (pipeline lanes) -----------------------------

/** The slice of the workspace DO a pipeline lane needs — the concrete stub
 *  satisfies this structurally; kept narrow so tests can fake it. */
export interface LaneWorkspace {
  getIssue(id: string): Promise<
    | {
        id: string;
        identifier?: string | null;
        title?: string | null;
        status?: string | null;
        customerId?: string | null;
        description?: string | null;
      }
    | undefined
  >;
  createComment(values: {
    issueId: string;
    body: string;
    externalAuthor?: string;
    externalSource?: string;
  }): Promise<unknown>;
  updateIssue(
    id: string,
    patch: { status?: string },
    actorId?: string
  ): Promise<unknown>;
  createCustomer(input: {
    name: string;
    domain?: string | null;
    externalId?: string | null;
    phone?: string | null;
    address?: string | null;
    vertical?: string | null;
    neighborhood?: string | null;
    source?: string | null;
    sourceSessionId?: string | null;
    sourceAgentSlug?: string | null;
    createdById?: string;
    [key: string]: unknown;
  }): Promise<unknown>;
  upsertSuppression(input: {
    kind: string;
    value: string;
    customerId?: string | null;
    reason?: string | null;
    source?: string | null;
  }): Promise<unknown>;
  isSuppressed(kind: string, value: string): Promise<unknown>;
  createMarketRun(input: {
    vertical: string;
    geo: string;
    source: string;
    sourceQuery?: string | null;
    coverageTarget?: number | null;
    issueId?: string | null;
    createdBySlug?: string | null;
    sourceSessionId?: string | null;
  }): Promise<unknown>;
  updateMarketRun(
    id: string,
    patch: { producedCount?: number; status?: string }
  ): Promise<unknown>;
  listMarketRuns(args?: {
    vertical?: string;
    geo?: string;
    issueId?: string;
    limit?: number;
  }): Promise<unknown>;
  upsertContact(input: {
    customerId: string;
    type?: string;
    role?: string | null;
    channel: string;
    value: string;
    label?: string | null;
    status?: string;
    confidence?: string;
    source?: string | null;
    evidenceUri?: string | null;
  }): Promise<unknown>;
  listContacts(customerId: string): Promise<unknown>;
  upsertMerchantSource(input: {
    name: string;
    kind: string;
    config?: Record<string, unknown> | null;
    cursorField?: string | null;
    signal?: string;
    cadence?: string;
  }): Promise<unknown>;
  listMerchantSources(args?: {
    enabledOnly?: boolean;
    kind?: string;
  }): Promise<unknown>;
  updateMerchantSource(
    id: string,
    patch: {
      cursorValue?: string | null;
      lastRunAt?: string;
      runCount?: number;
      enabled?: number;
      config?: Record<string, unknown>;
    }
  ): Promise<unknown>;
  getCustomer(id: string): Promise<unknown>;
  getCustomerByDomain(domain: string): Promise<unknown>;
  getCustomerByExternalId(externalId: string): Promise<unknown>;
  updateCustomer(
    id: string,
    patch: {
      name?: string;
      domain?: string | null;
      url?: string | null;
      notes?: string | null;
      address?: string | null;
      phone?: string | null;
      vertical?: string | null;
      neighborhood?: string | null;
      source?: string | null;
      signal?: string | null;
      priorityScore?: number | null;
      fitScore?: number | null;
      fitStatus?: string | null;
      processor?: string | null;
      evidenceUri?: string | null;
      customFields?: Record<string, string | null>;
    },
    actorId?: string
  ): Promise<unknown>;
  listCustomers(): Promise<unknown[]>;
  getDocument(id: string): Promise<
    | {
        id: string;
        title?: string | null;
        slug?: string | null;
        content?: unknown;
        updatedAt?: string | null;
      }
    | undefined
  >;
  listDocuments(args?: {
    slug?: string;
    issueId?: string;
    isTemplate?: boolean;
  }): Promise<
    Array<{
      id: string;
      title?: string | null;
      slug?: string | null;
      content?: unknown;
      updatedAt?: string | null;
    }>
  >;
  createDocument(input: {
    title: string;
    slug?: string | null;
    content?: unknown;
    contentFormat?: "blocks" | "markdown" | "canvas";
    issueId?: string | null;
    createdById: string;
  }): Promise<{ id: string }>;
  updateDocument(
    id: string,
    patch: {
      title?: string;
      content?: unknown;
      contentFormat?: "blocks" | "markdown" | "canvas";
    },
    actorId: string
  ): Promise<unknown>;
  memoryRemember(input: {
    entityType: string;
    entityId: string;
    kind: string;
    fact: string;
    sourceSessionId?: string | null;
    sourceAgentSlug?: string | null;
    validUntil?: string | null;
  }): Promise<unknown>;
  memoryRecall(query: {
    entityType?: string;
    entityId?: string;
    kind?: string;
    search?: string;
    limit?: number;
  }): Promise<unknown[]>;
  recordSessionUsage(sessionId: string, usage: AgentRunUsage): Promise<unknown>;
}

export interface WorkspaceLaneToolContext {
  ws: LaneWorkspace;
  env?: Record<string, string | undefined>;
  organizationId: string;
  sessionId: string;
  /** The dispatch's issue — the merchant deal / pipeline step. */
  issueId: string;
  /** Attributed on comments the lane writes. */
  agentSlug: string;
  report(input: {
    message?: string;
    result?: string;
    plan?: SessionPlan;
  }): Promise<void>;
  /** Page the chief of staff (external owner) — wired at the serving
   *  boundary where env is available. */
  escalate?(input: { question: string; context?: string }): Promise<void>;
  policy: LaneToolPolicy;
}

interface WorkspaceToolDef<S extends z.ZodObject> {
  name: string;
  description: string;
  permission: LaneToolPermission;
  inputSchema: S;
  run(ctx: WorkspaceLaneToolContext, input: z.infer<S>): Promise<unknown>;
}

export interface WorkspaceLaneTool {
  name: string;
  description: string;
  permission: LaneToolPermission;
  inputSchema: z.ZodObject;
  run(ctx: WorkspaceLaneToolContext, input: unknown): Promise<unknown>;
}

function defineWorkspaceTool<S extends z.ZodObject>(
  def: WorkspaceToolDef<S>
): WorkspaceLaneTool {
  return {
    name: def.name,
    description: def.description,
    permission: def.permission,
    inputSchema: def.inputSchema,
    run: async (ctx, input) => def.run(ctx, def.inputSchema.parse(input)),
  };
}

/** "Empty" for fill-only writes — null/undefined or a whitespace-only
 *  string. 0 and false are real values a lane must not silently replace. */
function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  );
}

const BLOCKED_HOSTS =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|[[f]|[0:]+$)/i;

export const WORKSPACE_LANE_TOOLS: readonly WorkspaceLaneTool[] = [
  defineWorkspaceTool({
    name: "issue_get",
    description:
      "Read the pipeline issue this lane is working — title, status, customer link, description.",
    permission: "ws:read",
    inputSchema: z.object({}),
    async run(ctx) {
      const issue = await ctx.ws.getIssue(ctx.issueId);
      if (!issue) throw new LaneToolError("issue not found");
      return issue;
    },
  }),
  defineWorkspaceTool({
    name: "issue_comment",
    description:
      "Post a finding/progress comment on the pipeline issue — visible on the board.",
    permission: "ws:write",
    inputSchema: z.object({ body: z.string().min(1).max(10_000) }),
    async run(ctx, input) {
      await ctx.ws.createComment({
        issueId: ctx.issueId,
        body: input.body,
        externalAuthor: ctx.agentSlug,
        externalSource: "lane",
      });
      return { ok: true };
    },
  }),
  defineWorkspaceTool({
    name: "issue_set_status",
    description:
      "Move the pipeline issue's status (e.g. in_progress → done) when its work finishes.",
    permission: "ws:write",
    inputSchema: z.object({
      status: z
        .enum(["backlog", "todo", "in_progress", "done", "canceled"])
        .describe("Target status"),
    }),
    async run(ctx, input) {
      const updated = await ctx.ws.updateIssue(
        ctx.issueId,
        { status: input.status },
        ctx.agentSlug
      );
      if (!updated) throw new LaneToolError("issue not found");
      return { ok: true };
    },
  }),
  defineWorkspaceTool({
    name: "escalate",
    description:
      "Page the chief of staff — block on the director: you're stuck, need a decision, or hit something outside your scope. Writes a comment and fires the external dispatch.",
    permission: "ws:write",
    inputSchema: z.object({
      question: z.string().min(1).max(4_000),
      context: z.string().max(4_000).optional(),
    }),
    async run(ctx, input) {
      await ctx.ws.createComment({
        issueId: ctx.issueId,
        body: `@chief_of_staff escalation from ${ctx.agentSlug}: ${input.question}${input.context ? `\n\n${input.context}` : ""}`,
        externalAuthor: ctx.agentSlug,
        externalSource: "lane",
      });
      await ctx.escalate?.(input);
      return { ok: true };
    },
  }),
  defineWorkspaceTool({
    name: "document_get",
    description:
      "Read a workspace document by id or slug — playbooks, coverage ledgers, any durable knowledge the role relies on.",
    permission: "ws:read",
    inputSchema: z.object({
      id: z.string().optional(),
      slug: z.string().optional(),
    }),
    async run(ctx, input) {
      if (input.id) {
        const doc = await ctx.ws.getDocument(input.id);
        if (!doc) throw new LaneToolError("document not found");
        return doc;
      }
      if (input.slug) {
        const docs = await ctx.ws.listDocuments({ slug: input.slug });
        const doc = docs[0];
        if (!doc) throw new LaneToolError("document not found");
        return doc;
      }
      throw new LaneToolError("pass id or slug");
    },
  }),
  defineWorkspaceTool({
    name: "document_list",
    description:
      "List workspace documents — find playbooks, ledgers, and specs by title.",
    permission: "ws:read",
    inputSchema: z.object({}),
    async run(ctx) {
      const docs = await ctx.ws.listDocuments({});
      return docs.map((d) => ({
        id: d.id,
        title: d.title,
        slug: d.slug,
        updatedAt: d.updatedAt,
      }));
    },
  }),
  defineWorkspaceTool({
    name: "document_write",
    description:
      "Write a workspace document by slug — create it if missing, append the note to content if it exists (coverage ledgers, run logs, durable memory).",
    permission: "ws:write",
    inputSchema: z.object({
      slug: z.string().min(1),
      title: z.string().min(1),
      content: z.string().min(1),
      append: z.boolean().optional(),
    }),
    async run(ctx, input) {
      const docs = await ctx.ws.listDocuments({ slug: input.slug });
      const existing = docs[0];
      if (existing) {
        const body = input.append
          ? `${typeof existing.content === "string" ? existing.content : ""}\n\n${input.content}`
          : input.content;
        await ctx.ws.updateDocument(
          existing.id,
          {
            content: body,
            contentFormat: "markdown",
          },
          ctx.agentSlug
        );
        return { id: existing.id, updated: true };
      }
      const created = await ctx.ws.createDocument({
        title: input.title,
        slug: input.slug,
        content: input.content,
        contentFormat: "markdown",
        issueId: ctx.issueId,
        createdById: ctx.agentSlug,
      });
      return { id: created.id, created: true };
    },
  }),
  defineWorkspaceTool({
    name: "customer_lookup",
    description:
      "Find a merchant by id, domain, or externalId — pass exactly one key.",
    permission: "ws:read",
    inputSchema: z.object({
      id: z.string().optional(),
      domain: z.string().optional(),
      externalId: z.string().optional(),
    }),
    async run(ctx, input) {
      const keys = [input.id, input.domain, input.externalId].filter(Boolean);
      if (keys.length !== 1) {
        throw new LaneToolError("pass exactly one of id / domain / externalId");
      }
      const found = input.id
        ? await ctx.ws.getCustomer(input.id)
        : input.domain
          ? await ctx.ws.getCustomerByDomain(input.domain)
          : await ctx.ws.getCustomerByExternalId(input.externalId!);
      return found ?? { found: false };
    },
  }),
  defineWorkspaceTool({
    name: "customer_upsert",
    description:
      "Create a merchant record — or return the existing one if a customer with this domain/externalId already exists. A matched record is returned unchanged; use customer_update to write fields on it.",
    permission: "ws:write",
    inputSchema: z.object({
      name: z.string().min(1),
      domain: z.string().optional(),
      externalId: z.string().optional(),
      notes: z.string().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
      vertical: z.string().optional(),
      neighborhood: z.string().optional(),
      source: z.string().optional(),
    }),
    async run(ctx, input) {
      const existing = input.domain
        ? await ctx.ws.getCustomerByDomain(input.domain)
        : input.externalId
          ? await ctx.ws.getCustomerByExternalId(input.externalId)
          : undefined;
      if (existing) return { created: false, customer: existing };
      const customer = await ctx.ws.createCustomer({
        name: input.name,
        domain: input.domain ?? null,
        externalId: input.externalId ?? null,
        phone: input.phone ?? null,
        address: input.address ?? null,
        vertical: input.vertical ?? null,
        neighborhood: input.neighborhood ?? null,
        source: input.source ?? null,
        notes: input.notes ?? null,
        // Provenance as real columns — which agent/session sourced this
        // record so a bad batch is identifiable and purgeable.
        sourceSessionId: ctx.sessionId,
        sourceAgentSlug: ctx.agentSlug,
      });
      return { created: true, customer };
    },
  }),
  defineWorkspaceTool({
    name: "contact_upsert",
    description:
      "Attach a contact channel to a customer — an email, phone, form, or social profile. Dedups on (customer, channel, value); set role for named people (owner/founder/manager) and status/confidence for how verified it is.",
    permission: "ws:write",
    inputSchema: z.object({
      customerId: z.string().min(1),
      type: z.enum(["business_channel", "named_person"]).optional(),
      role: z.string().optional(),
      channel: z.enum(["email", "phone", "form", "social", "other"]),
      value: z.string().min(1),
      label: z.string().optional(),
      status: z
        .enum(["candidate", "verified", "rejected", "no_contact"])
        .optional(),
      confidence: z.enum(["low", "medium", "high"]).optional(),
      source: z.string().optional(),
      evidenceUri: z.string().optional(),
    }),
    async run(ctx, input) {
      const contact = await ctx.ws.upsertContact({
        ...input,
        source: input.source ?? `agent:${ctx.agentSlug}`,
      });
      return { contact };
    },
  }),
  defineWorkspaceTool({
    name: "suppress",
    description:
      "Add an identity to the do-not-contact list (email, domain, placeId, phone). Checked before any outreach.",
    permission: "ws:write",
    inputSchema: z.object({
      kind: z.enum(["email", "domain", "placeId", "phone", "customerId"]),
      value: z.string().min(1),
      customerId: z.string().optional(),
      reason: z.string().optional(),
    }),
    async run(ctx, input) {
      const row = await ctx.ws.upsertSuppression({
        ...input,
        source: `agent:${ctx.agentSlug}`,
      });
      return { suppressed: row };
    },
  }),
  defineWorkspaceTool({
    name: "suppression_check",
    description:
      "Check whether an identity is on the do-not-contact list before contacting or enriching.",
    permission: "ws:read",
    inputSchema: z.object({
      kind: z.enum(["email", "domain", "placeId", "phone", "customerId"]),
      value: z.string().min(1),
    }),
    async run(ctx, input) {
      const row = await ctx.ws.isSuppressed(input.kind, input.value);
      return { suppressed: row !== null && row !== undefined, entry: row };
    },
  }),
  defineWorkspaceTool({
    name: "market_run_report",
    description:
      "Record a sourcing run's outcome — register the run, then update producedCount/status. Coverage at the run level, queryable by vertical + geo.",
    permission: "ws:write",
    inputSchema: z.object({
      action: z.enum(["create", "update", "list"]),
      id: z.string().optional(),
      vertical: z.string().optional(),
      geo: z.string().optional(),
      source: z.string().optional(),
      sourceQuery: z.string().optional(),
      coverageTarget: z.number().optional(),
      producedCount: z.number().optional(),
      status: z.string().optional(),
      limit: z.number().optional(),
    }),
    async run(ctx, input) {
      if (input.action === "create") {
        if (!input.vertical || !input.geo || !input.source)
          throw new LaneToolError(
            "market_run_report create needs vertical, geo, source"
          );
        return {
          run: await ctx.ws.createMarketRun({
            vertical: input.vertical,
            geo: input.geo,
            source: input.source,
            sourceQuery: input.sourceQuery ?? null,
            coverageTarget: input.coverageTarget ?? null,
            issueId: ctx.issueId ?? null,
            createdBySlug: ctx.agentSlug,
            sourceSessionId: ctx.sessionId,
          }),
        };
      }
      if (input.action === "update") {
        if (!input.id)
          throw new LaneToolError("market_run_report update needs id");
        return {
          run: await ctx.ws.updateMarketRun(input.id, {
            producedCount: input.producedCount,
            status: input.status,
          }),
        };
      }
      return {
        runs: await ctx.ws.listMarketRuns({
          vertical: input.vertical,
          geo: input.geo,
          limit: input.limit,
        }),
      };
    },
  }),
  defineWorkspaceTool({
    name: "firecrawl",
    description:
      "Firecrawl — search the web with scraped results, scrape a page to markdown, or extract structured data from URLs. Best for directories, merchant sites, contact pages — pages web_fetch can't read (JS-rendered, blocked).",
    permission: "web:fetch",
    inputSchema: z.object({
      action: z.enum(["search", "scrape", "extract"]),
      query: z.string().optional().describe("for search"),
      url: z.string().url().optional().describe("for scrape"),
      urls: z.array(z.string().url()).optional().describe("for extract"),
      prompt: z.string().optional().describe("what to extract — for extract"),
      limit: z.number().optional(),
    }),
    async run(ctx, input) {
      const key = ctx.env?.FIRECRAWL_API_KEY;
      if (!key) throw new LaneToolError("FIRECRAWL_API_KEY not configured");
      const base = ctx.env?.FIRECRAWL_BASE_URL ?? "https://api.firecrawl.dev";
      const res = await fetch(`${base}/v1/${input.action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(
          input.action === "search"
            ? { query: input.query, limit: input.limit ?? 5 }
            : input.action === "scrape"
              ? { url: input.url, formats: ["markdown"] }
              : {
                  urls: input.urls,
                  prompt: input.prompt,
                  enableWebSearch: false,
                }
        ),
      });
      if (!res.ok)
        throw new LaneToolError(
          `firecrawl ${input.action} failed: ${res.status}`
        );
      return res.json();
    },
  }),
  defineWorkspaceTool({
    name: "stealth_fetch",
    description:
      "Scrapling stealth scrape — JS-rendered or bot-protected pages (SoS registries, license lookups) that web_fetch and firecrawl can't reach. Returns page text.",
    permission: "web:fetch",
    inputSchema: z.object({ url: z.string().url() }),
    async run(ctx, input) {
      const base = ctx.env?.SCRAPLING_BASE_URL;
      if (!base) throw new LaneToolError("SCRAPLING_BASE_URL not configured");
      const res = await fetch(`${base}/scrape`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ctx.env?.SCRAPLING_API_KEY ?? "",
        },
        body: JSON.stringify({ url: input.url, mode: "stealth" }),
      });
      if (!res.ok)
        throw new LaneToolError(`stealth_fetch failed: ${res.status}`);
      const text = await res.text();
      return { text: text.slice(0, 20000) };
    },
  }),
  defineWorkspaceTool({
    name: "browser_fetch",
    description:
      "Browserless headless browsing — two modes. url only: render the page and return content. script: run custom Puppeteer code against the page (multi-step navigation, form fills, pagination, click-throughs) — the script is the body of async ({ page, context }) => { ...return JSON data }, where context is { url }. Self-hosted Tinyfish equivalent.",
    permission: "web:fetch",
    inputSchema: z.object({
      url: z.string().url(),
      script: z
        .string()
        .optional()
        .describe(
          "Puppeteer code — the body of async ({ page, context }) => {...}; context = { url }. Return JSON-serializable data."
        ),
    }),
    async run(ctx, input) {
      const base = ctx.env?.BROWSERLESS_BASE_URL;
      const token = ctx.env?.BROWSERLESS_TOKEN;
      if (!base || !token)
        throw new LaneToolError("BROWSERLESS_* not configured");
      if (input.script) {
        const endpoint = new URL(`${base}/function`);
        endpoint.searchParams.set("token", token);
        const res = await fetch(endpoint.href, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code: `module.exports = async ({ page, context }) => { ${input.script} }`,
            context: { url: input.url },
          }),
        });
        if (!res.ok)
          throw new LaneToolError(
            `browser_fetch /function failed: ${res.status}`
          );
        const data: unknown = await res.json().catch(() => null);
        return { data };
      }
      const endpoint = new URL(`${base}/content`);
      endpoint.searchParams.set("token", token);
      const res = await fetch(endpoint.href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: input.url }),
      });
      if (!res.ok)
        throw new LaneToolError(`browser_fetch failed: ${res.status}`);
      const text = await res.text();
      return { text: text.slice(0, 20000) };
    },
  }),
  defineWorkspaceTool({
    name: "light_fetch",
    description:
      "Lightpanda — lightweight headless browser (~10x lighter than Chrome). Renders JS pages to DOM. Use for JS-rendered merchant pages before spending the heavy browserless tier.",
    permission: "web:fetch",
    inputSchema: z.object({ url: z.string().url() }),
    async run(ctx, input) {
      const base = ctx.env?.LIGHTPANDA_BASE_URL;
      if (!base) throw new LaneToolError("LIGHTPANDA_BASE_URL not configured");
      const res = await fetch(`${base}/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: input.url }),
      });
      if (!res.ok) throw new LaneToolError(`light_fetch failed: ${res.status}`);
      return res.json();
    },
  }),
  defineWorkspaceTool({
    name: "obscura_fetch",
    description:
      "Obscura — lightweight stealth browser (Rust+V8, spoofs full Windows Chrome fingerprint). JS-rendered pages that check for automation: webdriver=false, real plugins, Chrome UA. Cheaper than the patchright tier for most protected pages.",
    permission: "web:fetch",
    inputSchema: z.object({ url: z.string().url() }),
    async run(ctx, input) {
      const base = ctx.env?.OBSCURA_BASE_URL;
      if (!base) throw new LaneToolError("OBSCURA_BASE_URL not configured");
      const res = await fetch(`${base}/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: input.url }),
      });
      if (!res.ok)
        throw new LaneToolError(`obscura_fetch failed: ${res.status}`);
      return res.json();
    },
  }),
  defineWorkspaceTool({
    name: "browse",
    description:
      "Interactive browser session (obscura stealth engine). Drives pages: navigate, click, type, press, wait, extract, eval, screenshot. Use for forms, registries, pagination — anything needing a real browser session. Create a session first, chain ops, close when done.",
    permission: "web:fetch",
    inputSchema: z.object({
      op: z.enum([
        "create",
        "navigate",
        "click",
        "type",
        "press",
        "wait",
        "extract",
        "eval",
        "screenshot",
        "close",
      ]),
      sessionId: z.string().optional(),
      url: z.string().optional(),
      selector: z.string().optional(),
      text: z.string().optional(),
      key: z.string().optional(),
      keyCode: z.number().optional(),
      waitMs: z.number().optional(),
      ms: z.number().optional(),
      expression: z.string().optional(),
    }),
    async run(ctx, input) {
      const base = ctx.env?.BROWSE_BASE_URL;
      if (!base) throw new LaneToolError("BROWSE_BASE_URL not configured");
      if (input.op === "create") {
        const r = await fetch(`${base}/session`, { method: "POST" });
        if (!r.ok) throw new LaneToolError(`browse create failed: ${r.status}`);
        return r.json();
      }
      const sid = input.sessionId;
      if (!sid) throw new LaneToolError("sessionId required");
      if (input.op === "close") {
        const r = await fetch(`${base}/session/${sid}`, { method: "DELETE" });
        if (!r.ok) throw new LaneToolError(`browse close failed: ${r.status}`);
        return r.json();
      }
      const body: Record<string, unknown> = {};
      for (const k of [
        "url",
        "selector",
        "text",
        "key",
        "keyCode",
        "waitMs",
        "ms",
        "expression",
      ] as const)
        if (input[k] !== undefined) body[k] = input[k];
      const r = await fetch(`${base}/session/${sid}/${input.op}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok)
        throw new LaneToolError(`browse ${input.op} failed: ${r.status}`);
      return r.json();
    },
  }),
  defineWorkspaceTool({
    name: "socrata_query",
    description:
      "Socrata open-data query — NYC inspections, licenses, permits, business records. dataset_id + optional SoQL filters. E.g. 43nn-pn8j = NYC DOHMH restaurant inspections.",
    permission: "web:fetch",
    inputSchema: z.object({
      dataset: z.string().min(1),
      domain: z.string().optional().default("data.cityofnewyork.us"),
      where: z.string().optional(),
      select: z.string().optional(),
      limit: z.number().optional(),
    }),
    async run(ctx, input) {
      const params = new URLSearchParams();
      params.set("$limit", String(input.limit ?? 25));
      if (input.where) params.set("$where", input.where);
      if (input.select) params.set("$select", input.select);
      const appToken = ctx.env?.SOCRATA_APP_TOKEN;
      const headers: Record<string, string> = {};
      if (appToken) headers["X-App-Token"] = appToken;
      const res = await fetch(
        `https://${input.domain}/resource/${input.dataset}.json?${params}`,
        { headers }
      );
      if (!res.ok) throw new LaneToolError(`socrata failed: ${res.status}`);
      return { rows: await res.json() };
    },
  }),
  defineWorkspaceTool({
    name: "wayback",
    description:
      "Wayback Machine — site history: first/last snapshot, how long a merchant has been online, old prices/menus (migration + pain signals). Free, no key.",
    permission: "web:fetch",
    inputSchema: z.object({
      url: z.string().url(),
      mode: z
        .enum(["availability", "snapshots"])
        .optional()
        .default("availability"),
      limit: z.number().optional(),
    }),
    async run(ctx, input) {
      if (input.mode === "availability") {
        const res = await fetch(
          `https://archive.org/wayback/available?url=${encodeURIComponent(input.url)}`
        );
        if (!res.ok) throw new LaneToolError(`wayback failed: ${res.status}`);
        return res.json();
      }
      const res = await fetch(
        `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(input.url)}&output=json&limit=${input.limit ?? 10}&filter=statuscode:200&fl=timestamp,original,statuscode&collapse=timestamp:6`
      );
      if (!res.ok) throw new LaneToolError(`wayback failed: ${res.status}`);
      return { snapshots: await res.json() };
    },
  }),
  defineWorkspaceTool({
    name: "serper_search",
    description:
      "Serper — Google SERP results as JSON (~$1/1k). What a human searching sees: reviews sites, directories, 'who owns X' answers.",
    permission: "web:fetch",
    inputSchema: z.object({
      query: z.string().min(1),
      limit: z.number().optional(),
    }),
    async run(ctx, input) {
      const key = ctx.env?.SERPER_API_KEY;
      if (!key) throw new LaneToolError("SERPER_API_KEY not configured");
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: { "content-type": "application/json", "X-API-KEY": key },
        body: JSON.stringify({ q: input.query, num: input.limit ?? 10 }),
      });
      if (!res.ok) throw new LaneToolError(`serper failed: ${res.status}`);
      return res.json();
    },
  }),
  defineWorkspaceTool({
    name: "usaspending",
    description:
      "USAspending API — federal award data. Find SMBs winning government contracts: recipient names, amounts, agencies, NAICS codes, state. mode='recipients' lists top vendors in a NAICS/location; mode='awards' lists actual award records. Free, no key.",
    permission: "web:fetch",
    inputSchema: z.object({
      mode: z.enum(["recipients", "awards"]).default("recipients"),
      naics: z
        .array(z.string())
        .optional()
        .describe("NAICS codes to filter, e.g. ['541611','236220']"),
      state: z.string().optional().describe("2-letter state code"),
      keyword: z.string().optional(),
      limit: z.number().optional(),
    }),
    async run(ctx, input) {
      const body: Record<string, unknown> = {
        filters: {},
        limit: input.limit ?? 25,
      };
      const filters = body.filters as Record<string, unknown>;
      if (input.naics?.length) filters.naics_codes = { require: input.naics };
      if (input.state)
        filters.recipient_locations = [{ state: input.state, country: "USA" }];
      if (input.keyword) filters.recipient_search_text = [input.keyword];
      const url =
        input.mode === "recipients"
          ? "https://api.usaspending.gov/api/v2/recipient/"
          : "https://api.usaspending.gov/api/v2/search/spending_by_award/";
      if (input.mode === "awards")
        filters.award_type_codes = ["A", "B", "C", "D"];
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new LaneToolError(`usaspending failed: ${res.status}`);
      return res.json();
    },
  }),
  defineWorkspaceTool({
    name: "sam_entities",
    description:
      "SAM.gov Entity API — registered federal vendors: UEI, CAGE, legal name, certifications (8a, HUBZone, WOSB, SDVOSB), NAICS, address. The federal vendor registry. Needs SAM_API_KEY (free from sam.gov).",
    permission: "web:fetch",
    inputSchema: z.object({
      keyword: z.string().optional(),
      naics: z.string().optional(),
      state: z.string().optional(),
      purposeOfRegistrationCode: z
        .string()
        .optional()
        .describe("Z1=awards/grants"),
      limit: z.number().optional(),
    }),
    async run(ctx, input) {
      const key = ctx.env?.SAM_API_KEY;
      if (!key) throw new LaneToolError("SAM_API_KEY not configured");
      const params = new URLSearchParams({ api_key: key });
      if (input.keyword) params.set("legalBusinessName", input.keyword);
      if (input.naics) params.set("naicsCode", input.naics);
      if (input.state)
        params.set("physicalAddressStateOrProvinceCode", input.state);
      if (input.purposeOfRegistrationCode)
        params.set(
          "purposeOfRegistrationCode",
          input.purposeOfRegistrationCode
        );
      const res = await fetch(
        `https://api.sam.gov/entity-information/v3/entities?${params}`
      );
      if (!res.ok) throw new LaneToolError(`sam failed: ${res.status}`);
      return res.json();
    },
  }),
  defineWorkspaceTool({
    name: "source_add",
    description:
      "Register a merchant source — a feed that produces candidates on a schedule (Socrata datasets, usaspending, SAM, OpenCorporates). Add the feed once; collect_source pulls deltas later.",
    permission: "ws:write",
    inputSchema: z.object({
      name: z.string().min(1),
      kind: z.enum(["socrata", "usaspending", "sam", "opencorporates"]),
      config: z.record(z.string(), z.unknown()).optional(),
      cursorField: z.string().optional(),
      signal: z
        .enum([
          "license_pending",
          "corp_filing",
          "award",
          "violation",
          "contact_found",
          "registration",
        ])
        .optional(),
      cadence: z.enum(["daily", "weekly"]).optional(),
    }),
    async run(ctx, input) {
      return ctx.ws.upsertMerchantSource({
        name: input.name,
        kind: input.kind,
        config: input.config ?? {},
        cursorField: input.cursorField ?? null,
        signal: input.signal ?? "registration",
        cadence: input.cadence ?? "daily",
      });
    },
  }),
  defineWorkspaceTool({
    name: "source_list",
    description: "List registered merchant sources — the feed registry.",
    permission: "ws:read",
    inputSchema: z.object({
      enabledOnly: z.boolean().optional(),
      kind: z.string().optional(),
    }),
    async run(ctx, input) {
      return ctx.ws.listMerchantSources({
        enabledOnly: input.enabledOnly,
        kind: input.kind,
      });
    },
  }),
  defineWorkspaceTool({
    name: "source_collect",
    description:
      "Pull a merchant source — fetches new rows since its cursor, normalizes them into customer candidates, scores them, upserts into the CRM (deduped by external_id). The intake firehose: run per source or for all enabled feeds.",
    permission: "ws:write",
    inputSchema: z.object({
      sourceId: z.string().optional(),
      all: z.boolean().optional(),
      limit: z.number().optional(),
    }),
    async run(ctx, input) {
      const rows = (await ctx.ws.listMerchantSources({
        enabledOnly: true,
      })) as unknown as MerchantSourceRow[];
      const targets = input.sourceId
        ? rows.filter((r) => r.id === input.sourceId)
        : rows;
      if (!targets.length)
        return { collected: 0, note: "no enabled sources matched" };
      const run = (await ctx.ws.createMarketRun({
        vertical: "merchant-sources",
        geo: "multi",
        source: "collect",
        sourceQuery: input.sourceId ?? "all",
        createdBySlug: ctx.agentSlug,
        sourceSessionId: ctx.sessionId,
      })) as { id?: string };
      const runId = run?.id ?? null;
      let produced = 0;
      const perSource: { name: string; candidates: number }[] = [];
      for (const source of targets.slice(0, input.limit ?? 25)) {
        try {
          const { candidates, newCursor } = await pullSource(source, ctx.env);
          for (const c of candidates) {
            await ctx.ws.createCustomer({
              name: c.name,
              externalId: c.externalId,
              domain: c.domain,
              address: c.address,
              vertical: c.vertical,
              source: `source:${source.name}`,
              sourceAgentSlug: ctx.agentSlug,
              sourceSessionId: ctx.sessionId,
              signal: c.signal,
              signalDate: c.signalDate,
              evidenceUri: c.evidenceUri,
              priorityScore: scoreCandidate(c),
            });
            produced++;
          }
          await ctx.ws.updateMerchantSource(source.id, {
            cursorValue: newCursor ?? source.cursorValue,
            lastRunAt: new Date().toISOString(),
            runCount: (candidates.length > 0 ? 1 : 0) + produced,
          });
          perSource.push({ name: source.name, candidates: candidates.length });
        } catch {
          perSource.push({ name: source.name, candidates: -1 });
        }
      }
      if (runId)
        await ctx.ws.updateMarketRun(runId, {
          producedCount: produced,
          status: "completed",
        });
      return { collected: produced, sources: perSource, runId };
    },
  }),
  defineWorkspaceTool({
    name: "deepseek_search",
    description:
      "DeepSeek web search — cheap merchant discovery (~$0.75/1k). Returns ranked results with snippets for a query.",
    permission: "web:fetch",
    inputSchema: z.object({
      query: z.string().min(1),
      limit: z.number().optional(),
    }),
    async run(ctx, input) {
      const key = ctx.env?.DEEPSEEK_API_KEY;
      if (!key) throw new LaneToolError("DEEPSEEK_API_KEY not configured");
      const res = await fetch("https://api.deepseek.com/v1/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          query: input.query,
          limit: input.limit ?? 10,
        }),
      });
      if (!res.ok) throw new LaneToolError(`deepseek failed: ${res.status}`);
      return res.json();
    },
  }),
  defineWorkspaceTool({
    name: "opencorporates",
    description:
      "OpenCorporates business registry — officer names, entity status, filings for a company name + jurisdiction. Free tier.",
    permission: "web:fetch",
    inputSchema: z.object({
      query: z.string().min(1),
      jurisdiction: z.string().optional(),
      limit: z.number().optional(),
    }),
    async run(ctx, input) {
      const params = new URLSearchParams({
        q: input.query,
        format: "json",
        per_page: String(input.limit ?? 20),
        order: "score",
      });
      if (input.jurisdiction)
        params.set("jurisdiction_code", input.jurisdiction);
      if (ctx.env?.OPENCORPORATES_API_KEY)
        params.set("api_token", ctx.env.OPENCORPORATES_API_KEY);
      const res = await fetch(
        `https://api.opencorporates.com/v0.4/companies/search?${params}`
      );
      if (!res.ok)
        throw new LaneToolError(`opencorporates failed: ${res.status}`);
      return res.json();
    },
  }),
  defineWorkspaceTool({
    name: "tech_fingerprint",
    description:
      "Technology fingerprint — detect a merchant site's POS/ecommerce/CMS stack (Toast, Square, Shopify, Stripe…) via the self-hosted signature service. The ICP-gate call.",
    permission: "web:fetch",
    inputSchema: z.object({
      url: z.string().url(),
    }),
    async run(ctx, input) {
      const base = ctx.env?.WAPPALYZER_BASE_URL;
      if (!base) throw new LaneToolError("WAPPALYZER_BASE_URL not configured");
      const res = await fetch(`${base}/fingerprint`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: input.url }),
      });
      if (!res.ok) throw new LaneToolError(`fingerprint failed: ${res.status}`);
      return res.json();
    },
  }),
  defineWorkspaceTool({
    name: "customer_update",
    description:
      "Update an existing merchant — look it up by id or externalId (pass exactly one). Only the fields you pass are touched, and by default they fill empty slots only: a field that already has a value is left alone and reported in `skipped` (pass overwrite: true to replace it anyway). Every applied change lands in the record's audit history.",
    permission: "ws:write",
    inputSchema: z.object({
      id: z.string().optional(),
      externalId: z.string().optional(),
      name: z.string().min(1).optional(),
      domain: z
        .string()
        .optional()
        .describe(
          "Merchant host — stored normalized (scheme/www./path stripped)"
        ),
      url: z.string().optional(),
      notes: z.string().optional(),
      priorityScore: z.number().optional(),
      // Name-keyed values, same contract as the REST/import surface — a
      // missing definition is auto-created as a text field, null clears.
      customFields: z.record(z.string(), z.string().nullable()).optional(),
      overwrite: z
        .boolean()
        .optional()
        .describe("Replace non-empty values instead of skipping them"),
    }),
    async run(ctx, input) {
      const keys = [input.id, input.externalId].filter(Boolean);
      if (keys.length !== 1) {
        throw new LaneToolError("pass exactly one of id / externalId");
      }
      const found = input.id
        ? await ctx.ws.getCustomer(input.id)
        : await ctx.ws.getCustomerByExternalId(input.externalId!);
      if (!found || typeof found !== "object") {
        throw new LaneToolError("customer not found");
      }
      const customer = found as {
        id: string;
        customFields?: Record<string, string>;
        [key: string]: unknown;
      };
      const overwrite = input.overwrite === true;
      type CustomerPatch = Parameters<LaneWorkspace["updateCustomer"]>[1];
      const patch: CustomerPatch = {};
      const applied: string[] = [];
      const alreadySet: string[] = [];
      const skipped: string[] = [];
      // Domain compares in canonical form — the store keeps normalized
      // hosts, so a differently-spelled input reports alreadySet rather
      // than recording a no-op write.
      if (input.domain !== undefined) {
        const domain = normalizeDomain(input.domain);
        if (customer.domain === domain) {
          alreadySet.push("domain");
        } else if (!overwrite && !isEmptyValue(customer.domain)) {
          skipped.push("domain");
        } else {
          patch.domain = domain;
          applied.push("domain");
        }
      }
      const scalars = [
        ["name", input.name],
        ["url", input.url],
        ["notes", input.notes],
      ] as const;
      for (const [field, value] of scalars) {
        if (value === undefined) continue;
        const existing = customer[field];
        if (existing === value) {
          alreadySet.push(field);
        } else if (!overwrite && !isEmptyValue(existing)) {
          skipped.push(field);
        } else {
          patch[field] = value;
          applied.push(field);
        }
      }
      if (input.priorityScore !== undefined) {
        if (customer.priorityScore === input.priorityScore) {
          alreadySet.push("priorityScore");
        } else if (!overwrite && !isEmptyValue(customer.priorityScore)) {
          skipped.push("priorityScore");
        } else {
          patch.priorityScore = input.priorityScore;
          applied.push("priorityScore");
        }
      }
      const fieldPatch: Record<string, string | null> = {};
      const existingFields = customer.customFields ?? {};
      for (const [key, value] of Object.entries(input.customFields ?? {})) {
        const existing = existingFields[key];
        if (existing === value || (value === null && isEmptyValue(existing))) {
          alreadySet.push(`customFields.${key}`);
        } else if (!overwrite && !isEmptyValue(existing)) {
          skipped.push(`customFields.${key}`);
        } else {
          fieldPatch[key] = value;
          applied.push(`customFields.${key}`);
        }
      }
      if (Object.keys(fieldPatch).length > 0) patch.customFields = fieldPatch;
      if (applied.length === 0) {
        return { updated: false, customer, applied, alreadySet, skipped };
      }
      const updated = await ctx.ws.updateCustomer(
        customer.id,
        patch,
        ctx.agentSlug
      );
      if (!updated) throw new LaneToolError("customer not found");
      return { updated: true, customer: updated, applied, alreadySet, skipped };
    },
  }),
  defineWorkspaceTool({
    name: "web_fetch",
    description:
      "Fetch a public URL (NYC Open Data, a state business registry, a merchant site). GET only, https only, text response capped.",
    permission: "web:fetch",
    inputSchema: z.object({
      url: z.string().url().describe("https URL to GET"),
    }),
    async run(_ctx, input) {
      const url = new URL(input.url);
      if (url.protocol !== "https:" || BLOCKED_HOSTS.test(url.hostname)) {
        throw new LaneToolError("https public hosts only");
      }
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) {
        throw new LaneToolError(`fetch ${url.hostname}: ${res.status}`);
      }
      const text = await res.text();
      return truncateHead(text);
    },
  }),
  defineWorkspaceTool({
    name: "memory_remember",
    description:
      "Write a fact to workspace memory — coverage sweeps, lessons, entity notes. New facts of the same kind on an entity supersede the old (no dupes, audit trail kept).",
    permission: "ws:write",
    inputSchema: z.object({
      entityType: z.string().min(1),
      entityId: z.string().min(1),
      kind: z.string().min(1),
      fact: z.string().min(1),
      validUntil: z.string().optional(),
    }),
    async run(ctx, input) {
      await ctx.ws.memoryRemember({
        entityType: input.entityType,
        entityId: input.entityId,
        kind: input.kind,
        fact: input.fact,
        validUntil: input.validUntil ?? null,
        sourceSessionId: ctx.sessionId,
        sourceAgentSlug: ctx.agentSlug,
      });
      return { ok: true };
    },
  }),
  defineWorkspaceTool({
    name: "memory_recall",
    description:
      "Read workspace memory — what we already know about an entity/corridor/merchant/agent before starting work.",
    permission: "ws:read",
    inputSchema: z.object({
      entityType: z.string().optional(),
      entityId: z.string().optional(),
      kind: z.string().optional(),
      search: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    async run(ctx, input) {
      return ctx.ws.memoryRecall(input);
    },
  }),
  defineWorkspaceTool({
    name: "report_usage",
    description:
      "Record this run's cumulative token/cost usage on the session's run receipt — call once at run end (values are run totals, not deltas). Fields: model, inputTokens, outputTokens, totalTokens, toolCalls, costMicros (USD micros), externalSpendMicros.",
    permission: "lane:report",
    inputSchema: runUsageSchema,
    async run(ctx, input) {
      await ctx.ws.recordSessionUsage(ctx.sessionId, input);
      return { ok: true };
    },
  }),
  defineWorkspaceTool({
    name: "customer_signal_record",
    description:
      "Record a cited merchant signal (new_license, ownership_change, new_location, pos_detected, pricing_view, negative_closure, etc. — or pass html to fingerprint Toast/Square/Clover/SpotOn/Stripe technographics) and recompute the merchant's Ranker v2 priorityScore, fitScore, Why Now, and Detective waterfall.",
    permission: "ws:write",
    inputSchema: z.object({
      customerId: z.string().min(1),
      type: z.string().min(1).optional(),
      source: z.string().min(1).default("agent"),
      evidenceUrl: z.string().url(),
      strength: z.number().min(0).max(100).default(80),
      summary: z.string().optional(),
      observedAt: z.string().optional(),
      html: z.string().optional(),
    }),
    async run(ctx, input) {
      const customer = (await ctx.ws.getCustomer(input.customerId)) as
        | {
            id: string;
            domain?: string | null;
            vertical?: string | null;
            address?: string | null;
            phone?: string | null;
            customFields?: Record<string, string | null> | string | null;
          }
        | null
        | undefined;
      if (!customer) throw new LaneToolError("customer not found");
      const evaluationNowIso = new Date().toISOString();
      const observedAt = input.observedAt ?? evaluationNowIso;
      let signal: MerchantSignal;
      let posGuess: string | null = null;
      if (input.html) {
        const det = detectPosTechnographics({
          merchantId: customer.id,
          pageUrl: input.evidenceUrl,
          html: input.html,
          observedAt,
        });
        posGuess = det.posGuess;
        signal = det.signal ?? {
          id: `sig_${crypto.randomUUID().slice(0, 12)}`,
          merchantId: customer.id,
          type: input.type ?? "pos_detected",
          observedAt,
          source: input.source,
          evidenceUrl: input.evidenceUrl,
          strength: input.strength,
          summary: input.summary ?? null,
        };
      } else {
        signal = {
          id: `sig_${crypto.randomUUID().slice(0, 12)}`,
          merchantId: customer.id,
          type: input.type ?? "new_license",
          observedAt,
          source: input.source,
          evidenceUrl: input.evidenceUrl,
          strength: input.strength,
          summary: input.summary ?? null,
        };
      }
      await ctx.ws.memoryRemember({
        entityType: "customer",
        entityId: customer.id,
        kind: `signal:${signal.type}:${signal.id}`,
        fact: JSON.stringify(signal),
        sourceSessionId: ctx.sessionId,
        sourceAgentSlug: ctx.agentSlug,
      });
      const recalled = (await ctx.ws.memoryRecall({
        entityType: "customer",
        entityId: customer.id,
        limit: 100,
      })) as Array<{ kind: string; fact: string }>;
      const allSignals = parseCustomerSignalFacts(recalled);
      const signalsForRank = allSignals.length > 0 ? allSignals : [signal];
      const breakdown = rankMerchantSignals({
        merchantId: customer.id,
        merchantAttrs: {
          vertical: (customer.vertical ?? "").toLowerCase(),
          hasAddress: Boolean(customer.address),
          hasPhone: Boolean(customer.phone),
        },
        signals: signalsForRank,
        config: {
          motion: "smb_default",
          icpRules: DEFAULT_ICP_RULES,
          signalRules: DEFAULT_SIGNAL_RULES,
        },
        nowIso: evaluationNowIso,
      });
      const customFields: Record<string, string | null> =
        typeof customer.customFields === "string"
          ? (JSON.parse(customer.customFields) as Record<string, string | null>)
          : { ...(customer.customFields ?? {}) };
      customFields.whyNow = breakdown.whyNow;
      customFields.whyNowSignalIds = breakdown.whyNowSignalIds.join(",");
      await ctx.ws.updateCustomer(customer.id, {
        priorityScore: breakdown.priorityScore,
        fitScore: breakdown.fitScore,
        fitStatus: breakdown.fitRating,
        ...(posGuess ? { processor: posGuess } : {}),
        evidenceUri: signal.evidenceUrl,
        customFields,
      });
      return {
        signal,
        breakdown,
        waterfall: planDetectiveWaterfall({
          rankScore: breakdown.priorityScore,
          paidRankThreshold: 75,
          monthlyBudgetRemainingCents: 10_000,
          estimatedPaidLookupCents: 50,
        }),
      };
    },
  }),
  defineWorkspaceTool({
    name: "customer_signals_list",
    description:
      "List all persisted signals on a merchant along with its Ranker v2 breakdown (priorityScore, fitScore, timingScore, Why Now) and Detective waterfall.",
    permission: "ws:read",
    inputSchema: z.object({
      customerId: z.string().min(1),
    }),
    async run(ctx, input) {
      const customer = (await ctx.ws.getCustomer(input.customerId)) as
        | {
            id: string;
            vertical?: string | null;
            address?: string | null;
            phone?: string | null;
          }
        | null
        | undefined;
      if (!customer) throw new LaneToolError("customer not found");
      const recalled = (await ctx.ws.memoryRecall({
        entityType: "customer",
        entityId: customer.id,
        limit: 100,
      })) as Array<{ kind: string; fact: string }>;
      const signals = parseCustomerSignalFacts(recalled);
      const breakdown = rankMerchantSignals({
        merchantId: customer.id,
        merchantAttrs: {
          vertical: (customer.vertical ?? "").toLowerCase(),
          hasAddress: Boolean(customer.address),
          hasPhone: Boolean(customer.phone),
        },
        signals,
        config: {
          motion: "smb_default",
          icpRules: DEFAULT_ICP_RULES,
          signalRules: DEFAULT_SIGNAL_RULES,
        },
      });
      return {
        customerId: customer.id,
        signals,
        breakdown,
        waterfall: planDetectiveWaterfall({
          rankScore: breakdown.priorityScore,
          paidRankThreshold: 75,
          monthlyBudgetRemainingCents: 10_000,
          estimatedPaidLookupCents: 50,
        }),
      };
    },
  }),
  defineWorkspaceTool({
    name: "customer_send_gate",
    description:
      "Run the deterministic Unify-parity Send Gate (U-001..U-009) before drafting, claiming, or contacting a merchant — checks DNC/suppression, Reacher email status, EU consent, and records a GateDecision (pass/warn/block + typed reasons).",
    permission: "ws:read",
    inputSchema: z.object({
      customerId: z.string().min(1),
      touchId: z.string().default("touch-preview"),
      channel: z.enum(["email", "call", "visit", "linkedin"]),
      action: z.enum(["engage", "claim"]).default("engage"),
      contactId: z.string().default("default-contact"),
      contactEmail: z.string().optional(),
      emailStatus: z
        .enum(["valid", "invalid", "catch_all", "role", "unknown"])
        .optional(),
      emailVerifiedAt: z.string().optional(),
      doNotContact: z.boolean().optional(),
      doNotEmail: z.boolean().optional(),
      doNotCall: z.boolean().optional(),
      euResident: z.boolean().optional(),
      hasExplicitConsent: z.boolean().optional(),
      allowCatchAll: z.boolean().optional(),
      allowRole: z.boolean().optional(),
      allowUnverified: z.boolean().optional(),
    }),
    async run(ctx, input) {
      const customer = (await ctx.ws.getCustomer(input.customerId)) as
        | {
            id: string;
            domain?: string | null;
          }
        | null
        | undefined;
      if (!customer) throw new LaneToolError("customer not found");
      const suppCust = await ctx.ws.isSuppressed("customerId", customer.id);
      const suppDomain = customer.domain
        ? await ctx.ws.isSuppressed("domain", customer.domain)
        : null;
      const suppEmail = input.contactEmail
        ? await ctx.ws.isSuppressed("email", input.contactEmail)
        : null;
      const decision = evaluateSendGate({
        touchId: input.touchId || `lane_${ctx.sessionId}`,
        channel: input.channel as TouchChannel,
        action: input.action,
        merchant: {
          id: customer.id,
          domain: customer.domain,
          permissions: {
            doNotContact:
              Boolean(input.doNotContact) ||
              Boolean(suppCust) ||
              Boolean(suppDomain),
          },
        },
        contact: {
          id: input.contactId,
          email: input.contactEmail ?? null,
          permissions: {
            doNotEmail: Boolean(input.doNotEmail) || Boolean(suppEmail),
            doNotCall: Boolean(input.doNotCall),
            euResident: Boolean(input.euResident),
            hasExplicitConsent: Boolean(input.hasExplicitConsent),
            emailStatus: (input.emailStatus ??
              "valid") as EmailVerificationStatus,
            emailVerifiedAt: input.emailVerifiedAt ?? null,
          },
        },
        cadence: {
          allowCatchAll: input.allowCatchAll,
          allowRole: input.allowRole,
          allowUnverified: input.allowUnverified ?? true,
        },
      });
      await ctx.ws.memoryRemember({
        entityType: "customer",
        entityId: customer.id,
        kind: `gate_decision:${decision.touchId}`,
        fact: JSON.stringify(decision),
        sourceSessionId: ctx.sessionId,
        sourceAgentSlug: ctx.agentSlug,
      });
      return decision;
    },
  }),
  defineWorkspaceTool({
    name: "customer_dedup_key",
    description:
      "Compute the normalized SMB match key (DBA name + street address + E.164 phone + optional domain) and resolve any matching existing customer in the workspace.",
    permission: "ws:read",
    inputSchema: z.object({
      name: z.string().min(1),
      address: z.string().optional(),
      phone: z.string().optional(),
      domain: z.string().optional(),
    }),
    async run(ctx, input) {
      const key = computeSmbMatchKey(input);
      const allCustomers = ((await ctx.ws.listCustomers?.()) ?? []) as Array<{
        id: string;
        name: string;
        address?: string | null;
        phone?: string | null;
        domain?: string | null;
      }>;
      const matched = allCustomers.find((row) => {
        const rowKey = computeSmbMatchKey({
          name: row.name,
          address: row.address,
          phone: row.phone,
          domain: row.domain,
        });
        return (
          rowKey.matchKey === key.matchKey ||
          (Boolean(key.normalizedDomain) &&
            rowKey.normalizedDomain === key.normalizedDomain)
        );
      });
      return {
        ...key,
        matchedCustomerId: matched?.id ?? null,
      };
    },
  }),
  defineWorkspaceTool({
    name: "customer_reply_ingest",
    description:
      "Classify an inbound merchant reply into the 16 Unify categories (U-022..U-028), auto-suppress opt-outs and hard bounces, and optionally create a Statement-Received Checklist.",
    permission: "ws:write",
    inputSchema: z.object({
      customerId: z.string().min(1),
      subject: z.string().default(""),
      body: z.string().min(1),
      fromEmail: z.string().optional(),
      statementFileId: z.string().optional(),
    }),
    async run(ctx, input) {
      const customer = (await ctx.ws.getCustomer(input.customerId)) as
        | { id: string }
        | null
        | undefined;
      if (!customer) throw new LaneToolError("customer not found");
      const classified = classifyInboundReply(input.subject, input.body);
      let suppressed = false;
      if (classified.category === "opt_out") {
        suppressed = true;
        await ctx.ws.upsertSuppression({
          kind: "customerId",
          value: customer.id,
          customerId: customer.id,
          reason: "reply:opt_out",
          source: `agent:${ctx.agentSlug}`,
        });
        if (input.fromEmail) {
          await ctx.ws.upsertSuppression({
            kind: "email",
            value: input.fromEmail,
            customerId: customer.id,
            reason: "reply:opt_out",
            source: `agent:${ctx.agentSlug}`,
          });
        }
      } else if (classified.category === "hard_bounce" && input.fromEmail) {
        suppressed = true;
        await ctx.ws.upsertSuppression({
          kind: "email",
          value: input.fromEmail,
          customerId: customer.id,
          reason: "reply:hard_bounce",
          source: `agent:${ctx.agentSlug}`,
        });
      }
      const outcome = applyInboundReplyOutcome({
        enrollment: {
          id: `enr_${customer.id}`,
          merchantId: customer.id,
          contactId: input.fromEmail ?? "default-contact",
          cadenceId: "default",
          cadenceVersion: 1,
          mailboxId: "default",
          status: "active",
          enrolledBy: ctx.agentSlug,
          touches: [],
        },
        contactPermissions: { emailStatus: "valid" },
        classified,
        existingTasks: [],
      });
      const statementChecklist = input.statementFileId
        ? createStatementReceivedChecklist({
            merchantId: customer.id,
            statementFileId: input.statementFileId,
          })
        : null;
      await ctx.ws.memoryRemember({
        entityType: "customer",
        entityId: customer.id,
        kind: `reply:${Date.now()}`,
        fact: JSON.stringify({
          classified,
          fromEmail: input.fromEmail ?? null,
          suppressed,
          enrollmentStatus: outcome.enrollment.status,
          pausedUntil: outcome.enrollment.pausedUntil ?? null,
          tasks: outcome.tasks,
          statementChecklist,
        }),
        sourceSessionId: ctx.sessionId,
        sourceAgentSlug: ctx.agentSlug,
      });
      return {
        classified,
        suppressed,
        enrollment: outcome.enrollment,
        tasks: outcome.tasks,
        statementChecklist,
      };
    },
  }),

  defineWorkspaceTool({
    name: "customer_audience_query",
    description:
      "Query a dynamic audience of customers using AND/OR filter predicates over vertical, neighborhood, priorityScore, fitStatus, processor, and signalTypes.",
    permission: "ws:read",
    inputSchema: z.object({
      logic: z.enum(["and", "or"]).default("and"),
      predicates: z
        .array(
          z.object({
            field: z.string().min(1),
            op: z.enum([
              "eq",
              "neq",
              "in",
              "gte",
              "lte",
              "contains",
              "has_signal",
            ]),
            value: z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.array(z.union([z.string(), z.number()])),
            ]),
          })
        )
        .default([]),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async run(ctx, input) {
      const all = (await ctx.ws.listCustomers()) as Array<{
        id: string;
        name: string;
        domain?: string | null;
        vertical?: string | null;
        neighborhood?: string | null;
        address?: string | null;
        phone?: string | null;
        processor?: string | null;
        ownerId?: string | null;
        priorityScore?: number | null;
        fitScore?: number | null;
        fitStatus?: string | null;
      }>;
      const candidates: AudienceCandidateMerchant[] = await Promise.all(
        all.map(async (cust) => {
          const suppCust = await ctx.ws.isSuppressed("customerId", cust.id);
          const suppDomain = cust.domain
            ? await ctx.ws.isSuppressed("domain", cust.domain)
            : null;
          const suppressed = Boolean(suppCust) || Boolean(suppDomain);
          const facts = (await ctx.ws.memoryRecall({
            entityType: "customer",
            entityId: cust.id,
            limit: 50,
          })) as ReadonlyArray<{ kind: string; fact: string }>;
          const signals = parseCustomerSignalFacts(facts);
          return {
            id: cust.id,
            name: cust.name,
            domain: cust.domain,
            vertical: cust.vertical,
            neighborhood: cust.neighborhood,
            address: cust.address,
            phone: cust.phone,
            processor: cust.processor,
            ownerId: cust.ownerId,
            priorityScore: cust.priorityScore,
            fitScore: cust.fitScore,
            fitStatus: cust.fitStatus,
            suppressed,
            signalTypes: [...new Set(signals.map((s) => s.type))],
          };
        })
      );
      const matched = queryDynamicAudience(
        candidates,
        { logic: input.logic, predicates: input.predicates },
        input.limit ?? 50
      );
      return { totalMatched: matched.length, merchants: matched };
    },
  }),

  defineWorkspaceTool({
    name: "customer_run_play",
    description:
      "Execute the autonomous lead play (Profiler -> Detective waterfall -> SendGate -> Drafter awaiting_approval) on a customer.",
    permission: "ws:write",
    inputSchema: z.object({
      customerId: z.string().min(1),
      playName: z.string().optional(),
      html: z.string().optional(),
      pageUrl: z.string().optional(),
      contactEmail: z.string().optional(),
      minDraftRankScore: z.number().optional(),
      paidRankThreshold: z.number().optional(),
    }),
    async run(ctx, input) {
      const customer = (await ctx.ws.getCustomer(input.customerId)) as
        | {
            id: string;
            name: string;
            domain?: string | null;
            vertical?: string | null;
            neighborhood?: string | null;
            address?: string | null;
            phone?: string | null;
            processor?: string | null;
            ownerId?: string | null;
            priorityScore?: number | null;
            fitScore?: number | null;
            fitStatus?: string | null;
          }
        | null
        | undefined;
      if (!customer) throw new LaneToolError("customer not found");
      const facts = (await ctx.ws.memoryRecall({
        entityType: "customer",
        entityId: customer.id,
        limit: 100,
      })) as ReadonlyArray<{ kind: string; fact: string }>;
      const priorSignals = parseCustomerSignalFacts(facts);
      const suppCust = await ctx.ws.isSuppressed("customerId", customer.id);
      const suppDomain = customer.domain
        ? await ctx.ws.isSuppressed("domain", customer.domain)
        : null;
      const suppEmail = input.contactEmail
        ? await ctx.ws.isSuppressed("email", input.contactEmail)
        : null;
      const receipt = runMerchantLeadPlay({
        merchant: {
          id: customer.id,
          name: customer.name,
          domain: customer.domain,
          vertical: customer.vertical,
          neighborhood: customer.neighborhood,
          address: customer.address,
          phone: customer.phone,
          processor: customer.processor,
          ownerId: customer.ownerId,
          priorityScore: customer.priorityScore,
          fitScore: customer.fitScore,
          fitStatus: customer.fitStatus,
        },
        signals: priorSignals,
        html: input.html,
        pageUrl: input.pageUrl,
        playName: input.playName,
        contactEmail: input.contactEmail,
        minDraftRankScore: input.minDraftRankScore,
        paidRankThreshold: input.paidRankThreshold,
        suppressed: Boolean(suppCust),
        domainSuppressed: Boolean(suppDomain),
        emailSuppressed: Boolean(suppEmail),
      });
      await ctx.ws.updateCustomer(customer.id, {
        priorityScore: receipt.breakdown.priorityScore,
        fitScore: receipt.breakdown.fitScore,
        fitStatus: receipt.breakdown.fitRating,
        ...(receipt.posGuess ? { processor: receipt.posGuess } : {}),
      });
      if (receipt.newSignal) {
        await ctx.ws.memoryRemember({
          entityType: "customer",
          entityId: customer.id,
          kind: `signal:${receipt.newSignal.type}:${receipt.newSignal.id}`,
          fact: JSON.stringify(receipt.newSignal),
          sourceSessionId: ctx.sessionId,
          sourceAgentSlug: ctx.agentSlug,
        });
      }
      await ctx.ws.memoryRemember({
        entityType: "customer",
        entityId: customer.id,
        kind: `play_run:${receipt.playName}`,
        fact: JSON.stringify(receipt),
        sourceSessionId: ctx.sessionId,
        sourceAgentSlug: ctx.agentSlug,
      });
      return receipt;
    },
  }),

  defineWorkspaceTool({
    name: "customer_morning_brief",
    description:
      "Build the daily rep morning brief of top-ranked merchants with Why Now and recommended next action.",
    permission: "ws:read",
    inputSchema: z.object({
      ownerId: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    async run(ctx, input) {
      const all = (await ctx.ws.listCustomers()) as Array<{
        id: string;
        name: string;
        domain?: string | null;
        vertical?: string | null;
        neighborhood?: string | null;
        address?: string | null;
        phone?: string | null;
        processor?: string | null;
        ownerId?: string | null;
        priorityScore?: number | null;
        fitScore?: number | null;
        fitStatus?: string | null;
        signal?: string | null;
      }>;
      const candidates: AudienceCandidateMerchant[] = await Promise.all(
        all.map(async (cust) => {
          const suppCust = await ctx.ws.isSuppressed("customerId", cust.id);
          const suppDomain = cust.domain
            ? await ctx.ws.isSuppressed("domain", cust.domain)
            : null;
          const suppressed = Boolean(suppCust) || Boolean(suppDomain);
          const whyNow: string | null = cust.signal ?? null;
          return {
            id: cust.id,
            name: cust.name,
            domain: cust.domain,
            vertical: cust.vertical,
            neighborhood: cust.neighborhood,
            address: cust.address,
            phone: cust.phone,
            processor: cust.processor,
            ownerId: cust.ownerId,
            priorityScore: cust.priorityScore,
            fitScore: cust.fitScore,
            fitStatus: cust.fitStatus,
            suppressed,
            whyNow,
          };
        })
      );
      return buildRepMorningBrief({
        merchants: candidates,
        ownerId: input.ownerId,
        limit: input.limit ?? 15,
      });
    },
  }),

  defineWorkspaceTool({
    name: "customer_pull_leads",
    description:
      "Autonomously pull non-POS SMB leads (NYC Home Improvement Contractors, Auto/Garages/Tow, B2B/Medical Equipment/Appliance Service/Storage) from NYC Open Data, deduplicate via SMB match keys, record license signals, and run the Lead Play Engine.",
    permission: "ws:write",
    inputSchema: z.object({
      preset: z
        .enum([
          "nyc_home_improvement_contractors",
          "nyc_auto_and_garages",
          "nyc_b2b_and_specialty_dealers",
        ])
        .default("nyc_home_improvement_contractors"),
      borough: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(15),
    }),
    async run(ctx, input) {
      const source =
        PRESET_NON_POS_SMB_SOURCES[input.preset as NonPosSmbPresetId];
      const extraWhere = input.borough
        ? `upper(address_borough)=upper('${input.borough.replace(/'/g, "")}')`
        : undefined;
      const pulled = await pullSource(source, undefined, {
        limit: input.limit,
        extraWhere,
      });
      const existing = (await ctx.ws.listCustomers()) as Array<{
        id: string;
        name: string;
        externalId?: string | null;
        domain?: string | null;
        address?: string | null;
        phone?: string | null;
        vertical?: string | null;
        neighborhood?: string | null;
        evidenceUri?: string | null;
        processor?: string | null;
        ownerId?: string | null;
      }>;
      const byMatchKey = new Map<string, (typeof existing)[number]>();
      const byExternalId = new Map<string, (typeof existing)[number]>();
      for (const row of existing) {
        if (row.externalId) byExternalId.set(row.externalId, row);
        const mk = computeSmbMatchKey({
          name: row.name,
          address: row.address,
          phone: row.phone,
          domain: row.domain,
        });
        if (mk.matchKey) byMatchKey.set(mk.matchKey, row);
      }
      let createdCount = 0;
      let updatedCount = 0;
      const leads: Array<Record<string, unknown>> = [];
      for (const cand of pulled.candidates) {
        const mk = computeSmbMatchKey({
          name: cand.name,
          address: cand.address,
          phone: cand.phone,
          domain: cand.domain,
        });
        const matched =
          byExternalId.get(cand.externalId) ??
          (mk.matchKey ? byMatchKey.get(mk.matchKey) : undefined);
        const customer = (
          matched
            ? ((await ctx.ws.updateCustomer(matched.id, {
                address: cand.address ?? matched.address,
                phone: mk.phoneE164 ?? cand.phone ?? matched.phone,
                vertical: cand.vertical ?? matched.vertical,
                neighborhood: cand.neighborhood ?? matched.neighborhood,
                evidenceUri: cand.evidenceUri ?? matched.evidenceUri,
                source: source.name,
              })) ?? matched)
            : await ctx.ws.createCustomer({
                name: cand.name,
                externalId: cand.externalId,
                domain: cand.domain ?? null,
                address: cand.address ?? null,
                phone: mk.phoneE164 ?? cand.phone ?? null,
                vertical: cand.vertical ?? null,
                neighborhood: cand.neighborhood ?? null,
                evidenceUri: cand.evidenceUri ?? null,
                source: source.name,
              })
        ) as (typeof existing)[number];
        if (matched) {
          updatedCount += 1;
        } else {
          createdCount += 1;
          byExternalId.set(cand.externalId, customer);
          if (mk.matchKey) byMatchKey.set(mk.matchKey, customer);
        }
        const signalObj: MerchantSignal = {
          id: `sig_${cand.externalId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48)}`,
          merchantId: customer.id,
          type: cand.signal || source.signal || "new_license",
          observedAt: cand.signalDate
            ? new Date(cand.signalDate).toISOString()
            : new Date().toISOString(),
          source: source.name,
          evidenceUrl:
            cand.evidenceUri ??
            "https://data.cityofnewyork.us/resource/w7w3-xahh",
          strength: 85,
          summary: `Active NYC ${cand.vertical ?? "SMB"} license (${cand.externalId})`,
        };
        await ctx.ws.memoryRemember({
          entityType: "customer",
          entityId: customer.id,
          kind: `signal:${signalObj.type}:${signalObj.id}`,
          fact: JSON.stringify(signalObj),
          sourceSessionId: ctx.sessionId,
          sourceAgentSlug: ctx.agentSlug,
        });
        const receipt = runMerchantLeadPlay({
          merchant: {
            id: customer.id,
            name: customer.name,
            domain: customer.domain,
            vertical: customer.vertical,
            neighborhood: customer.neighborhood,
            address: customer.address,
            phone: customer.phone,
            processor: customer.processor,
            ownerId: customer.ownerId,
          },
          signals: [signalObj],
        });
        await ctx.ws.updateCustomer(customer.id, {
          priorityScore: receipt.breakdown.priorityScore,
          fitScore: receipt.breakdown.fitScore,
          fitStatus: receipt.breakdown.fitRating,
          signal: receipt.breakdown.whyNow,
        });
        leads.push({
          customerId: customer.id,
          name: customer.name,
          vertical: customer.vertical,
          neighborhood: customer.neighborhood,
          address: customer.address,
          phone: customer.phone,
          priorityScore: receipt.breakdown.priorityScore,
          fitScore: receipt.breakdown.fitScore,
          whyNow: receipt.breakdown.whyNow,
          playStatus: receipt.status,
        });
      }
      return {
        sourceName: source.name,
        pulledCount: pulled.candidates.length,
        createdCount,
        updatedCount,
        leads,
      };
    },
  }),
];

export function allowedWorkspaceLaneTools(
  policy: LaneToolPolicy
): WorkspaceLaneTool[] {
  return WORKSPACE_LANE_TOOLS.filter((tool) => laneToolAllowed(policy, tool));
}
