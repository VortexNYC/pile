// PILE-273 — automated PR review lane. On PR open/synchronize (webhook fast
// path, sweep backstop) Pile dispatches a cheap repo-less review session
// with the PR diff inlined, then publishes its verdict as a structured PR
// comment plus a `pile-review` check run minted with the installation token,
// so branch protection / the merge queue can gate on it.
//
// Lifecycle (one per headSha):
//   request  → check run `in_progress` + review session + `review.requested`
//   publish  → (sweep, after the session goes terminal) check run completed,
//              verdict comment posted, `review.published`
// Diffs confined to `.pile/config.json` `conflict.generated` paths get a
// `skipped` check run and no lane — same "don't waste tokens" set the
// conflict fixer uses.
import { z } from "zod";

import {
  parsePileRepoConfig,
  type PileRepoConfig,
} from "../global/pile-repo-config.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { AgentSession, Issue } from "../types/workspace.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import { loadProviderConfig } from "./credentials.js";
import { resolveAgentEnv } from "./daytona.js";
import { dispatchAgent } from "./index.js";
import { nudgeLane, resolveLaneForIssue } from "./nudge.js";

export const REVIEW_CHECK_NAME = "pile-review";
export const REVIEW_PURPOSE = "review";
export const DEFAULT_REVIEW_AGENT = "devin-cli";

// The prompt travels as a base64 env var into the sandbox; a single env
// string is capped at 128 KiB on Linux, so the inlined diff stays well under.
const DIFF_CHAR_BUDGET = 60_000;
const PR_BODY_CHAR_BUDGET = 4_000;
// GitHub check-run output.summary / issue comment bodies cap at 65535.
const GITHUB_TEXT_CAP = 65_000;
const PR_FILES_PAGE_CAP = 10;
// Verdicts are published by the sweep; past this age a terminal review
// session is presumed handled (or abandoned) and no longer scanned.
const PUBLISH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// PILE-445 — a non-completed pile-review check run older than this with no
// live lane behind it is orphaned: the lane died before it could publish
// (provisioning failure, lost session record, a dropped resolve PATCH) and
// nothing will ever complete it. The requester resolves it or takes it over
// instead of deduping on it. The age gate covers the create→dispatch window
// where the run exists before the session row/event is visible.
export const REVIEW_CHECK_STALE_MS = 15 * 60 * 1000;
// Dispatch attempts per headSha — one automatic retry, mirroring the work
// lane's MAX_AUTO_RETRIES. A review lane that dies on provisioning gets a
// second lane via the stale-run takeover, then the check resolves.
const MAX_REVIEW_ATTEMPTS = 2;

type WorkspaceStub = DurableObjectStub<WorkspaceDO>;

export type ReviewVerdict = "approve" | "comment" | "request-changes";
export type FindingSeverity = "breaking" | "must" | "minor";

export interface ReviewFinding {
  severity: FindingSeverity;
  title: string;
  file?: string;
  line?: number;
  detail?: string;
}

export interface ParsedReview {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  /** The lane's report carried no machine-readable verdict block. */
  unstructured: boolean;
}

export interface ReviewTarget {
  repoFull: string;
  pullNumber: number;
  prUrl: string;
  headSha: string;
  baseRef: string;
  title?: string | null;
  body?: string | null;
}

export interface ReviewDeps {
  fetch?: typeof fetch;
  now?: number;
}

export type ReviewRequestOutcome =
  | "deduped"
  | "disabled"
  | "skipped_generated"
  | "dispatched"
  | "failed";

const VERDICT_RANK: Record<ReviewVerdict, number> = {
  approve: 0,
  comment: 1,
  "request-changes": 2,
};

const SEVERITY_ALIASES: Record<string, FindingSeverity> = {
  breaking: "breaking",
  break: "breaking",
  "will-break": "breaking",
  caution: "breaking",
  critical: "breaking",
  must: "must",
  "must-address": "must",
  important: "must",
  major: "must",
  minor: "minor",
  nit: "minor",
  info: "minor",
  suggestion: "minor",
};

const findingSchema = z.object({
  severity: z.string(),
  title: z.string().optional(),
  file: z.string().nullish(),
  line: z.number().int().nullish(),
  detail: z.string().nullish(),
});

const verdictBlockSchema = z.object({
  verdict: z.string(),
  summary: z.string().optional(),
  findings: z.array(findingSchema).optional(),
});

const requestedPayloadSchema = z.object({
  prUrl: z.string(),
  repo: z.string(),
  pullNumber: z.number(),
  headSha: z.string(),
  checkRunId: z.number().nullable().optional(),
});

const publishedPayloadSchema = z.object({
  reviewId: z.number().nullable().optional(),
});

