import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { templates } from "./schema.js";

export function listTemplates(db: D1Client, workspaceId: string) {
  return db
    .select()
    .from(templates)
    .where(eq(templates.workspaceId, workspaceId))
    .all();
}

export function getTemplate(db: D1Client, workspaceId: string, id: string) {
  return db
    .select()
    .from(templates)
    .where(and(eq(templates.workspaceId, workspaceId), eq(templates.id, id)))
    .get();
}

export async function createTemplate(
  db: D1Client,
  workspaceId: string,
  values: {
    linearId: string;
    name: string;
    templateData?: string | null;
  }
) {
  const existing = await db
    .select()
    .from(templates)
    .where(
      and(
        eq(templates.workspaceId, workspaceId),
        eq(templates.linearId, values.linearId)
      )
    )
    .get();
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID();
  await db.insert(templates).values({
    id,
    workspaceId,
    linearId: values.linearId,
    name: values.name,
    templateData: values.templateData ?? null,
  });
  return db.select().from(templates).where(eq(templates.id, id)).get();
}
