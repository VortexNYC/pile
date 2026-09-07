import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { githubInstallations, repoBranches } from "./schema.js";

export function findGithubInstallation(db: D1Client, repo: string) {
  return db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.repo, repo))
    .get();
}

export function listGithubInstallations(db: D1Client, organizationId: string) {
  return db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.organizationId, organizationId))
    .all();
}

export async function createGithubInstallation(
  db: D1Client,
  organizationId: string,
  installationId: string,
  repo: string
) {
  const id = crypto.randomUUID();
  await db
    .insert(githubInstallations)
    .values({ id, organizationId, installationId, repo });
  return { id, organizationId, installationId, repo };
}

export async function deleteGithubInstallation(db: D1Client, repo: string) {
  await db
    .delete(githubInstallations)
    .where(eq(githubInstallations.repo, repo));
}

export async function deleteGithubInstallationById(
  db: D1Client,
  organizationId: string,
  id: string
) {
  await db
    .delete(githubInstallations)
    .where(
      and(
        eq(githubInstallations.organizationId, organizationId),
        eq(githubInstallations.id, id)
      )
    );
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
    .select({ organizationId: repoBranches.organizationId })
    .from(repoBranches)
    .where(eq(repoBranches.repo, repo))
    .get();
  if (fromBranch) return fromBranch;
  return db
    .select({ organizationId: githubInstallations.organizationId })
    .from(githubInstallations)
    .where(eq(githubInstallations.repo, repo))
    .get();
}
