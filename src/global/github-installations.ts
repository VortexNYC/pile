import { eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { githubInstallations, repoBranches } from "./schema.js";

export function findGithubInstallation(db: D1Client, repo: string) {
  return db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.repo, repo))
    .get();
}

export async function createGithubInstallation(
  db: D1Client,
  workspaceId: string,
  installationId: string,
  repo: string
) {
  const id = crypto.randomUUID();
  await db
    .insert(githubInstallations)
    .values({ id, workspaceId, installationId, repo });
  return { id, workspaceId, installationId, repo };
}

export async function deleteGithubInstallation(db: D1Client, repo: string) {
  await db
    .delete(githubInstallations)
    .where(eq(githubInstallations.repo, repo));
}

export async function deleteGithubInstallationsByInstallationId(
  db: D1Client,
  installationId: string
) {
  await db
    .delete(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId));
}

export async function findWorkspaceByRepo(db: D1Client, repo: string) {
  const fromBranch = await db
    .select({ workspaceId: repoBranches.workspaceId })
    .from(repoBranches)
    .where(eq(repoBranches.repo, repo))
    .get();
  if (fromBranch) return fromBranch;
  return db
    .select({ workspaceId: githubInstallations.workspaceId })
    .from(githubInstallations)
    .where(eq(githubInstallations.repo, repo))
    .get();
}
