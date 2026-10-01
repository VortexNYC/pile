/**
 * Lane trust-boundary helpers (PILE-277). Everything a lane reports back —
 * log lines, results, PR URLs, branch names — is attacker-controlled from
 * Pile's point of view, so it passes through these before it is persisted
 * or acted on.
 */

// GitHub token families: installation (ghs_), OAuth (gho_), user-to-server
// (ghu_), refresh (ghr_), classic PAT (ghp_), fine-grained PAT.
const GITHUB_TOKEN_RE =
  /\b(gh[opsur]_)[A-Za-z0-9_]{8,}|\bgithub_pat_[A-Za-z0-9_]{8,}/g;
const URL_CREDENTIAL_RE = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const BEARER_RE = /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/g;

/** Masks credentials that a lane may echo into its transcript. */
export function redactSecrets(text: string): string {
  return text
    .replace(URL_CREDENTIAL_RE, "$1***@")
    .replace(GITHUB_TOKEN_RE, (_m, prefix: string | undefined) =>
      prefix ? `${prefix}***` : "github_pat_***"
    )
    .replace(BEARER_RE, "$1 ***");
}

const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+$/;

/** True when `prUrl` is a pull request on exactly `repo` (owner/name). */
export function prUrlOnRepo(prUrl: string, repo: string): boolean {
  const match = PR_URL_RE.exec(prUrl.trim());
  if (!match) return false;
  return `${match[1]}/${match[2]}`.toLowerCase() === repo.toLowerCase();
}

/**
 * Applied to every provider/runner result before it is persisted: masks
 * echoed credentials and drops a PR URL that points outside the session's
 * repository (the sweep mints tokens and updates branches for that URL).
 */
export function sanitizeLaneResult<
  T extends {
    result?: string | null;
    prUrl?: string | null;
    prState?: string | null;
  },
>(result: T, repo: string | null): T {
  const next = { ...result };
  if (typeof next.result === "string") next.result = redactSecrets(next.result);
  if (repo && next.prUrl && !prUrlOnRepo(next.prUrl, repo)) {
    next.prUrl = null;
    next.prState = null;
  }
  return next;
}

/**
 * Lane branch names reach `git push` argv and refspecs. Anything that can
 * be read as an option, a refspec, a fully-qualified/symbolic ref, or a
 * revision expression is refused before a sandbox is provisioned.
 */
export function isSafeLaneBranch(branch: string): boolean {
  if (branch.length === 0 || branch.length > 200) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return false;
  if (branch.includes("..") || branch.includes("//")) return false;
  if (branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock"))
    return false;
  if (branch.split("/").some((part) => part.startsWith("."))) return false;
  if (/^(refs|heads|tags|remotes)\//i.test(branch)) return false;
  if (/^(HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD)$/i.test(branch)) return false;
  return true;
}
