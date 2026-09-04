import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { outboundWebhookDeliveries, webhookSubscriptions } from "./schema.js";

export function listWebhookSubscriptions(db: D1Client, organizationId: string) {
  return db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.organizationId, organizationId))
    .all();
}

export function getWebhookSubscription(db: D1Client, id: string) {
  return db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, id))
    .get();
}

export function findWebhookSubscriptionByWorkspace(
  db: D1Client,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(webhookSubscriptions)
    .where(
      and(
        eq(webhookSubscriptions.id, id),
        eq(webhookSubscriptions.organizationId, organizationId)
      )
    )
    .get();
}

export async function createWebhookSubscription(
  db: D1Client,
  organizationId: string,
  values: {
    url: string;
    events?: string;
    secret?: string;
  }
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(webhookSubscriptions).values({
    id,
    organizationId,
    url: values.url,
    events: values.events ?? "*",
    secret: values.secret ?? "",
    createdAt: ts,
  });
  return getWebhookSubscription(db, id);
}

export async function updateWebhookSubscription(
  db: D1Client,
  organizationId: string,
  id: string,
  values: {
    url?: string;
    events?: string;
    secret?: string;
  }
) {
  const existing = await findWebhookSubscriptionByWorkspace(
    db,
    organizationId,
    id
  );
  if (!existing) return null;

  const update: Record<string, string | null> = {};
  if (values.url !== undefined) update.url = values.url;
  if (values.events !== undefined) update.events = values.events;
  if (values.secret !== undefined) update.secret = values.secret;

  if (Object.keys(update).length === 0) return existing;

  await db
    .update(webhookSubscriptions)
    .set(update)
    .where(eq(webhookSubscriptions.id, id));
  return getWebhookSubscription(db, id);
}

export async function deleteWebhookSubscription(
  db: D1Client,
  organizationId: string,
  id: string
) {
  const existing = await findWebhookSubscriptionByWorkspace(
    db,
    organizationId,
    id
  );
  if (!existing) return false;

  await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
  return true;
}

export function listWebhookDeliveries(
  db: D1Client,
  organizationId: string,
  subscriptionId: string
) {
  return db
    .select()
    .from(outboundWebhookDeliveries)
    .where(
      and(
        eq(outboundWebhookDeliveries.organizationId, organizationId),
        eq(outboundWebhookDeliveries.subscriptionId, subscriptionId)
      )
    )
    .all();
}
