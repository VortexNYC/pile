import { and, eq, or } from "drizzle-orm";

import type { D1Client } from "./db.js";
import {
  attachments,
  comments,
  issueHistory,
  issueRelations,
  issueSubscribers,
  repoBranches,
  repoIssues,
} from "./schema.js";

export async function deleteIssueReferences(
  db: D1Client,
  workspaceId: string,
  issueId: string
) {
  await db
    .delete(comments)
    .where(
      and(eq(comments.workspaceId, workspaceId), eq(comments.issueId, issueId))
    );

  await db
    .delete(issueRelations)
    .where(
      and(
        eq(issueRelations.workspaceId, workspaceId),
        or(
          eq(issueRelations.fromIssueId, issueId),
          eq(issueRelations.toIssueId, issueId)
        )
      )
    );

  await db
    .delete(attachments)
    .where(
      and(
        eq(attachments.workspaceId, workspaceId),
        eq(attachments.issueId, issueId)
      )
    );

  await db
    .delete(issueHistory)
    .where(
      and(
        eq(issueHistory.workspaceId, workspaceId),
        eq(issueHistory.issueId, issueId)
      )
    );

  await db
    .delete(issueSubscribers)
    .where(
      and(
        eq(issueSubscribers.workspaceId, workspaceId),
        eq(issueSubscribers.issueId, issueId)
      )
    );

  await db
    .delete(repoIssues)
    .where(
      and(
        eq(repoIssues.workspaceId, workspaceId),
        eq(repoIssues.issueId, issueId)
      )
    );

  await db
    .delete(repoBranches)
    .where(
      and(
        eq(repoBranches.workspaceId, workspaceId),
        eq(repoBranches.issueId, issueId)
      )
    );
}
