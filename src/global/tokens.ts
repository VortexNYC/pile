import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { workspaceTokens } from "./schema.js";

export async function createWorkspaceToken(
  db: D1Client,
  workspaceId: string,
  name: string,
  permissions = "read,write"
) {
  const id = crypto.randomUUID();
  const token = crypto.randomUUID();

  await db
    .insert(workspaceTokens)
    .values({ id, workspaceId, name, tokenHash: token, permissions });

  return { id, token, name, permissions, workspaceId };
}

export function findWorkspaceToken(db: D1Client, token: string) {
  return db
    .select()
    .from(workspaceTokens)
    .where(eq(workspaceTokens.tokenHash, token))
    .get();
}

export function listWorkspaceTokens(db: D1Client, workspaceId: string) {
  return db
    .select({
      id: workspaceTokens.id,
      workspaceId: workspaceTokens.workspaceId,
      name: workspaceTokens.name,
      permissions: workspaceTokens.permissions,
      createdAt: workspaceTokens.createdAt,
    })
    .from(workspaceTokens)
    .where(eq(workspaceTokens.workspaceId, workspaceId))
    .all();
}

export async function deleteWorkspaceToken(
  db: D1Client,
  workspaceId: string,
  id: string
) {
  await db
    .delete(workspaceTokens)
    .where(
      and(
        eq(workspaceTokens.workspaceId, workspaceId),
        eq(workspaceTokens.id, id)
      )
    );
}
