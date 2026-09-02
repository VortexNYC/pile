import { eq } from "drizzle-orm";
import { D1Client } from "./db.js";
import { linearUsers } from "./schema.js";

export function listLinearUsers(db: D1Client, workspaceId: string) {
  return db
    .select()
    .from(linearUsers)
    .where(eq(linearUsers.workspaceId, workspaceId))
    .all();
}

export function getLinearUser(db: D1Client, id: string) {
  return db.select().from(linearUsers).where(eq(linearUsers.id, id)).get();
}

export async function createLinearUser(
  db: D1Client,
  workspaceId: string,
  values: {
    id: string;
    name?: string;
    email?: string;
  }
) {
  const existing = await db
    .select()
    .from(linearUsers)
    .where(eq(linearUsers.id, values.id))
    .get();
  if (existing) {
    return existing;
  }
  await db.insert(linearUsers).values({
    id: values.id,
    workspaceId,
    name: values.name ?? null,
    email: values.email ?? null,
  });
  return db.select().from(linearUsers).where(eq(linearUsers.id, values.id)).get();
}