type RequestedPayload = z.infer<typeof requestedPayloadSchema>;

function normalizeVerdict(raw: string): ReviewVerdict | null {
  const v = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (v === "approve" || v === "approved" || v === "lgtm") return "approve";
  if (v === "comment" || v === "commented" || v === "comments")
    return "comment";
  if (
    v === "request-changes" ||
    v === "changes-requested" ||
    v === "request-change"
  )
    return "request-changes";
  return null;
}

function verdictFromFindings(findings: ReviewFinding[]): ReviewVerdict {
  if (findings.some((f) => f.severity !== "minor")) return "request-changes";
  if (findings.length > 0) return "comment";
  return "approve";
}

function stricter(a: ReviewVerdict, b: ReviewVerdict): ReviewVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

function jsonCandidates(text: string): string[] {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map(
    (m) => m[1]
  );
  const out = fenced.toReversed();
  const lastBrace = text.lastIndexOf("}");
  const firstBrace = text.indexOf("{");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    out.push(text.slice(firstBrace, lastBrace + 1));
  }
  return out;
}

/** Parse the review lane's final report into a verdict. The lane is asked for
 *  a trailing ```json block; anything else degrades to a `comment` verdict
 *  carrying the raw report so a malformed answer never silently approves. */
export function parseReviewVerdict(report: string | null): ParsedReview {
  const text = (report ?? "").trim();
  for (const candidate of jsonCandidates(text)) {
    let raw: unknown;
    try {
      raw = JSON.parse(candidate);
    } catch {
      continue;
    }
    const block = verdictBlockSchema.safeParse(raw);
    if (!block.success) continue;
    const stated = normalizeVerdict(block.data.verdict);
    if (!stated) continue;
    const findings: ReviewFinding[] = (block.data.findings ?? []).map((f) => ({
      severity:
        SEVERITY_ALIASES[
          f.severity.trim().toLowerCase().replace(/\s+/g, "-")
        ] ?? "minor",
      title: (f.title ?? f.detail ?? "Finding").trim(),
      ...(f.file ? { file: f.file } : {}),
      ...(typeof f.line === "number" ? { line: f.line } : {}),
      ...(f.detail ? { detail: f.detail.trim() } : {}),
    }));
    return {
      // A lane that states "approve" over must-address findings is
      // contradicting itself — the findings win.
      verdict: stricter(stated, verdictFromFindings(findings)),
      summary: (block.data.summary ?? "").trim(),
      findings,
      unstructured: false,
    };
  }
  const tagged =
    /verdict\s*[:=]\s*\**\s*(approve|comment|request[-_ ]changes)/i.exec(text);
  const verdict = tagged ? normalizeVerdict(tagged[1]) : null;
  return {
    verdict: verdict && verdict !== "approve" ? verdict : "comment",
    summary: text || "The review lane produced no report.",
    findings: [],
    unstructured: true,
  };
}

const VERDICT_HEADLINE: Record<ReviewVerdict, string> = {
  approve: "✅ Approve",
  comment: "💬 Comment",
  "request-changes": "⛔ Request changes",
};

function findingLines(f: ReviewFinding): string[] {
  const where = f.file ? ` — \`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
  const lines = [`- **${f.title}**${where}`];
  if (f.detail) {
    for (const line of f.detail.split("\n")) lines.push(`  ${line}`);
  }
  return lines;
}

function calloutBlock(
  kind: "CAUTION" | "IMPORTANT",
  label: string,
  findings: ReviewFinding[]
): string[] {
  if (findings.length === 0) return [];
  const body = [`**${label}**`, ...findings.flatMap(findingLines)];
  return [`> [!${kind}]`, ...body.map((l) => (l ? `> ${l}` : ">")), ""];
}

export function reviewCommentMarker(headSha: string): string {
  return `<!-- pile-review sha=${headSha} -->`;
}

/** The pullfrog callout ladder: [!CAUTION] will break → [!IMPORTANT] must
 *  address → ℹ️ minor → ✅ clean. */
export function renderReviewBody(
  review: ParsedReview,
  headSha: string
): string {
  const by = (s: FindingSeverity) =>
    review.findings.filter((f) => f.severity === s);
  const minor = by("minor");
  const lines = [
    `### Pile review: ${VERDICT_HEADLINE[review.verdict]}`,
    "",
    `Reviewed \`${headSha.slice(0, 12)}\`.`,
    "",
  ];
  if (review.summary) lines.push(review.summary, "");
  lines.push(...calloutBlock("CAUTION", "Will break", by("breaking")));
  lines.push(...calloutBlock("IMPORTANT", "Must address", by("must")));
  if (minor.length > 0) {
    lines.push("ℹ️ **Minor**", "", ...minor.flatMap(findingLines), "");
  }
  if (review.findings.length === 0 && !review.unstructured) {
    lines.push("✅ **Clean** — no issues found.", "");
  }
  const body = lines.join("\n").trim();
  return body.length > GITHUB_TEXT_CAP
    ? `${body.slice(0, GITHUB_TEXT_CAP)}\n\n…(truncated)`
    : body;
}

