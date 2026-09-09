import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { gitlabInstallations } from "./schema.js";

export function findGitlabInstallationByProjectPath(
  db: D1Client,
  projectPath: string
) {
  return db
    .select()
    .from(gitlabInstallations)
    .where(eq(gitlabInstallations.projectPath, projectPath))
    .get();
}

export function findGitlabInstallation(
  db: D1Client,
  organizationId: string,
  projectPath: string
) {
  return db
    .select()
    .from(gitlabInstallations)
    .where(
      and(
        eq(gitlabInstallations.organizationId, organizationId),
        eq(gitlabInstallations.projectPath, projectPath)
      )
    )
    .get();
}

export function listGitlabInstallations(db: D1Client, organizationId: string) {
  return db
    .select()
    .from(gitlabInstallations)
    .where(eq(gitlabInstallations.organizationId, organizationId))
    .all();
}

export async function createGitlabInstallation(
  db: D1Client,
  organizationId: string,
  projectId: string,
  projectPath: string,
  token: string,
  webhookSecret?: string | null
) {
  const id = crypto.randomUUID();
  await db.insert(gitlabInstallations).values({
    id,
    organizationId,
    projectId,
    projectPath,
    token,
    webhookSecret: webhookSecret ?? null,
  });
  return db
    .select()
    .from(gitlabInstallations)
    .where(eq(gitlabInstallations.id, id))
    .get();
}

export async function deleteGitlabInstallation(
  db: D1Client,
  organizationId: string,
  id: string
) {
  await db
    .delete(gitlabInstallations)
    .where(
      and(
        eq(gitlabInstallations.organizationId, organizationId),
        eq(gitlabInstallations.id, id)
      )
    );
}
