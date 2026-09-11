import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { repoBranches, repoIssues } from "./schema.js";

type RepoSource = "github" | "gitlab";

export function findRepoIssue(
  db: D1Client,
  repo: string,
  issueNumber: number,
  source: RepoSource = "github"
) {
  return db
    .select()
    .from(repoIssues)
    .where(
      and(
        eq(repoIssues.source, source),
        eq(repoIssues.repo, repo),
        eq(repoIssues.issueNumber, issueNumber)
      )
    )
    .get();
}

export function findRepoIssueByIssueId(db: D1Client, issueId: string) {
  return db
    .select()
    .from(repoIssues)
    .where(eq(repoIssues.issueId, issueId))
    .get();
}

export async function createRepoIssue(
  db: D1Client,
  organizationId: string,
  repo: string,
  issueNumber: number,
  issueId: string,
  source: RepoSource = "github"
) {
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(repoIssues)
    .values({ id, organizationId, source, repo, issueNumber, issueId })
    .onConflictDoNothing({
      target: [repoIssues.source, repoIssues.repo, repoIssues.issueNumber],
    })
    .returning()
    .get();
  if (inserted) return inserted;
  const existing = await findRepoIssue(db, repo, issueNumber, source);
  if (existing) return existing;
  throw new Error("Failed to create repo issue mapping");
}

export async function deleteRepoIssue(
  db: D1Client,
  repo: string,
  issueNumber: number,
  source: RepoSource = "github"
) {
  await db
    .delete(repoIssues)
    .where(
      and(
        eq(repoIssues.source, source),
        eq(repoIssues.repo, repo),
        eq(repoIssues.issueNumber, issueNumber)
      )
    );
}

export function findRepoWorkspace(db: D1Client, repo: string) {
  return db
    .select({ organizationId: repoBranches.organizationId })
    .from(repoBranches)
    .where(eq(repoBranches.repo, repo))
    .limit(1)
    .get();
}
