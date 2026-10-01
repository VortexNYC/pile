import { getInstallationTokenForRepo } from "../global/github-auth.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type {
  AgentSession,
  AgentSessionStatus,
  Issue,
} from "../types/workspace.js";

// PILE-214 — pre-dispatch dedupe. Advisory on file-surface collisions, hard on
// open-PR coverage: an open PR that already names this issue's identifier and
// has no live session is a hard block (duplicate work), while a PR owned by a
// live sibling lane parks the new session behind it via queuedAfter.
// PILE-249 — the block lifts when the covering PR still has unresolved review
// feedback (a reviewer's latest decision is CHANGES_REQUESTED): the lane has
// real work left, so a retry must be able to spin a session back up on the
// same branch instead of dead-ending here.

const GITHUB_PULLS_RE = /^([^/]+)\/([^/]+)$/;

interface GhPull {
  number: number;
  html_url: string;
  title: string;
  body: string | null;
  head: { ref: string };
}

interface GhPullFile {
  filename: string;
}

interface GhReview {
  state?: string;
  user?: { login?: string } | null;
}

export interface DedupeCoverage {
  prUrl: string;
  prNumber: number;
  overlap: "identifier" | "keywords";
  ownerSessionId: string | null;
  /** The covering PR carries unresolved CHANGES_REQUESTED feedback — the
   *  lane has work left, so coverage does not hard-block dispatch. */
  changesRequested?: boolean;
}

export interface DedupeCollision {
  sessionId: string;
  prUrl: string;
  files: string[];
}

export interface DedupeResult {
  coverage: DedupeCoverage[];
  collisions: DedupeCollision[];
  hardBlock: { reason: string; prUrl: string } | null;
  queueAfter: string | null;
}

export interface DedupeDeps {
  tokenForRepo?: (
    env: WorkerEnv,
    owner: string,
    name: string
  ) => Promise<string | undefined>;
  fetch?: typeof fetch;
}

/** Significant tokens from the issue title — length>=4, deduped, lowercase.
 *  Identifiers (PILE-214, VOR-581) are matched separately and verbatim. */
export function titleTokens(title: string): string[] {
  const words = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 4);
  return [...new Set(words)];
}

function pullMatches(
  pull: GhPull,
  identifier: string | null,
  tokens: string[]
): "identifier" | "keywords" | null {
  const haystack = `${pull.title}\n${pull.body ?? ""}\n${pull.head.ref}`;
  if (identifier && haystack.toUpperCase().includes(identifier.toUpperCase())) {
    return "identifier";
  }
  const lower = haystack.toLowerCase();
  const hits = tokens.filter((t) => lower.includes(t));
  return hits.length >= 2 ? "keywords" : null;
}

/** True while at least one reviewer's latest decisional review is still
 *  CHANGES_REQUESTED. COMMENTED/PENDING aren't decisions; a later APPROVED
 *  or DISMISSED from the same reviewer settles it. Mirrors GitHub's
 *  reviewDecision rollup closely enough for the dedupe gate. */
function hasOutstandingChangeRequests(reviews: GhReview[]): boolean {
  const latest = new Map<string, string>();
  for (const review of reviews) {
    const login = review.user?.login;
    const state = review.state?.toUpperCase();
    if (!login || !state) continue;
    if (state === "COMMENTED" || state === "PENDING") continue;
    latest.set(login, state);
  }
  return [...latest.values()].includes("CHANGES_REQUESTED");
}

async function ghGet(
  ghFetch: typeof fetch,
  token: string,
  path: string
): Promise<unknown> {
  const res = await ghFetch(`https://api.github.com${path}`, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pile-agent-dedupe",
    },
  });
  if (!res.ok) {
    throw new Error(`github GET ${path} -> ${res.status}`);
  }
  return res.json();
}

