import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { repoBranches, repoIssues } from "./schema.js";

export function findRepoIssue(db: D1Client, repo: string, issueNumber: number) {
  return db
    .select()
    .from(repoIssues)
    .where(
      and(eq(repoIssues.repo, repo), eq(repoIssues.issueNumber, issueNumber))
    )
    .get();
}

export async function createRepoIssue(
  db: D1Client,
  workspaceId: string,
  repo: string,
  issueNumber: number,
  issueId: string
) {
  const id = crypto.randomUUID();
  await db
    .insert(repoIssues)
    .values({ id, workspaceId, repo, issueNumber, issueId });
  return { id, workspaceId, repo, issueNumber, issueId };
}

export async function deleteRepoIssue(
  db: D1Client,
  repo: string,
  issueNumber: number
) {
  await db
    .delete(repoIssues)
    .where(
      and(eq(repoIssues.repo, repo), eq(repoIssues.issueNumber, issueNumber))
    );
}

export function findRepoWorkspace(db: D1Client, repo: string) {
  return db
    .select({ workspaceId: repoBranches.workspaceId })
    .from(repoBranches)
    .where(eq(repoBranches.repo, repo))
    .limit(1)
    .get();
}
