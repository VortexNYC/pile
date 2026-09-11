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

export async function claimWebhookDelivery(
  db: D1Client,
  deliveryId: string,
  source: string,
  event: string,
  organizationId?: string
): Promise<boolean> {
  const inserted = await db
    .insert(webhookDeliveries)
    .values({
      deliveryId,
      source,
      event,
      organizationId: organizationId ?? null,
      status: "completed",
      attemptCount: 1,
    })
    .onConflictDoNothing()
    .returning()
    .get();
  return inserted !== undefined;
}

export async function recordWebhookDelivery(
  db: D1Client,
  deliveryId: string,
  source: string,
  event: string,
  organizationId?: string
): Promise<void> {
  await db
    .insert(webhookDeliveries)
    .values({
      deliveryId,
      source,
      event,
      organizationId: organizationId ?? null,
      status: "completed",
      attemptCount: 1,
    })
    .onConflictDoUpdate({
      target: webhookDeliveries.deliveryId,
      set: { organizationId: organizationId ?? null },
    });
}
