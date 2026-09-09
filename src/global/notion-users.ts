import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { notionUsers } from "./schema.js";

export function findNotionUserByNotionId(
  db: D1Client,
  organizationId: string,
  notionUserId: string
) {
  return db
    .select({ userId: notionUsers.userId })
    .from(notionUsers)
    .where(
      and(
        eq(notionUsers.organizationId, organizationId),
        eq(notionUsers.notionUserId, notionUserId)
      )
    )
    .get();
}

export function listNotionUsers(db: D1Client, organizationId: string) {
  return db
    .select()
    .from(notionUsers)
    .where(eq(notionUsers.organizationId, organizationId))
    .all();
}

export async function createNotionUserMapping(
  db: D1Client,
  organizationId: string,
  userId: string,
  notionUserId: string
) {
  const id = crypto.randomUUID();
  await db.insert(notionUsers).values({
    id,
    organizationId,
    userId,
    notionUserId,
  });
  const row = await db
    .select()
    .from(notionUsers)
    .where(eq(notionUsers.id, id))
    .get();
  if (!row) {
    throw new Error("Failed to create Notion user mapping");
  }
  return row;
}
