import { eq } from "drizzle-orm";

import { hmacSha256Hex } from "../global/crypto.js";
import { createD1 } from "../global/db.js";
import {
  outboundWebhookDeliveries,
  webhookSubscriptions,
} from "../global/schema.js";
import type { AppEnv } from "../types/env.js";
import type { RealtimeEvent } from "../types/workspace.js";

export async function deliverWebhooks(
  env: AppEnv,
  workspaceId: string,
  event: RealtimeEvent
): Promise<void> {
  const db = createD1(env.D1);
  const subscriptions = await db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.workspaceId, workspaceId))
    .all();

  if (subscriptions.length === 0) return;

  const body = JSON.stringify(event);
  const timestamp = Date.now().toString();

  for (const sub of subscriptions) {
    if (sub.events !== "*" && !sub.events.split(",").includes(event.type)) {
      continue;
    }

    const deliveryId = crypto.randomUUID();
    const secret = sub.secret || env.WEBHOOK_SECRET || "";
    const signature = secret
      ? `sha256=${await hmacSha256Hex(secret, body)}`
      : "";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Webhook-Event": event.type,
      "X-Webhook-Delivery": deliveryId,
      "X-Webhook-Timestamp": timestamp,
    };
    if (signature) {
      headers["X-Webhook-Signature"] = signature;
    }
    let status = "pending";
    let statusCode: number | null = null;
    let error: string | null = null;

    await db.insert(outboundWebhookDeliveries).values({
      id: deliveryId,
      workspaceId,
      subscriptionId: sub.id,
      event: event.type,
      url: sub.url,
      status,
      statusCode,
      error,
      attemptCount: 1,
    });

    try {
      const res = await fetch(sub.url, {
        method: "POST",
        headers,
        body,
      });
      status = res.ok ? "delivered" : "failed";
      statusCode = res.status;
      const responseText = await res.text().catch(() => "");
      if (!res.ok && responseText) {
        error = responseText.slice(0, 500);
      }
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? err.message : String(err);
    }

    await db
      .update(outboundWebhookDeliveries)
      .set({
        status,
        statusCode,
        error,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(outboundWebhookDeliveries.id, deliveryId));
  }
}
