import { eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { importApprovals } from "./schema.js";

export type ImportApprovalStatus = "pending" | "approved" | "rejected";

export async function createImportApproval(
  db: D1Client,
  organizationId: string,
  jobId: string,
  requestedBy: string
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(importApprovals).values({
    id,
    organizationId,
    jobId,
    status: "pending",
    requestedBy,
    createdAt: ts,
    updatedAt: ts,
  });
  return db
    .select()
    .from(importApprovals)
    .where(eq(importApprovals.id, id))
    .get();
}

export function findImportApprovalByJobId(db: D1Client, jobId: string) {
  return db
    .select()
    .from(importApprovals)
    .where(eq(importApprovals.jobId, jobId))
    .get();
}

export async function updateImportApprovalStatus(
  db: D1Client,
  jobId: string,
  status: ImportApprovalStatus,
  actorId: string
) {
  const existing = await findImportApprovalByJobId(db, jobId);
  if (!existing) {
    throw new Error("Import approval not found");
  }
  await db
    .update(importApprovals)
    .set({
      status,
      approvedBy: status === "approved" ? actorId : existing.approvedBy,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(importApprovals.id, existing.id));
  return db
    .select()
    .from(importApprovals)
    .where(eq(importApprovals.id, existing.id))
    .get();
}
