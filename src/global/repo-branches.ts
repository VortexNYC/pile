import type { D1Client } from "./db.js";
import { repoBranches } from "./schema.js";

export async function createRepoBranch(
  db: D1Client,
  organizationId: string,
  repo: string,
  branch: string,
  issueId: string
) {
  const id = crypto.randomUUID();
  await db
    .insert(repoBranches)
    .values({ id, organizationId, repo, branch, issueId });
  return { id, organizationId, repo, branch, issueId };
}

export function suggestBranchName(identifier: string, title: string): string {
  const base = identifier.toLowerCase();
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug ? `${base}-${slug}` : base;
}

const PROTECTED_LANE_BRANCHES = new Set(["main", "master", "head"]);

/** Why `branch` can't be a lane working branch, or null when it can. The
 *  runner pushes exactly refs/heads/<branch>, so a default-branch name (any
 *  case), a refspec (`x:main`, `+main`), a flag (`--force`), or a
 *  fully-qualified ref would turn the lane push into a restricted write. */
export function laneBranchError(branch: string): string | null {
  if (PROTECTED_LANE_BRANCHES.has(branch.toLowerCase())) {
    return `"${branch}" is a repo default branch — branch sets the lane's working branch (leave empty for issue-<id>)`;
  }
  if (
    branch.length === 0 ||
    branch.length > 200 ||
    /^[-/]|^refs\/|[\s:+^~?*[\\]|\.\.|@\{|\/\/|\/$|\.$|\.lock$|(^|\/)\./.test(
      branch
    ) ||
    [...branch].some((ch) => ch.charCodeAt(0) < 0x20 || ch === "\u007f") ||
    branch === "@"
  ) {
    return `"${branch}" is not a plain branch name — branch sets the lane's working branch (leave empty for issue-<id>)`;
  }
  return null;
}