export async function checkDispatchDedupe(
  env: WorkerEnv,
  stub: {
    listAgentSessions(options: {
      issueId?: string;
      status?: AgentSessionStatus;
      openPr?: boolean;
      limit?: number;
    }): Promise<AgentSession[]>;
  },
  issue: Issue,
  deps: DedupeDeps = {}
): Promise<DedupeResult> {
  const result: DedupeResult = {
    coverage: [],
    collisions: [],
    hardBlock: null,
    queueAfter: null,
  };
  if (!issue.repo) return result;
  const repoMatch = GITHUB_PULLS_RE.exec(issue.repo);
  if (!repoMatch) return result;
  const [, owner, name] = repoMatch;

  const tokenForRepo = deps.tokenForRepo ?? getInstallationTokenForRepo;
  const ghFetch = deps.fetch ?? fetch;
  const token = await tokenForRepo(env, owner, name);
  if (!token) return result;

  const identifier = issue.identifier ?? null;
  const tokens = titleTokens(issue.title);

  const pulls = (await ghGet(
    ghFetch,
    token,
    `/repos/${owner}/${name}/pulls?state=open&per_page=100`
  )) as GhPull[];
  if (!Array.isArray(pulls)) return result;

  // Live lanes with open PRs — used both to attribute coverage to a sibling
  // session and for the file-surface collision check.
  const liveSessions = (await stub.listAgentSessions({ limit: 200 })).filter(
    (s) =>
      !["completed", "failed", "canceled"].includes(s.status) &&
      s.issueId !== issue.id
  );
  const ownerByPrUrl = new Map<string, string>();
  for (const s of liveSessions) {
    if (s.prUrl) ownerByPrUrl.set(s.prUrl, s.id);
  }

  for (const pull of pulls) {
    const overlap = pullMatches(pull, identifier, tokens);
    if (!overlap) continue;
    const ownerSessionId = ownerByPrUrl.get(pull.html_url) ?? null;
    const entry: DedupeCoverage = {
      prUrl: pull.html_url,
      prNumber: pull.number,
      overlap,
      ownerSessionId,
    };
    result.coverage.push(entry);
    if (overlap !== "identifier") continue;
    if (ownerSessionId) {
      result.queueAfter = ownerSessionId;
      continue;
    }
    // PILE-249 — before hard-blocking, check whether the covering PR still
    // has work: unresolved CHANGES_REQUESTED means a new session should
    // resume the lane branch, not dead-end on "PR already covers issue".
    const reviews = (await ghGet(
      ghFetch,
      token,
      `/repos/${owner}/${name}/pulls/${pull.number}/reviews?per_page=100`
    )) as GhReview[];
    if (Array.isArray(reviews) && hasOutstandingChangeRequests(reviews)) {
      entry.changesRequested = true;
      continue;
    }
    result.hardBlock = {
      reason: `Open PR ${pull.html_url} already covers ${identifier ?? issue.title} with no live session`,
      prUrl: pull.html_url,
    };
  }

  // Collision check — only against live lanes on the same repo whose PR file
  // list shares a basename/path token with the issue title.
  for (const s of liveSessions) {
    if (!s.prUrl || !s.prUrl.includes(`/${owner}/${name}/pull/`)) continue;
    const numMatch = /\/pull\/(\d+)/.exec(s.prUrl);
    if (!numMatch) continue;
    try {
      const files = (await ghGet(
        ghFetch,
        token,
        `/repos/${owner}/${name}/pulls/${numMatch[1]}/files?per_page=100`
      )) as GhPullFile[];
      if (!Array.isArray(files)) continue;
      const shared = files
        .map((f) => f.filename)
        .filter((filename) => {
          const parts = filename.toLowerCase().split(/[^a-z0-9]+/);
          return tokens.some((t) => parts.includes(t));
        });
      if (shared.length > 0) {
        result.collisions.push({
          sessionId: s.id,
          prUrl: s.prUrl,
          files: shared,
        });
      }
    } catch {
      // Collision data is advisory — a failed file listing never blocks.
    }
  }

  return result;
}
