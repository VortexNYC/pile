import { eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { webhookDeliveries } from "./schema.js";

export function findWebhookDelivery(db: D1Client, deliveryId: string) {
  return db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.deliveryId, deliveryId))
    .get();
}

export async function recordWebhookDelivery(
  db: D1Client,
  deliveryId: string,
  source: string,
  event: string,
  workspaceId?: string
): Promise<void> {
  await db
    .insert(webhookDeliveries)
    .values({
      deliveryId,
      source,
      event,
      workspaceId: workspaceId ?? null,
    })
    .onConflictDoNothing();
}
