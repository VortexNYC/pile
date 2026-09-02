import { eq } from "drizzle-orm";
import type { D1Client } from "./db.js";
import { workspaceTokens } from "./schema.js";

export async function createWorkspaceToken(
  db: D1Client,
  workspaceId: string,
  name: string,
  permissions = "read,write",
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
