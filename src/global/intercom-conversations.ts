import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { intercomConversations } from "./schema.js";

export function findIntercomConversation(
  db: D1Client,
  organizationId: string,
  conversationId: string
) {
  return db
    .select()
    .from(intercomConversations)
    .where(
      and(
        eq(intercomConversations.organizationId, organizationId),
        eq(intercomConversations.conversationId, conversationId)
      )
    )
    .get();
}

export async function createIntercomConversation(
  db: D1Client,
  organizationId: string,
  conversationId: string,
  issueId: string
) {
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(intercomConversations)
    .values({ id, organizationId, conversationId, issueId })
    .onConflictDoNothing({
      target: [
        intercomConversations.organizationId,
        intercomConversations.conversationId,
      ],
    })
    .returning()
    .get();
  if (inserted) return inserted;
  const existing = await findIntercomConversation(
    db,
    organizationId,
    conversationId
  );
  if (existing) return existing;
  throw new Error("Failed to create Intercom conversation mapping");
}
