import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { issueSubscribers } from "./schema.js";

export async function createIssueSubscriber(
  db: D1Client,
  workspaceId: string,
  values: {
    issueId: string;
    linearUserId: string;
  }
) {
  const existing = await db
    .select()
    .from(issueSubscribers)
    .where(
      and(
        eq(issueSubscribers.workspaceId, workspaceId),
        eq(issueSubscribers.issueId, values.issueId),
        eq(issueSubscribers.linearUserId, values.linearUserId)
      )
    )
    .get();
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID();
  await db.insert(issueSubscribers).values({
    id,
    workspaceId,
    issueId: values.issueId,
    linearUserId: values.linearUserId,
  });
  return db
    .select()
    .from(issueSubscribers)
    .where(eq(issueSubscribers.id, id))
    .get();
}