export function reviewCheckTitle(review: ParsedReview): string {
  const count = (s: FindingSeverity) =>
    review.findings.filter((f) => f.severity === s).length;
  const parts = [
    count("breaking") ? `${count("breaking")} will break` : null,
    count("must") ? `${count("must")} must address` : null,
    count("minor") ? `${count("minor")} minor` : null,
  ].filter((p): p is string => p !== null);
  const headline = VERDICT_HEADLINE[review.verdict].replace(/^\S+\s/, "");
  return parts.length > 0 ? `${headline}: ${parts.join(", ")}` : headline;
}

/** request-changes fails the check so a required `pile-review` blocks the
 *  merge queue; comment is advisory (neutral); approve passes. */
export function verdictConclusion(
  verdict: ReviewVerdict
): "success" | "neutral" | "failure" {
  if (verdict === "approve") return "success";
  if (verdict === "comment") return "neutral";
  return "failure";
}

export interface PrFile {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  previous_filename?: string;
}

/** Changed files minus the repo's declared generated artifacts. */
export function reviewableFiles(
  files: PrFile[],
  config: PileRepoConfig | null
): PrFile[] {
  const generated = new Set(config?.conflict?.generated ?? []);
  return files.filter((f) => !generated.has(f.filename));
}

/** Inline unified diff for the prompt, bounded by DIFF_CHAR_BUDGET. Files
 *  that don't fit (or have no textual patch) are listed by name only. */
export function buildReviewDiff(
  files: PrFile[],
  budget = DIFF_CHAR_BUDGET
): string {
  const parts: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const f of files) {
    const header =
      `diff --git a/${f.previous_filename ?? f.filename} b/${f.filename}\n` +
      `# ${f.status ?? "modified"} (+${f.additions ?? 0} -${f.deletions ?? 0})\n`;
    if (!f.patch) {
      omitted.push(
        `${f.filename} (${f.status ?? "modified"}, no textual patch)`
      );
      continue;
    }
    const chunk = `${header}${f.patch}\n`;
    if (used + chunk.length > budget) {
      omitted.push(`${f.filename} (diff budget exceeded)`);
      continue;
    }
    parts.push(chunk);
    used += chunk.length;
  }
  if (omitted.length > 0) {
    parts.push(
      `# Not inlined (${omitted.length}):\n${omitted.map((o) => `#   ${o}`).join("\n")}\n`
    );
  }
  return parts.join("\n");
}

export function buildReviewInstructions(
  target: ReviewTarget,
  diff: string,
  skippedGenerated: string[]
): string {
  const body = (target.body ?? "").trim();
  return [
    "This is a REVIEW-ONLY run: do not implement, edit, commit, or push anything — ignore any later instruction to implement the change. Your only output is the final answer described below.",
    "",
    `Review pull request ${target.prUrl}${target.title ? ` — "${target.title}"` : ""}.`,
    `Repository: ${target.repoFull}, base \`${target.baseRef}\`, head \`${target.headSha}\`.`,
    ...(body
      ? [
          "",
          "PR description:",
          body.length > PR_BODY_CHAR_BUDGET
            ? `${body.slice(0, PR_BODY_CHAR_BUDGET)}…`
            : body,
        ]
      : []),
    ...(skippedGenerated.length > 0
      ? [
          "",
          `Generated artifacts excluded from the diff (regenerated from source, do not review): ${skippedGenerated.join(", ")}`,
        ]
      : []),
    "",
    "Look for correctness bugs, regressions, security problems, broken contracts, and missing tests for changed behavior. Skip style nits a formatter would catch. Classify each finding:",
    '- "breaking": will break — build/runtime failure, data loss, security hole.',
    '- "must": must address before merge.',
    '- "minor": optional improvement.',
    "",
    "Verdict: request-changes if any breaking/must finding, comment if only minor findings, approve if clean.",
    "End your final answer with exactly one fenced json block:",
    "```json",
    '{"verdict":"approve|comment|request-changes","summary":"one or two sentences","findings":[{"severity":"breaking|must|minor","title":"short","file":"path","line":1,"detail":"why + suggested fix"}]}',
    "```",
    "",
    "## Diff",
    "",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pile-review",
    "Content-Type": "application/json",
  };
}

class GhHttpError extends Error {
  readonly status: number;
  constructor(method: string, path: string, status: number) {
    super(`github ${method} ${path} -> ${status}`);
    this.name = "GhHttpError";
    this.status = status;
  }
}

