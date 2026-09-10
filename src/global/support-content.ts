import { and, asc, eq } from "drizzle-orm";

import { VortexError } from "../platform/errors.js";
import type { D1Client } from "./db.js";
import { supportSnippets } from "./schema.js";

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
