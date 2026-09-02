import { and, eq } from "drizzle-orm";
import type { D1Client } from "./db.js";
import { repoBranches } from "./schema.js";

export function findRepoBranch(db: D1Client, repo: string, branch: string) {
  return db
    .select()
    .from(repoBranches)
    .where(and(eq(repoBranches.repo, repo), eq(repoBranches.branch, branch)))
    .get();
}

export async function createRepoBranch(
  db: D1Client,
  workspaceId: string,
  repo: string,
  branch: string,
  issueId: string,
) {
  const id = crypto.randomUUID();
  await db
    .insert(repoBranches)
    .values({ id, workspaceId, repo, branch, issueId });
  return { id, workspaceId, repo, branch, issueId };
}
