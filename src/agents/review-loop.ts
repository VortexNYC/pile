import type { AgentSession } from "../types/workspace.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";

type WorkspaceStub = DurableObjectStub<WorkspaceDO>;

const DELIVERED_TYPES = new Set(["prompt.followup", "prompt.redispatch"]);
const THREADS_EVENT = "pr.review_threads";

/** A non-approving verdict the author lane owes a fix for: changes
 *  requested, or a COMMENTED review that carries a body. */
export function isChangesVerdict(state: string, body: string): boolean {
  const s = state.toUpperCase();
  return (
    s === "CHANGES_REQUESTED" || (s === "COMMENTED" && body.trim().length > 0)
  );
}

/** Event automations a newly detected review fires: `pr.review` for any
 *  review with feedback, plus `pr.review_changes` for non-approve verdicts. */
export function reviewAutomationEvents(state: string, body: string): string[] {
  const events: string[] = [];
  if (state.toUpperCase() === "CHANGES_REQUESTED" || body.trim().length > 0) {
    events.push("pr.review");
  }
  if (isChangesVerdict(state, body)) events.push("pr.review_changes");
  return events;
}

/** Earliest delivery time per feedback key (`review-<id>` / `comment-<id>`)
 *  from the lane's follow-up events. */
export function deliveredFeedback(
  events: ReadonlyArray<{
    type: string;
    payload: string | null;
    createdAt: string;
  }>
): Map<string, number> {
  const delivered = new Map<string, number>();
  for (const e of events) {
    if (!DELIVERED_TYPES.has(e.type) || !e.payload) continue;
    let key: unknown;
    try {
      const parsed: unknown = JSON.parse(e.payload);
      key =
        parsed && typeof parsed === "object" && "key" in parsed
          ? parsed.key
          : undefined;
    } catch {
      continue;
    }
    if (
      typeof key !== "string" ||
      !(key.startsWith("review-") || key.startsWith("comment-"))
    ) {
      continue;
    }
    const at = Date.parse(e.createdAt);
    if (!Number.isFinite(at)) continue;
    const prior = delivered.get(key);
    if (prior === undefined || at < prior) delivered.set(key, at);
  }
  return delivered;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  commentId: number | null;
  reviewId: number | null;
}

export interface PrCommit {
  committedAt: number;
  isMerge: boolean;
}

/** Threads the author lane has addressed: unresolved, their feedback was
 *  delivered to the lane, and a non-merge commit landed after delivery.
 *  Merge commits are excluded so a base-branch update-branch never counts
 *  as the fix. */
export function addressedThreads(
  threads: readonly ReviewThread[],
  commits: readonly PrCommit[],
  delivered: ReadonlyMap<string, number>
): ReviewThread[] {
  const pushes = commits
    .filter((c) => !c.isMerge && Number.isFinite(c.committedAt))
    .map((c) => c.committedAt);
  if (pushes.length === 0) return [];
  const lastPush = Math.max(...pushes);
  return threads.filter((t) => {
    if (t.isResolved) return false;
    const at = Math.min(
      t.commentId !== null
        ? (delivered.get(`comment-${t.commentId}`) ?? Infinity)
        : Infinity,
      t.reviewId !== null
        ? (delivered.get(`review-${t.reviewId}`) ?? Infinity)
        : Infinity
    );
    return Number.isFinite(at) && lastPush > at;
  });
}

const THREADS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      commits(last: 20) {
        nodes { commit { committedDate parents { totalCount } } }
      }
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { databaseId pullRequestReview { databaseId } }
          }
        }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

async function githubGraphql(
  ghFetch: typeof fetch,
  token: string,
  timeoutMs: number,
  query: string,
  variables: Record<string, unknown>
): Promise<unknown> {
  const res = await ghFetch("https://api.github.com/graphql", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "pile-agent-sweep",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`github graphql -> ${res.status}`);
  const json: unknown = await res.json();
  if (
    json &&
    typeof json === "object" &&
    "errors" in json &&
    Array.isArray(json.errors) &&
    json.errors.length > 0
  ) {
    throw new Error(`github graphql error: ${JSON.stringify(json.errors)}`);
  }
  return json;
}

