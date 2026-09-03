import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { githubUsers } from "./schema.js";

export function findUserByGithubLogin(
  db: D1Client,
  workspaceId: string,
  githubLogin: string
) {
  return db
    .select({ userId: githubUsers.userId })
    .from(githubUsers)
    .where(
      and(
        eq(githubUsers.workspaceId, workspaceId),
        eq(githubUsers.githubLogin, githubLogin)
      )
    )
    .get();
}

export async function createGithubUserMapping(
  db: D1Client,
  workspaceId: string,
  userId: string,
  githubLogin: string
) {
  const id = crypto.randomUUID();
  await db.insert(githubUsers).values({
    id,
    workspaceId,
    userId,
    githubLogin,
  });
  return { id, workspaceId, userId, githubLogin };
}
