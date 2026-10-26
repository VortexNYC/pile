import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "../types/workspace.js";
import type { D1Client } from "./db.js";
import { templates } from "./schema.js";

/** The issue fields a template can stamp — shared by the issue-create
 *  defaults resolver and the triage delegate action (PILE-427). */
export const issueTemplateDataSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    status: z.enum(ISSUE_STATUSES).optional(),
    priority: z.enum(ISSUE_PRIORITIES).optional(),
    estimate: z.number().int().min(0).optional(),
    assigneeId: z.string().optional(),
    delegateId: z.string().optional(),
    projectId: z.string().optional(),
    cycleId: z.string().optional(),
    labelIds: z.string().optional(),
  })
  .partial();

export function listTemplates(db: D1Client, organizationId: string) {
  return db
    .select()
    .from(templates)
    .where(eq(templates.organizationId, organizationId))
    .all();
}

export function getTemplate(db: D1Client, organizationId: string, id: string) {
  return db
    .select()
    .from(templates)
    .where(
      and(eq(templates.organizationId, organizationId), eq(templates.id, id))
    )
    .get();
}

export async function createTemplate(
  db: D1Client,
  organizationId: string,
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
        eq(templates.organizationId, organizationId),
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
    organizationId,
    linearId: values.linearId,
    name: values.name,
    templateData: values.templateData ?? null,
  });
  return db.select().from(templates).where(eq(templates.id, id)).get();
}