async function gh(
  ghFetch: typeof fetch,
  token: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const res = await ghFetch(`https://api.github.com${path}`, {
    method,
    headers: ghHeaders(token),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    throw new GhHttpError(method, path, res.status);
  }
  return res.json();
}

async function fetchRepoConfig(
  ghFetch: typeof fetch,
  token: string,
  repoFull: string,
  ref: string
): Promise<PileRepoConfig | null> {
  const raw = await gh(
    ghFetch,
    token,
    "GET",
    `/repos/${repoFull}/contents/.pile/config.json?ref=${encodeURIComponent(ref)}`
  ).catch(() => null);
  const parsed = z
    .object({ content: z.string(), encoding: z.literal("base64") })
    .safeParse(raw);
  if (!parsed.success) return null;
  try {
    return parsePileRepoConfig(
      JSON.parse(atob(parsed.data.content.replace(/\s/g, "")))
    );
  } catch {
    return null;
  }
}

async function listPrFiles(
  ghFetch: typeof fetch,
  token: string,
  target: ReviewTarget
): Promise<PrFile[]> {
  const files: PrFile[] = [];
  for (let page = 1; page <= PR_FILES_PAGE_CAP; page++) {
    const batch = await gh(
      ghFetch,
      token,
      "GET",
      `/repos/${target.repoFull}/pulls/${target.pullNumber}/files?per_page=100&page=${page}`
    );
    const parsed = z
      .array(
        z.object({
          filename: z.string(),
          status: z.string().optional(),
          additions: z.number().optional(),
          deletions: z.number().optional(),
          patch: z.string().optional(),
          previous_filename: z.string().optional(),
        })
      )
      .safeParse(batch);
    if (!parsed.success) break;
    files.push(...parsed.data);
    if (parsed.data.length < 100) break;
  }
  return files;
}

export interface ReviewCheckRun {
  id: number;
  status?: string | null;
  conclusion?: string | null;
  started_at?: string | null;
}

/** Every pile-review check run for a head sha — each dispatch attempt opens
 *  exactly one, so the count doubles as the retry bound when the Pile-side
 *  record is lost. Returns null when the list can't be read or parsed:
 *  callers must then dedupe conservatively — an invisible pending run can't
 *  be allowed to silently gate nothing while a duplicate lane dispatches. */
async function listReviewChecks(
  ghFetch: typeof fetch,
  token: string,
  repoFull: string,
  headSha: string
): Promise<ReviewCheckRun[] | null> {
  const raw = await gh(
    ghFetch,
    token,
    "GET",
    `/repos/${repoFull}/commits/${headSha}/check-runs?check_name=${REVIEW_CHECK_NAME}&per_page=100`
  ).catch(() => null);
  const parsed = z
    .object({
      check_runs: z.array(
        z.object({
          id: z.number(),
          status: z.string().nullish(),
          conclusion: z.string().nullish(),
          started_at: z.string().nullish(),
        })
      ),
    })
    .safeParse(raw);
  return parsed.success ? parsed.data.check_runs : null;
}

/** A pile-review run is hung when it never reached `completed` and its start
 *  is older than the stale window. Runs missing a start time stay live —
 *  without an age we can't rule out the create→dispatch window. */
export function reviewCheckStale(
  run: { status?: string | null; started_at?: string | null } | null,
  now: number
): boolean {
  if (!run || run.status === "completed") return false;
  const started = Date.parse(run.started_at ?? "");
  return Number.isFinite(started) && now - started > REVIEW_CHECK_STALE_MS;
}

/** Complete a check run neutral — the lane is dead or never ran, so the run
 *  must not sit pending forever. Best-effort: a rejected PATCH just leaves
 *  the run stale for the next pass. */
async function resolveReviewCheck(
  ghFetch: typeof fetch,
  token: string,
  repoFull: string,
  checkRunId: number,
  output: { title: string; summary: string }
): Promise<void> {
  await gh(
    ghFetch,
    token,
    "PATCH",
    `/repos/${repoFull}/check-runs/${checkRunId}`,
    {
      status: "completed",
      conclusion: "neutral",
      completed_at: new Date().toISOString(),
      output,
    }
  ).catch((err) => {
    console.error("pile-review check-run resolve failed", {
      checkRunId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

function parsePayload(payload: string | null): unknown {
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

const REVIEW_TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);

/** Review sessions Pile already started for this headSha. `live` = one is
 *  still non-terminal (it owns the sha's check run — dedupe outright);
 *  `attempts` counts every lane that recorded `review.requested`, so the
 *  stale-run takeover stays bounded. */
async function reviewSessionsFor(
  stub: WorkspaceStub,
  issueId: string,
  target: Pick<ReviewTarget, "prUrl" | "headSha">
): Promise<{ live: boolean; attempts: number }> {
  const sessions = await stub.listAgentSessions({ issueId, limit: 50 });
  let live = false;
  let attempts = 0;
  for (const s of sessions) {
    if (s.purpose !== REVIEW_PURPOSE) continue;
    const events = await stub.listAgentSessionEvents(s.id, {
      limit: 20,
      order: "asc",
    });
    const hit = events.some((e) => {
      if (e.type !== "review.requested") return false;
      const p = requestedPayloadSchema.safeParse(parsePayload(e.payload));
      return (
        p.success &&
        p.data.headSha === target.headSha &&
        p.data.prUrl === target.prUrl
      );
    });
    if (!hit) continue;
    attempts += 1;
    if (!REVIEW_TERMINAL_STATUSES.has(s.status)) live = true;
  }
  return { live, attempts };
}

/** Start the review lane for a PR head, at most once per headSha. Opt-in per
 *  repo via `.pile/config.json` `review` (read from the base ref, so a PR
 *  can't enable or retarget its own review). Never throws. */
export async function requestPrReview(
  env: WorkerEnv,
  stub: WorkspaceStub,
  organizationId: string,
  issue: Issue,
  target: ReviewTarget,
  token: string,
  deps: ReviewDeps = {}
): Promise<ReviewRequestOutcome> {
  const ghFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now();
  // PILE-445 — the run this request opened: once it exists, every failure
  // path must complete it or the PR carries a pending pile-review check
  // forever.
  let openedCheckRunId: number | null = null;
  try {
    const prior = await reviewSessionsFor(stub, issue.id, target);
    if (prior.live) return "deduped";

    const config = await fetchRepoConfig(
      ghFetch,
      token,
      target.repoFull,
      target.baseRef
    );
    if (!config?.review) return "disabled";
    const agentId = config.review.agent ?? DEFAULT_REVIEW_AGENT;
    if (config.agents && !config.agents.includes(agentId)) return "disabled";

    // The check run is the cross-path marker: it exists before the session
    // event does, and survives a lost Pile record. A fresh pending run
    // dedupes; a stale one is an orphan left by a lane that died before
    // publishing — resolved below so it can't gate the PR forever.
    const runs = await listReviewChecks(
      ghFetch,
      token,
      target.repoFull,
      target.headSha
    );
    // A failed read can't tell a live run from none — dispatching blind
    // could race a duplicate lane under an existing pending check, so sit
    // this pass out and let the next request/sweep retry.
    if (runs === null) return "deduped";
    const staleOpens = runs.filter(
      (r) => r.status !== "completed" && reviewCheckStale(r, now)
    );
    // Any fresh pending run means a dispatch is in flight right now.
    if (runs.some((r) => r.status !== "completed" && !reviewCheckStale(r, now)))
      return "deduped";
    const delivered = runs.some(
      (r) => r.status === "completed" && r.conclusion !== "neutral"
    );
    const outOfAttempts =
      prior.attempts >= MAX_REVIEW_ATTEMPTS ||
      runs.length >= MAX_REVIEW_ATTEMPTS;
    if (delivered || outOfAttempts) {
      // Verdict already landed, or the retry budget is spent — still close
      // any stale orphans so nothing on the PR waits on them.
      for (const run of staleOpens) {
        await resolveReviewCheck(ghFetch, token, target.repoFull, run.id, {
          title: delivered
            ? "Superseded by a later pile-review run"
            : "Review did not complete",
          summary: delivered
            ? `A completed pile-review check already covers \`${target.headSha.slice(0, 12)}\`.`
            : `The pile-review lane for \`${target.headSha.slice(0, 12)}\` never reported a verdict and is out of retries.`,
        });
      }
      return "deduped";
    }
    // Takeover: one lane + one run per attempt — whichever record survives
    // (session event or run count) bounds the retries. Resolve the orphaned
    // run, then fall through to a fresh dispatch for the same sha.
    for (const run of staleOpens) {
      await resolveReviewCheck(ghFetch, token, target.repoFull, run.id, {
        title: "Review lane lost — retrying",
        summary: `The pile-review lane for \`${target.headSha.slice(0, 12)}\` never reported; dispatching a new attempt.`,
      });
    }

    const files = await listPrFiles(ghFetch, token, target);
    const reviewable = reviewableFiles(files, config);
    if (reviewable.length === 0) {
      await gh(ghFetch, token, "POST", `/repos/${target.repoFull}/check-runs`, {
        name: REVIEW_CHECK_NAME,
        head_sha: target.headSha,
        status: "completed",
        conclusion: "skipped",
        output: {
          title: "Generated-only diff — review skipped",
          summary:
            files.length > 0
              ? `Every changed file is declared in .pile/config.json conflict.generated:\n\n${files.map((f) => `- \`${f.filename}\``).join("\n")}`
              : "The PR has no changed files.",
        },
      });
      return "skipped_generated";
    }

    const checkRun = await gh(
      ghFetch,
      token,
      "POST",
      `/repos/${target.repoFull}/check-runs`,
      {
        name: REVIEW_CHECK_NAME,
        head_sha: target.headSha,
        status: "in_progress",
        started_at: new Date().toISOString(),
        output: {
          title: "Review in progress",
          summary: `Pile is reviewing \`${target.headSha.slice(0, 12)}\`.`,
        },
      }
    ).catch((err) => {
      console.error("pile-review check-run create failed", {
        prUrl: target.prUrl,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    const parsedRun = z.object({ id: z.number() }).safeParse(checkRun);
    openedCheckRunId = parsedRun.success ? parsedRun.data.id : null;

    const skipped = files
      .filter((f) => !reviewable.includes(f))
      .map((f) => f.filename);
    const instructions = buildReviewInstructions(
      target,
      buildReviewDiff(reviewable),
      skipped
    );
    const providerConfig = await loadProviderConfig(env, stub, agentId);
    try {
      const session = await dispatchAgent(
        resolveAgentEnv(env, providerConfig ?? undefined),
        agentId,
        organizationId,
        // Repo-less: the diff is inlined, so no clone, branch, or push.
        { ...issue, repo: null, branch: null },
        {
          id: "pile-review",
          organizationId,
          type: "agent",
          permissions: [],
        },
        config.review.model,
        undefined,
        {
          instructions,
          purpose: REVIEW_PURPOSE,
          skipQueue: true,
          concurrent: true,
        }
      );
      // The publish pass keys on this event — if it can't be written the
      // lane still runs but its verdict can never land, and with no
      // review.requested record a later request sees attempts = 0 and could
      // dispatch a duplicate. Fail the session so the sweep's reaper cancels
      // the provider lane instead of it running untracked (PILE-445).
      const payload: RequestedPayload = {
        prUrl: target.prUrl,
        repo: target.repoFull,
        pullNumber: target.pullNumber,
        headSha: target.headSha,
        checkRunId: openedCheckRunId,
      };
      try {
        await stub.addAgentSessionEvent({
          sessionId: session.id,
          type: "review.requested",
          message: `Review requested for ${target.prUrl} @ ${target.headSha.slice(0, 12)}`,
          payload,
        });
      } catch (eventErr) {
        await stub
          .applyAgentSessionResult(session.id, {
            status: "failed",
            result: `review.requested event write failed: ${
              eventErr instanceof Error ? eventErr.message : String(eventErr)
            }`,
            infraFailure: true,
          })
          .catch(() => {});
        throw eventErr;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (openedCheckRunId !== null) {
        await resolveReviewCheck(
          ghFetch,
          token,
          target.repoFull,
          openedCheckRunId,
          {
            title: "Review lane could not start",
            summary: message.slice(0, 2000),
          }
        );
      }
      console.error("pile-review dispatch failed", {
        prUrl: target.prUrl,
        error: message,
      });
      return "failed";
    }
    return "dispatched";
  } catch (err) {
    // PILE-445 — anything past the check-run create (provider config, event
    // write, a blown RPC) resolves the run; only a thrown resolve keeps it
    // pending, and the stale-run sweep picks that up.
    if (openedCheckRunId !== null) {
      await resolveReviewCheck(
        ghFetch,
        token,
        target.repoFull,
        openedCheckRunId,
        {
          title: "Review lane could not start",
          summary: (err instanceof Error ? err.message : String(err)).slice(
            0,
            2000
          ),
        }
      );
    }
    console.error("pile-review request failed", {
      prUrl: target.prUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }
}

/** The verdict as a real GitHub review event. Posted alongside the check
 *  run so the verdict shows up in `pulls/{n}/reviews` — the webhook and
 *  sweep review-detection paths then treat it like any reviewer. Approves
 *  never reach this map: they stay a plain comment at the call site. */
const VERDICT_REVIEW_EVENT: Record<
  Exclude<ReviewVerdict, "approve">,
  "COMMENT" | "REQUEST_CHANGES"
> = {
  comment: "COMMENT",
  "request-changes": "REQUEST_CHANGES",
};

/** POST /pulls/{n}/reviews for a verdict. Two failure shapes matter: the
 *  app authored the PR (GitHub 422s REQUEST_CHANGES on own PRs) and a
 *  stale commit_id after a force-push — both are definitive 4xx rejections
 *  and degrade to a bare COMMENT so the verdict still lands as a review.
 *  A 5xx or a failed response read is *not* definitive — the review may
 *  have been created server-side, so the POST is never blindly retried;
 *  the caller's issue-comment fallback carries the verdict instead.
 *  Returns null only when no review could be posted at all. */
async function postPrReview(
  ghFetch: typeof fetch,
  token: string,
  req: RequestedPayload,
  event: "COMMENT" | "REQUEST_CHANGES",
  body: string
): Promise<{ id: number | null; url: string | null } | null> {
  const path = `/repos/${req.repo}/pulls/${req.pullNumber}/reviews`;
  let raw: unknown = null;
  try {
    raw = await gh(ghFetch, token, "POST", path, {
      commit_id: req.headSha,
      event,
      body,
    });
  } catch (err) {
    if (err instanceof GhHttpError && err.status >= 400 && err.status < 500) {
      try {
        raw = await gh(ghFetch, token, "POST", path, {
          event: "COMMENT",
          body,
        });
      } catch (retryErr) {
        console.error("pile-review verdict review failed", {
          prUrl: req.prUrl,
          error:
            retryErr instanceof Error ? retryErr.message : String(retryErr),
        });
      }
    } else {
      console.error("pile-review verdict review failed", {
        prUrl: req.prUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const parsed = z
    .object({ id: z.number(), html_url: z.string() })
    .safeParse(raw);
  return parsed.success
    ? { id: parsed.data.id, url: parsed.data.html_url }
    : null;
}

/** PILE-315 — a published verdict is work for the author lane, not just a
 *  PR artifact: deliver it through the shared nudge path so it lands as a
 *  `prompt.followup` like pr.ci_failed does. The dedupeKey carries the
 *  posted review's `review-<id>` marker, so whichever of this nudge and the
 *  pull_request_review webhook/sweep detection runs first wins and the
 *  other dedupes away. */
async function nudgeWorkLaneWithVerdict(
  env: WorkerEnv,
  stub: WorkspaceStub,
  organizationId: string,
  session: AgentSession,
  req: RequestedPayload,
  review: ParsedReview,
  body: string,
  reviewId: number | null
): Promise<void> {
  try {
    const workLane = await resolveLaneForIssue(stub, session.issueId, {
      excludePurpose: REVIEW_PURPOSE,
      limit: 50,
    });
    if (!workLane) return;
    const issue = await stub.getIssue(session.issueId).catch(() => undefined);
    await nudgeLane(env, stub, organizationId, workLane, issue, req.prUrl, {
      prompt:
        `Pile's review lane ${review.verdict === "request-changes" ? "requested changes" : "left review feedback"} ` +
        `on ${req.prUrl} (sha ${req.headSha.slice(0, 12)}).\n\n${body}\n\n` +
        "Address the review feedback on the PR and push.",
      reason: "review feedback",
      dedupeKey:
        reviewId !== null ? `review-${reviewId}` : `pile-review-${req.headSha}`,
      headSha: req.headSha,
    });
  } catch (err) {
    console.error("pile-review verdict nudge failed", {
      session: session.id,
      prUrl: req.prUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Publish verdicts for terminal review sessions: complete the check run,
 *  post the verdict as a PR review (plain comment as fallback), hand it to
 *  the work lane as a follow-up prompt, record `review.published`.
 *  Idempotent per session — a failed publish retries on the next sweep. */
export async function publishReviewVerdicts(
  stub: WorkspaceStub,
  deps: ReviewDeps & {
    env: WorkerEnv;
    organizationId: string;
    tokenForRepo: (owner: string, name: string) => Promise<string | undefined>;
    now?: number;
  }
): Promise<number> {
  const ghFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now();
  const sessions = await stub.listAgentSessions({ limit: 200 });
  let published = 0;
  for (const session of sessions) {
    if (session.purpose !== REVIEW_PURPOSE) continue;
    if (!["completed", "failed", "canceled"].includes(session.status)) continue;
    const endedAt = Date.parse(session.endedAt ?? session.updatedAt ?? "");
    if (Number.isFinite(endedAt) && now - endedAt > PUBLISH_MAX_AGE_MS) {
      continue;
    }
    try {
      const events = await stub.listAgentSessionEvents(session.id, {
        limit: 100,
        order: "desc",
      });
      const requestedEvent = events.find((e) => e.type === "review.requested");
      if (!requestedEvent) continue;
      const requested = requestedPayloadSchema.safeParse(
        parsePayload(requestedEvent.payload)
      );
      if (!requested.success) continue;
      const req = requested.data;
      const review =
        session.status === "completed"
          ? parseReviewVerdict(session.result)
          : null;
      const body = review ? renderReviewBody(review, req.headSha) : null;

      // PILE-315 — review.published marks the GitHub side done, not the
      // handoff: a rejected (or throttled) verdict nudge retries on every
      // sweep until nudgeLane's delivery dedupe sees it, mirroring how
      // detected reviews retry. This is also what carries the
      // pile-review-<sha> fallback key no detection pass can see — the
      // compound failure that left a request-changes verdict stranded.
      const publishedEvent = events.find((e) => e.type === "review.published");
      if (publishedEvent) {
        if (review && review.verdict !== "approve" && body !== null) {
          const recorded = publishedPayloadSchema.safeParse(
            parsePayload(publishedEvent.payload)
          );
          await nudgeWorkLaneWithVerdict(
            deps.env,
            stub,
            deps.organizationId,
            session,
            req,
            review,
            body,
            recorded.success ? (recorded.data.reviewId ?? null) : null
          );
        }
        continue;
      }

      const [owner, name] = req.repo.split("/");
      const token = await deps.tokenForRepo(owner, name);
      if (!token) continue;

      // PILE-470 — drop stale results: if the PR's head moved past the sha
      // this review ran on, the verdict is for a dead head and a fresh
      // review on the new sha is the one that should land.
      try {
        const pr = (await gh(
          ghFetch,
          token,
          "GET",
          `/repos/${req.repo}/pulls/${req.pullNumber}`
        )) as { head?: { sha?: string } };
        if (pr.head?.sha && pr.head.sha !== req.headSha) {
          await stub
            .addAgentSessionEvent({
              sessionId: session.id,
              type: "review.dropped",
              message: `Stale verdict dropped — head moved ${req.headSha.slice(0, 8)} → ${pr.head.sha.slice(0, 8)}`,
              payload: { requestedSha: req.headSha, headSha: pr.head.sha },
            })
            .catch(() => {});
          continue;
        }
      } catch {
        // if the head check fails, publish anyway — a dropped verdict is
        // worse than a slightly stale one when the check itself is flaky.
      }

      const output = review
        ? { title: reviewCheckTitle(review), summary: body ?? "" }
        : {
            // PILE-470 — post parsed findings only; an unparseable lane
            // result stays neutral, not the raw tail.
            title: `Review lane ${session.status}`,
            summary: "The review lane finished without a parseable verdict.",
          };
      const conclusion = review ? verdictConclusion(review.verdict) : "neutral";
      const checkBody = {
        status: "completed",
        conclusion,
        completed_at: new Date(now).toISOString(),
        output,
      };
      if (typeof req.checkRunId === "number") {
        await gh(
          ghFetch,
          token,
          "PATCH",
          `/repos/${req.repo}/check-runs/${req.checkRunId}`,
          checkBody
        );
      } else {
        await gh(ghFetch, token, "POST", `/repos/${req.repo}/check-runs`, {
          name: REVIEW_CHECK_NAME,
          head_sha: req.headSha,
          ...checkBody,
        });
      }

      // PILE-315 — actionable verdicts land as a real pull_request_review
      // (REQUEST_CHANGES/COMMENT), so the webhook + sweep review detection
      // treat it like any reviewer. Approve stays a plain comment: an
      // approval is a terminal signal for humans, not work for the lane.
      let commentUrl: string | null = null;
      let reviewId: number | null = null;
      if (body && review && review.verdict !== "approve") {
        const posted = await postPrReview(
          ghFetch,
          token,
          req,
          VERDICT_REVIEW_EVENT[review.verdict],
          `${reviewCommentMarker(req.headSha)}\n${body}`
        );
        reviewId = posted?.id ?? null;
        commentUrl = posted?.url ?? null;
      }
      if (body && commentUrl === null) {
        const comment = await gh(
          ghFetch,
          token,
          "POST",
          `/repos/${req.repo}/issues/${req.pullNumber}/comments`,
          { body: `${reviewCommentMarker(req.headSha)}\n${body}` }
        );
        const url = z.object({ html_url: z.string() }).safeParse(comment);
        commentUrl = url.success ? url.data.html_url : null;
      }

      await stub.addAgentSessionEvent({
        sessionId: session.id,
        type: "review.published",
        message: review
          ? `Review verdict for ${req.prUrl}: ${review.verdict}`
          : `Review lane ${session.status} for ${req.prUrl}`,
        payload: {
          prUrl: req.prUrl,
          headSha: req.headSha,
          verdict: review?.verdict ?? null,
          conclusion,
          commentUrl,
          reviewId,
          checkRunId: req.checkRunId ?? null,
        },
      });
      published++;

      if (review && review.verdict !== "approve" && body !== null) {
        await nudgeWorkLaneWithVerdict(
          deps.env,
          stub,
          deps.organizationId,
          session,
          req,
          review,
          body,
          reviewId
        );
      }
    } catch (err) {
      console.error("pile-review publish failed", {
        session: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return published;
}
