import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { issueHistory } from "./schema.js";

export function listIssueHistory(
  db: D1Client,
  organizationId: string,
  issueId: string
) {
  return db
    .select()
    .from(issueHistory)
    .where(
      and(
        eq(issueHistory.organizationId, organizationId),
        eq(issueHistory.issueId, issueId)
      )
    )
    .orderBy(issueHistory.createdAt)
    .all();
}

export function getIssueHistory(
  db: D1Client,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(issueHistory)
    .where(
      and(
        eq(issueHistory.organizationId, organizationId),
        eq(issueHistory.id, id)
      )
    )
    .get();
}

export async function createIssueHistory(
  db: D1Client,
  organizationId: string,
  values: {
    issueId: string;
    linearId: string | null;
    field: string;
    fromValue?: string | null;
    toValue?: string | null;
    actorId?: string | null;
    createdAt?: string;
  }
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(issueHistory).values({
    id,
    organizationId,
    issueId: values.issueId,
    linearId: values.linearId,
    field: values.field,
    fromValue: values.fromValue ?? null,
    toValue: values.toValue ?? null,
    actorId: values.actorId ?? null,
    createdAt: values.createdAt ?? ts,
  });
  return getIssueHistory(db, organizationId, id);
}
