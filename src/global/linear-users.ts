import { and, eq } from "drizzle-orm";
import { D1Client } from "./db.js";
import { linearUsers } from "./schema.js";

export function listLinearUsers(db: D1Client, workspaceId: string) {
  return db
    .select()
    .from(linearUsers)
    .where(eq(linearUsers.workspaceId, workspaceId))
    .all();
}

export function getLinearUser(db: D1Client, workspaceId: string, linearId: string) {
  return db
    .select()
    .from(linearUsers)
    .where(
      and(
        eq(linearUsers.workspaceId, workspaceId),
        eq(linearUsers.linearId, linearId)
      )
    )
    .get();
}

export async function createLinearUser(
  db: D1Client,
  workspaceId: string,
  values: {
    linearId: string;
    name?: string;
    email?: string;
  }
) {
  const existing = await db
    .select()
    .from(linearUsers)
    .where(
      and(
        eq(linearUsers.workspaceId, workspaceId),
        eq(linearUsers.linearId, values.linearId)
      )
    )
    .get();
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID();
  await db.insert(linearUsers).values({
    id,
    workspaceId,
    linearId: values.linearId,
    name: values.name ?? null,
    email: values.email ?? null,
  });
  return db
    .select()
    .from(linearUsers)
    .where(
      and(
        eq(linearUsers.workspaceId, workspaceId),
        eq(linearUsers.linearId, values.linearId)
      )
    )
    .get();
}
