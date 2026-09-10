import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { importMappings } from "./schema.js";

export type ImportMappingType =
  | "issue"
  | "document"
  | "state"
  | "label"
  | "project"
  | "cycle"
  | "user"
  | "team"
  | "template";

export async function recordImportMapping(
  db: D1Client,
  organizationId: string,
  jobId: string,
  source: string,
  type: ImportMappingType,
  externalId: string,
  vortexId: string
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db
    .insert(importMappings)
    .values({
      id,
      organizationId,
      jobId,
      source,
      type,
      externalId,
      vortexId,
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: [importMappings.jobId, importMappings.externalId],
      set: {
        vortexId,
        source,
        type,
        updatedAt: ts,
      },
    });
  return db
    .select()
    .from(importMappings)
    .where(eq(importMappings.id, id))
    .get();
}

export async function findImportMapping(
  db: D1Client,
  jobId: string,
  externalId: string
) {
  return db
    .select()
    .from(importMappings)
    .where(
      and(
        eq(importMappings.jobId, jobId),
        eq(importMappings.externalId, externalId)
      )
    )
    .get();
}

export async function findImportMappingsByJob(db: D1Client, jobId: string) {
  return db
    .select()
    .from(importMappings)
    .where(eq(importMappings.jobId, jobId))
    .all();
}
