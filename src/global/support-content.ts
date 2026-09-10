import { and, asc, eq } from "drizzle-orm";

import { VortexError } from "../platform/errors.js";
import type { D1Client } from "./db.js";
import { supportAutoresponders, supportSnippets } from "./schema.js";

export type SupportSnippet = {
  id: string;
  organizationId: string;
  name: string;
  textContent: string;
  markdownContent: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SupportSnippetInput = {
  organizationId: string;
  name: string;
  textContent: string;
  markdownContent?: string | null;
};

export async function createSupportSnippet(
  db: D1Client,
  input: SupportSnippetInput
): Promise<SupportSnippet> {
  const existing = await db
    .select({ id: supportSnippets.id })
    .from(supportSnippets)
    .where(
      and(
        eq(supportSnippets.organizationId, input.organizationId),
        eq(supportSnippets.name, input.name)
      )
    )
    .get();

  if (existing) {
    throw VortexError.fromCode(
      "BAD_REQUEST",
      "A snippet with this name already exists in this workspace"
    );
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const markdownContent = input.markdownContent ?? null;

  await db.insert(supportSnippets).values({
    id,
    organizationId: input.organizationId,
    name: input.name,
    textContent: input.textContent,
    markdownContent,
    createdAt: now,
    updatedAt: now,
  });

  return {
    id,
    organizationId: input.organizationId,
    name: input.name,
    textContent: input.textContent,
    markdownContent,
    createdAt: now,
    updatedAt: now,
  };
}

export async function listSupportSnippets(
  db: D1Client,
  organizationId: string
): Promise<SupportSnippet[]> {
  return db
    .select()
    .from(supportSnippets)
    .where(eq(supportSnippets.organizationId, organizationId))
    .orderBy(asc(supportSnippets.name))
    .all();
}

export type SupportAutoresponder = {
  id: string;
  organizationId: string;
  name: string;
  enabled: boolean;
  trigger: "ticket_created" | "customer_replied" | "out_of_hours";
  order: number;
  snippetId: string | null;
  conditions: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export type SupportAutoresponderInput = {
  organizationId: string;
  name: string;
  enabled?: boolean;
  trigger: "ticket_created" | "customer_replied" | "out_of_hours";
  order: number;
  snippetId?: string | null;
  conditions?: Record<string, string>;
};

export async function createSupportAutoresponder(
  db: D1Client,
  input: SupportAutoresponderInput
): Promise<SupportAutoresponder> {
  if (input.snippetId) {
    const snippet = await db
      .select({ id: supportSnippets.id })
      .from(supportSnippets)
      .where(
        and(
          eq(supportSnippets.organizationId, input.organizationId),
          eq(supportSnippets.id, input.snippetId)
        )
      )
      .get();

    if (!snippet) {
      throw VortexError.fromCode(
        "BAD_REQUEST",
        "Snippet not found in this workspace"
      );
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const conditions = input.conditions ?? {};
  const enabled = input.enabled ?? true;
  const snippetId = input.snippetId ?? null;

  await db.insert(supportAutoresponders).values({
    id,
    organizationId: input.organizationId,
    name: input.name,
    enabled,
    trigger: input.trigger,
    order: input.order,
    snippetId,
    conditions: JSON.stringify(conditions),
    createdAt: now,
    updatedAt: now,
  });

  return {
    id,
    organizationId: input.organizationId,
    name: input.name,
    enabled,
    trigger: input.trigger,
    order: input.order,
    snippetId,
    conditions,
    createdAt: now,
    updatedAt: now,
  };
}

export async function listSupportAutoresponders(
  db: D1Client,
  organizationId: string
): Promise<SupportAutoresponder[]> {
  const rows = await db
    .select()
    .from(supportAutoresponders)
    .where(eq(supportAutoresponders.organizationId, organizationId))
    .orderBy(asc(supportAutoresponders.order), asc(supportAutoresponders.name))
    .all();

  return rows.map((row) => {
    let conditions: Record<string, string> = {};
    try {
      const parsed = JSON.parse(row.conditions);
      if (typeof parsed === "object" && parsed !== null) {
        conditions = parsed as Record<string, string>;
      }
    } catch {
      conditions = {};
    }
    return {
      id: row.id,
      organizationId: row.organizationId,
      name: row.name,
      enabled: row.enabled,
      trigger: row.trigger,
      order: row.order,
      snippetId: row.snippetId,
      conditions,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}