interface ThreadsResponse {
  data?: {
    repository?: {
      pullRequest?: {
        commits?: {
          nodes?: Array<{
            commit?: {
              committedDate?: string;
              parents?: { totalCount?: number };
            };
          }>;
        };
        reviewThreads?: {
          nodes?: Array<{
            id?: string;
            isResolved?: boolean;
            comments?: {
              nodes?: Array<{
                databaseId?: number | null;
                pullRequestReview?: { databaseId?: number | null } | null;
              }>;
            };
          }>;
        };
      } | null;
    } | null;
  };
}

function parseThreadsResponse(raw: unknown): {
  threads: ReviewThread[];
  commits: PrCommit[];
} {
  const pr = (raw as ThreadsResponse).data?.repository?.pullRequest;
  const threads: ReviewThread[] = [];
  for (const node of pr?.reviewThreads?.nodes ?? []) {
    if (typeof node.id !== "string") continue;
    const first = node.comments?.nodes?.[0];
    threads.push({
      id: node.id,
      isResolved: node.isResolved === true,
      commentId:
        typeof first?.databaseId === "number" ? first.databaseId : null,
      reviewId:
        typeof first?.pullRequestReview?.databaseId === "number"
          ? first.pullRequestReview.databaseId
          : null,
    });
  }
  const commits: PrCommit[] = (pr?.commits?.nodes ?? []).map((n) => ({
    committedAt: Date.parse(n.commit?.committedDate ?? ""),
    isMerge: (n.commit?.parents?.totalCount ?? 1) > 1,
  }));
  return { threads, commits };
}

/** PILE-274 — close the review loop: once the author lane pushes after
 *  receiving review feedback, resolve the PR review threads it was sent.
 *  Checked once per headSha (pr.review_threads event); a GitHub failure
 *  leaves no marker so the next sweep or push retries. */
export async function resolveAddressedReviewThreads(
  stub: WorkspaceStub,
  session: Pick<AgentSession, "id">,
  pr: {
    owner: string;
    repo: string;
    number: number;
    prUrl: string;
    headSha: string;
  },
  deps: { token: string; fetch: typeof fetch; timeoutMs?: number }
): Promise<void> {
  const events = await stub
    .listAgentSessionEvents(session.id, { limit: 100, order: "desc" })
    .catch(() => []);
  const alreadyChecked = events.some(
    (e) =>
      e.type === THREADS_EVENT &&
      typeof e.payload === "string" &&
      e.payload.includes(pr.headSha)
  );
  if (alreadyChecked) return;
  const delivered = deliveredFeedback(events);
  if (delivered.size === 0) return;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  try {
    const raw = await githubGraphql(
      deps.fetch,
      deps.token,
      timeoutMs,
      THREADS_QUERY,
      {
        owner: pr.owner,
        repo: pr.repo,
        number: pr.number,
      }
    );
    const { threads, commits } = parseThreadsResponse(raw);
    const targets = addressedThreads(threads, commits, delivered);
    const resolved: string[] = [];
    for (const thread of targets) {
      await githubGraphql(deps.fetch, deps.token, timeoutMs, RESOLVE_MUTATION, {
        threadId: thread.id,
      });
      resolved.push(thread.id);
    }
    await stub
      .addAgentSessionEvent({
        sessionId: session.id,
        type: THREADS_EVENT,
        message:
          resolved.length > 0
            ? `Resolved ${resolved.length} review thread(s) on ${pr.prUrl} after the lane pushed a fix`
            : `No addressed review threads on ${pr.prUrl}`,
        payload: { prUrl: pr.prUrl, headSha: pr.headSha, resolved },
      })
      .catch(() => {});
  } catch (err) {
    console.error("review thread resolve failed", {
      session: session.id,
      prUrl: pr.prUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
