import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { importJobs } from "./schema.js";

export type ImportJobStatus =
  | "pending"
  | "pending_approval"
  | "running"
  | "completed"
  | "failed"
  | "paused";

export type ImportJobRecord = {
  id: string;
  organizationId: string;
  source: string;
  status: ImportJobStatus;
  options: string | null;
  counts: string | null;
  cursor: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export async function createImportJob(
  db: D1Client,
  organizationId: string,
  source: string,
  options: unknown
): Promise<ImportJobRecord> {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  const optionsJson = JSON.stringify(options);
  await db.insert(importJobs).values({
    id,
    organizationId,
    source,
    status: "pending",
    options: optionsJson,
    counts: null,
    cursor: null,
    error: null,
    createdAt: ts,
    updatedAt: ts,
    completedAt: null,
  });
  const row = await db
    .select()
    .from(importJobs)
    .where(eq(importJobs.id, id))
    .get();
  if (!row) {
    throw new Error("Failed to create import job");
  }
  return row as ImportJobRecord;
}

export function findImportJob(
  db: D1Client,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(importJobs)
    .where(
      and(eq(importJobs.organizationId, organizationId), eq(importJobs.id, id))
    )
    .get();
}

export async function updateImportJobStatus(
  db: D1Client,
  id: string,
  status: ImportJobStatus,
  updates: Partial<
    Pick<ImportJobRecord, "counts" | "cursor" | "error" | "completedAt">
  > = {}
) {
  const row = await db
    .select()
    .from(importJobs)
    .where(eq(importJobs.id, id))
    .get();
  if (!row) {
    throw new Error("Import job not found");
  }
  const set: Record<string, string | null> = {
    updatedAt: new Date().toISOString(),
    status,
  };
  if (updates.counts !== undefined) {
    set.counts = updates.counts === null ? null : updates.counts;
  }
  if (updates.cursor !== undefined) {
    set.cursor = updates.cursor === null ? null : updates.cursor;
  }
  if (updates.error !== undefined) {
    set.error = updates.error === null ? null : updates.error;
  }
  if (updates.completedAt !== undefined) {
    set.completedAt = updates.completedAt === null ? null : updates.completedAt;
  }
  await db.update(importJobs).set(set).where(eq(importJobs.id, id));
  return db.select().from(importJobs).where(eq(importJobs.id, id)).get();
}
