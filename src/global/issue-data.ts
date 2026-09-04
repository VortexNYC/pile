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
  organizationId: string,
  issueId: string
) {
  await db
    .delete(comments)
    .where(
      and(
        eq(comments.organizationId, organizationId),
        eq(comments.issueId, issueId)
      )
    );

  await db
    .delete(issueRelations)
    .where(
      and(
        eq(issueRelations.organizationId, organizationId),
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
        eq(attachments.organizationId, organizationId),
        eq(attachments.issueId, issueId)
      )
    );

  await db
    .delete(issueHistory)
    .where(
      and(
        eq(issueHistory.organizationId, organizationId),
        eq(issueHistory.issueId, issueId)
      )
    );

  await db
    .delete(issueSubscribers)
    .where(
      and(
        eq(issueSubscribers.organizationId, organizationId),
        eq(issueSubscribers.issueId, issueId)
      )
    );

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
