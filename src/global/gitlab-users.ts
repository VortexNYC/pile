import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { gitlabUsers } from "./schema.js";

export function findUserByGitlabUsername(
  db: D1Client,
  organizationId: string,
  gitlabUsername: string
) {
  return db
    .select({ userId: gitlabUsers.userId })
    .from(gitlabUsers)
    .where(
      and(
        eq(gitlabUsers.organizationId, organizationId),
        eq(gitlabUsers.gitlabUsername, gitlabUsername)
      )
    )
    .get();
}

export function listGitlabUsers(db: D1Client, organizationId: string) {
  return db
    .select()
    .from(gitlabUsers)
    .where(eq(gitlabUsers.organizationId, organizationId))
    .all();
}

export async function createGitlabUserMapping(
  db: D1Client,
  organizationId: string,
  userId: string,
  gitlabUsername: string
) {
  const id = crypto.randomUUID();
  await db.insert(gitlabUsers).values({
    id,
    organizationId,
    userId,
    gitlabUsername,
  });
  const row = await db
    .select()
    .from(gitlabUsers)
    .where(eq(gitlabUsers.id, id))
    .get();
  if (!row) {
    throw new Error("Failed to create GitLab user mapping");
  }
  return row;
}
