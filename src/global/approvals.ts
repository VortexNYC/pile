import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { issueApprovals } from "./schema.js";

export type IssueApproval = typeof issueApprovals.$inferSelect;

export async function createIssueApproval(
  db: D1Client,
  organizationId: string,
  input: {
    issueId: string;
    requestedById: string;
    approverId: string;
    comment?: string;
  }
) {
  const id = crypto.randomUUID();
  await db.insert(issueApprovals).values({
    id,
    organizationId,
    issueId: input.issueId,
    requestedById: input.requestedById,
    approverId: input.approverId,
    status: "pending",
    comment: input.comment ?? null,
  });
  const row = await db
    .select()
    .from(issueApprovals)
    .where(eq(issueApprovals.id, id))
    .get();
  if (!row) {
    throw new Error("Failed to create approval");
  }
  return row;
}

export function listIssueApprovals(
  db: D1Client,
  organizationId: string,
  issueId: string
) {
  return db
    .select()
    .from(issueApprovals)
    .where(
      and(
        eq(issueApprovals.organizationId, organizationId),
        eq(issueApprovals.issueId, issueId)
      )
    )
    .all();
}

export function getIssueApproval(
  db: D1Client,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(issueApprovals)
    .where(
      and(
        eq(issueApprovals.organizationId, organizationId),
        eq(issueApprovals.id, id)
      )
    )
    .get();
}

export async function resolveIssueApproval(
  db: D1Client,
  organizationId: string,
  id: string,
  status: "approved" | "rejected"
) {
  await db
    .update(issueApprovals)
    .set({ status, resolvedAt: new Date().toISOString() })
    .where(
      and(
        eq(issueApprovals.organizationId, organizationId),
        eq(issueApprovals.id, id)
      )
    );
  return getIssueApproval(db, organizationId, id);
}
