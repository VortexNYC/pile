import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { notionIssueMappings } from "./schema.js";

export function findNotionIssueMapping(
  db: D1Client,
  organizationId: string,
  notionPageId: string
) {
  return db
    .select()
    .from(notionIssueMappings)
    .where(
      and(
        eq(notionIssueMappings.organizationId, organizationId),
        eq(notionIssueMappings.notionPageId, notionPageId)
      )
    )
    .get();
}

export async function createNotionIssueMapping(
  db: D1Client,
  organizationId: string,
  notionPageId: string,
  issueId: string
) {
  const id = crypto.randomUUID();
  await db.insert(notionIssueMappings).values({
    id,
    organizationId,
    notionPageId,
    issueId,
  });
  return db
    .select()
    .from(notionIssueMappings)
    .where(eq(notionIssueMappings.id, id))
    .get();
}

export async function updateNotionIssueMapping(
  db: D1Client,
  organizationId: string,
  notionPageId: string,
  issueId: string
) {
  await db
    .update(notionIssueMappings)
    .set({ issueId, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(notionIssueMappings.organizationId, organizationId),
        eq(notionIssueMappings.notionPageId, notionPageId)
      )
    );
  return findNotionIssueMapping(db, organizationId, notionPageId);
}

export async function upsertNotionIssueMapping(
  db: D1Client,
  organizationId: string,
  notionPageId: string,
  issueId: string
) {
  const existing = await findNotionIssueMapping(
    db,
    organizationId,
    notionPageId
  );
  if (existing) {
    return updateNotionIssueMapping(db, organizationId, notionPageId, issueId);
  }
  return createNotionIssueMapping(db, organizationId, notionPageId, issueId);
}
