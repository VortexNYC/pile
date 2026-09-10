import { and, eq, isNull } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { importParentLinks } from "./schema.js";

export async function recordImportParentLink(
  db: D1Client,
  organizationId: string,
  jobId: string,
  childId: string,
  parentExternalId: string
) {
  const existing = await db
    .select()
    .from(importParentLinks)
    .where(
      and(
        eq(importParentLinks.jobId, jobId),
        eq(importParentLinks.childId, childId),
        eq(importParentLinks.parentExternalId, parentExternalId)
      )
    )
    .get();
  if (existing) return existing;

  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(importParentLinks).values({
    id,
    organizationId,
    jobId,
    childId,
    parentExternalId,
    createdAt: ts,
    updatedAt: ts,
  });
  return db
    .select()
    .from(importParentLinks)
    .where(eq(importParentLinks.id, id))
    .get();
}

export function findUnresolvedParentLinks(db: D1Client, jobId: string) {
  return db
    .select()
    .from(importParentLinks)
    .where(
      and(
        eq(importParentLinks.jobId, jobId),
        isNull(importParentLinks.resolvedAt)
      )
    )
    .all();
}

export async function resolveImportParentLinks(
  db: D1Client,
  jobId: string,
  findParentVortexId: (parentExternalId: string) => Promise<string | undefined>,
  linkChild: (childId: string, parentVortexId: string) => Promise<void>
): Promise<number> {
  const unresolved = await findUnresolvedParentLinks(db, jobId);
  if (unresolved.length === 0) return 0;

  const resolvedAt = new Date().toISOString();
  const parentIds = await Promise.all(
    unresolved.map(async (row) => ({
      row,
      parentVortexId: await findParentVortexId(row.parentExternalId),
    }))
  );

  const updates = parentIds
    .filter((r): r is { row: typeof r.row; parentVortexId: string } =>
      Boolean(r.parentVortexId)
    )
    .map(async ({ row, parentVortexId }) => {
      try {
        await linkChild(row.childId, parentVortexId);
        await db
          .update(importParentLinks)
          .set({ resolvedAt, updatedAt: resolvedAt })
          .where(eq(importParentLinks.id, row.id));
        return true;
      } catch {
        return false;
      }
    });

  const results = await Promise.all(updates);
  return results.filter(Boolean).length;
}
