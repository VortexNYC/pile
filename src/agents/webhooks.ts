import { eq } from "drizzle-orm";
import { createD1 } from "../global/db.js";
import { webhookSubscriptions } from "../global/schema.js";
import { hmacSha256Hex } from "../platform/crypto.js";
import type { AppEnv } from "../platform/env.js";
import type { RealtimeEvent } from "../workspace/types.js";

export async function deliverWebhooks(
  env: AppEnv,
  workspaceId: string,
  event: RealtimeEvent
): Promise<void> {
  if (!env.WEBHOOK_SECRET) {
    return;
  }

  const db = createD1(env.D1);
  const subscriptions = await db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.workspaceId, workspaceId))
    .all();

  if (subscriptions.length === 0) return;

  const body = JSON.stringify(event);
  const signature = `sha256=${await hmacSha256Hex(env.WEBHOOK_SECRET, body)}`;
  const headers = {
    "Content-Type": "application/json",
    "X-Webhook-Signature": signature,
    "X-Webhook-Event": event.type,
  };

  for (const sub of subscriptions) {
    if (sub.events !== "*" && !sub.events.split(",").includes(event.type)) {
      continue;
    }

    fetch(sub.url, {
      method: "POST",
      headers,
      body,
    }).catch((err) => {
      console.error("webhook delivery failed", { url: sub.url, err });
    });
  }
}
