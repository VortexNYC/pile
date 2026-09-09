import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { notionPageMappings } from "./schema.js";

export function findNotionPageMapping(
  db: D1Client,
  organizationId: string,
  notionPageId: string
) {
  return db
    .select()
    .from(notionPageMappings)
    .where(
      and(
        eq(notionPageMappings.organizationId, organizationId),
        eq(notionPageMappings.notionPageId, notionPageId)
      )
    )
    .get();
}

export async function createNotionPageMapping(
  db: D1Client,
  organizationId: string,
  notionPageId: string,
  documentId: string
) {
  const id = crypto.randomUUID();
  await db.insert(notionPageMappings).values({
    id,
    organizationId,
    notionPageId,
    documentId,
  });
  return db
    .select()
    .from(notionPageMappings)
    .where(eq(notionPageMappings.id, id))
    .get();
}

export async function updateNotionPageMapping(
  db: D1Client,
  organizationId: string,
  notionPageId: string,
  documentId: string
) {
  await db
    .update(notionPageMappings)
    .set({ documentId, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(notionPageMappings.organizationId, organizationId),
        eq(notionPageMappings.notionPageId, notionPageId)
      )
    );
  return findNotionPageMapping(db, organizationId, notionPageId);
}

export async function upsertNotionPageMapping(
  db: D1Client,
  organizationId: string,
  notionPageId: string,
  documentId: string
) {
  const existing = await findNotionPageMapping(
    db,
    organizationId,
    notionPageId
  );
  if (existing) {
    return updateNotionPageMapping(
      db,
      organizationId,
      notionPageId,
      documentId
    );
  }
  return createNotionPageMapping(
    db,
    organizationId,
    notionPageId,
    documentId
  );
}
