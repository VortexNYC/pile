import { and, eq } from "drizzle-orm";
import type { D1Client } from "./db.js";
import { issueRelations } from "./schema.js";

const relationTypes = new Set([
  "parent",
  "child",
  "blocks",
  "blocked_by",
  "related",
  "duplicate",
]);

export function isValidRelationType(type: string): boolean {
  return relationTypes.has(type);
}

export function listIssueRelations(
  db: D1Client,
  workspaceId: string,
  fromIssueId: string,
) {
  return db
    .select()
    .from(issueRelations)
    .where(
      and(
        eq(issueRelations.workspaceId, workspaceId),
        eq(issueRelations.fromIssueId, fromIssueId),
      ),
    )
    .all();
}

export function getIssueRelation(db: D1Client, id: string) {
  return db
    .select()
    .from(issueRelations)
    .where(eq(issueRelations.id, id))
    .get();
}

export async function createIssueRelation(
  db: D1Client,
  workspaceId: string,
  values: {
    fromIssueId: string;
    toIssueId: string;
    type: string;
  },
) {
  if (!isValidRelationType(values.type)) {
    throw new Error(`Invalid relation type: ${values.type}`);
  }
  const id = crypto.randomUUID();
  await db.insert(issueRelations).values({
    id,
    workspaceId,
    fromIssueId: values.fromIssueId,
    toIssueId: values.toIssueId,
    type: values.type,
  });
  return db
    .select()
    .from(issueRelations)
    .where(eq(issueRelations.id, id))
    .get();
}

export async function deleteIssueRelation(db: D1Client, id: string) {
  await db.delete(issueRelations).where(eq(issueRelations.id, id));
}
