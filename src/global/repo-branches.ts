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
