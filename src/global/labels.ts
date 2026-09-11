import { and, asc, eq, inArray } from "drizzle-orm";

import { VortexError } from "../platform/errors.js";
import type { D1Client } from "./db.js";
import { labels } from "./schema.js";

export function findLabelsByWorkspaceAndNames(
  db: D1Client,
  organizationId: string,
  names: string[]
) {
  if (names.length === 0) {
    return Promise.resolve([]);
  }
  return db
    .select({ id: labels.id })
    .from(labels)
    .where(
      and(
        eq(labels.organizationId, organizationId),
        inArray(labels.name, names)
      )
    )
    .all();
}

export type SupportLabel = {
  id: string;
  organizationId: string;
  name: string;
  color: string | null;
  kind: "support";
  createdAt: string;
  updatedAt: string;
};

export type SupportLabelInput = {
  organizationId: string;
  name: string;
  color?: string | null;
};

export async function createSupportLabel(
  db: D1Client,
  input: SupportLabelInput
): Promise<SupportLabel> {
  const existing = await db
    .select({ id: labels.id })
    .from(labels)
    .where(
      and(
        eq(labels.organizationId, input.organizationId),
        eq(labels.name, input.name),
        eq(labels.kind, "support")
      )
    )
    .get();

  if (existing) {
    throw VortexError.fromCode(
      "BAD_REQUEST",
      "A support label with this name already exists in this workspace"
    );
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const color = input.color ?? null;

  await db.insert(labels).values({
    id,
    organizationId: input.organizationId,
    name: input.name,
    color,
    kind: "support",
    createdAt: now,
    updatedAt: now,
  });

  return {
    id,
    organizationId: input.organizationId,
    name: input.name,
    color,
    kind: "support",
    createdAt: now,
    updatedAt: now,
  };
}

export async function listSupportLabels(
  db: D1Client,
  organizationId: string
): Promise<SupportLabel[]> {
  const rows = await db
    .select()
    .from(labels)
    .where(
      and(eq(labels.organizationId, organizationId), eq(labels.kind, "support"))
    )
    .orderBy(asc(labels.name))
    .all();

  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    color: row.color,
    kind: "support" as const,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}
