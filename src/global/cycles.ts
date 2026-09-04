import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { cycles } from "./schema.js";

export async function findOrCreateCycleByName(
  db: D1Client,
  organizationId: string,
  name: string
) {
  const existing = await db
    .select({ id: cycles.id })
    .from(cycles)
    .where(
      and(eq(cycles.organizationId, organizationId), eq(cycles.name, name))
    )
    .get();
  if (existing) {
    return existing.id;
  }

  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(cycles).values({
    id,
    organizationId,
    projectId: null,
    name,
    startDate: null,
    endDate: null,
    createdAt: ts,
    updatedAt: ts,
  });
  return id;
}
