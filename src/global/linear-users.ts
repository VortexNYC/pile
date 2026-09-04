import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { linearUsers } from "./schema.js";

export function listLinearUsers(db: D1Client, organizationId: string) {
  return db
    .select()
    .from(linearUsers)
    .where(eq(linearUsers.organizationId, organizationId))
    .all();
}

export function getLinearUser(
  db: D1Client,
  organizationId: string,
  linearId: string
) {
  return db
    .select()
    .from(linearUsers)
    .where(
      and(
        eq(linearUsers.organizationId, organizationId),
        eq(linearUsers.linearId, linearId)
      )
    )
    .get();
}

export async function createLinearUser(
  db: D1Client,
  organizationId: string,
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
        eq(linearUsers.organizationId, organizationId),
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
    organizationId,
    linearId: values.linearId,
    name: values.name ?? null,
    email: values.email ?? null,
  });
  return db
    .select()
    .from(linearUsers)
    .where(
      and(
        eq(linearUsers.organizationId, organizationId),
        eq(linearUsers.linearId, values.linearId)
      )
    )
    .get();
}
