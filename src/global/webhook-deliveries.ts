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
