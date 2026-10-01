import {
  parseReviewSummary,
  type ReviewVerdict,
} from "../workspace/review-summary.js";

// PILE-286 — incremental review context. A follow-up review on a lane's PR
// carries the rolling verdict snapshot (agent_sessions.review_summary) plus
// the range diff from the last-reviewed head to this review's head, so the
// lane scopes the round to what changed instead of re-deriving the whole PR.

const MAX_COMMITS = 10;
const MAX_FILES = 30;

export interface RangeDiff {
  base: string;
  head: string;
  /** GitHub compare status: ahead | behind | diverged | identical. */
  status: string;
  totalCommits: number;
  commits: Array<{ sha: string; subject: string }>;
  files: Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
}

type GithubGet = (path: string) => Promise<unknown>;

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** GET /compare/{base}...{head}, narrowed to what the prompt renders. */
export async function fetchRangeDiff(
  ghGet: GithubGet,
  repoFull: string,
  base: string,
  head: string
): Promise<RangeDiff | null> {
  const raw = await ghGet(`/repos/${repoFull}/compare/${base}...${head}`);
  if (!isRecord(raw) || typeof raw.status !== "string") return null;
  const commits = (Array.isArray(raw.commits) ? raw.commits : [])
    .filter(isRecord)
    .map((c) => {
      const commit = isRecord(c.commit) ? c.commit : {};
      const message = typeof commit.message === "string" ? commit.message : "";
      return {
        sha: typeof c.sha === "string" ? c.sha : "",
        subject: message.split("\n")[0] ?? "",
      };
    })
    .filter((c) => c.sha.length > 0);
  const files = (Array.isArray(raw.files) ? raw.files : [])
    .filter(isRecord)
    .map((f) => ({
      filename: typeof f.filename === "string" ? f.filename : "",
      status: typeof f.status === "string" ? f.status : "modified",
      additions: typeof f.additions === "number" ? f.additions : 0,
      deletions: typeof f.deletions === "number" ? f.deletions : 0,
    }))
    .filter((f) => f.filename.length > 0);
  return {
    base,
    head,
    status: raw.status,
    totalCommits:
      typeof raw.total_commits === "number"
        ? raw.total_commits
        : commits.length,
    commits,
    files,
  };
}

function renderRange(base: string, head: string, range: RangeDiff | null) {
  const span = `${shortSha(base)}..${shortSha(head)}`;
  if (!range) {
    return (
      `Changes since the last review: ${span} — run ` +
      `\`git log ${base}..${head}\` / \`git diff ${base}...${head}\` to scope this round.\n`
    );
  }
  if (range.status === "identical" || range.status === "behind") {
    return `No new commits since the last review (${shortSha(base)}).\n`;
  }
  if (range.status === "diverged") {
    return (
      `The branch was rewritten (force-push/rebase) since the last review at ${shortSha(base)}; ` +
      "prior verdicts may refer to code that no longer exists — re-check them against the current diff.\n"
    );
  }
  const lines = [
    `Changes since the last review (${span}, ${range.totalCommits} commit${range.totalCommits === 1 ? "" : "s"}):`,
    ...range.commits
      .slice(-MAX_COMMITS)
      .map((c) => `- ${shortSha(c.sha)} ${c.subject}`),
  ];
  if (range.totalCommits > MAX_COMMITS) {
    lines.push(`- …and ${range.totalCommits - MAX_COMMITS} earlier`);
  }
  if (range.files.length > 0) {
    lines.push("Files touched:");
    lines.push(
      ...range.files
        .slice(0, MAX_FILES)
        .map(
          (f) =>
            `- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`
        )
    );
    if (range.files.length > MAX_FILES) {
      lines.push(`- …and ${range.files.length - MAX_FILES} more`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export interface ReviewPromptInput {
  reviewer: string;
  prUrl: string;
  state: string;
  body: string;
  /** Head sha the review was submitted against (review.commit_id). */
  sha: string | null;
  /** Verdicts recorded before this review (lower review ids). */
  prior: ReviewVerdict[];
  range: RangeDiff | null;
}

export function buildReviewPrompt(input: ReviewPromptInput): string {
  let prompt =
    `${input.reviewer} reviewed ${input.prUrl} (${input.state.toLowerCase()}).\n` +
    (input.body ? `Review:\n${input.body}\n` : "");
  if (input.prior.length > 0) {
    prompt +=
      "\nPrior review verdicts on this PR (oldest first):\n" +
      input.prior
        .map(
          (v) =>
            `- ${v.reviewer} ${v.state.toLowerCase()}${v.sha ? ` @${shortSha(v.sha)}` : ""}` +
            (v.excerpt ? `: ${v.excerpt}` : "")
        )
        .join("\n") +
      "\n";
    const base = input.prior.findLast((v) => v.sha !== null)?.sha ?? null;
    if (base && input.sha && base !== input.sha) {
      prompt += renderRange(base, input.sha, input.range);
      prompt +=
        "Scope this round to the changes since the last review; prior verdicts on unchanged code still stand unless this review says otherwise.\n";
    } else if (base && base === input.sha) {
      prompt += `No new commits since the last review (${shortSha(base)}).\n`;
    }
    prompt += "\n";
  }
  return (
    prompt +
    "Read the review comments on the PR, address the feedback, and push."
  );
}

/** Prior verdicts + range diff for one review, resolved from the lane's
 *  rolling snapshot. Deterministic per review id, so delivery retries
 *  rebuild the same prompt regardless of reviews recorded since. */
export async function reviewPromptWithContext(input: {
  reviewer: string;
  prUrl: string;
  state: string;
  body: string;
  reviewId: number;
  sha: string | null;
  reviewSummary: string | null;
  repoFull: string;
  ghGet: GithubGet | null;
}): Promise<string> {
  const prior = parseReviewSummary(input.reviewSummary).filter(
    (v) => v.reviewId < input.reviewId
  );
  const base = prior.findLast((v) => v.sha !== null)?.sha ?? null;
  let range: RangeDiff | null = null;
  if (input.ghGet && base && input.sha && base !== input.sha) {
    range = await fetchRangeDiff(
      input.ghGet,
      input.repoFull,
      base,
      input.sha
    ).catch(() => null);
  }
  return buildReviewPrompt({
    reviewer: input.reviewer,
    prUrl: input.prUrl,
    state: input.state,
    body: input.body,
    sha: input.sha,
    prior,
    range,
  });
}
