import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { reactions } from "./schema.js";

interface CreateReactionInput {
  organizationId: string;
  targetType: string;
  targetId: string;
  actorId: string;
  emoji: string;
}

export async function createReaction(db: D1Client, input: CreateReactionInput) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(reactions).values({
    id,
    organizationId: input.organizationId,
    targetType: input.targetType,
    targetId: input.targetId,
    actorId: input.actorId,
    emoji: input.emoji,
    createdAt: now,
    updatedAt: now,
  });
  return db
    .select()
    .from(reactions)
    .where(
      and(
        eq(reactions.id, id),
        eq(reactions.organizationId, input.organizationId)
      )
    )
    .get();
}

export function listReactions(
  db: D1Client,
  organizationId: string,
  targetType: string,
  targetId: string
) {
  return db
    .select()
    .from(reactions)
    .where(
      and(
        eq(reactions.organizationId, organizationId),
        eq(reactions.targetType, targetType),
        eq(reactions.targetId, targetId)
      )
    )
    .all();
}

export function getReaction(db: D1Client, organizationId: string, id: string) {
  return db
    .select()
    .from(reactions)
    .where(
      and(eq(reactions.organizationId, organizationId), eq(reactions.id, id))
    )
    .get();
}

export async function deleteReaction(
  db: D1Client,
  organizationId: string,
  id: string
) {
  const result = await db
    .delete(reactions)
    .where(
      and(eq(reactions.organizationId, organizationId), eq(reactions.id, id))
    )
    .returning()
    .get();
  return !!result;
}
