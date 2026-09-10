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
  await db.insert(intercomConversations).values({
    id,
    organizationId,
    conversationId,
    issueId,
  });
  return { id, organizationId, conversationId, issueId };
}
