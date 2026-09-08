import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { repoBranches, repoIssues } from "./schema.js";

// Per-issue workspace data (comments, history, relations, subscribers,
// approvals, reactions, attachments, notifications, agent sessions) is
// cascade-deleted inside the workspace Durable Object. Only the
// cross-workspace repo lookup indexes stay here.
export async function deleteIssueReferences(
  db: D1Client,
  organizationId: string,
  issueId: string
) {
  await db
    .delete(repoIssues)
    .where(
      and(
        eq(repoIssues.organizationId, organizationId),
        eq(repoIssues.issueId, issueId)
      )
    );

  await db
    .delete(repoBranches)
    .where(
      and(
        eq(repoBranches.organizationId, organizationId),
        eq(repoBranches.issueId, issueId)
      )
    );
}
