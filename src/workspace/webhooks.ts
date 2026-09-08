import { and, eq, lt, ne } from "drizzle-orm";

import { hmacSha256Hex } from "../global/crypto.js";
import type { AppEnv } from "../types/env.js";
import type { RealtimeEvent } from "../types/workspace.js";
import type { WorkspaceDb } from "./data.js";
import {
  workspaceOutboundWebhookDeliveries,
  workspaceWebhookSubscriptions,
} from "./schema.js";

const MAX_ATTEMPTS = 5;

function retryDelayMs(attemptCount: number): number {
  return Math.min(30_000 * Math.pow(2, attemptCount - 1), 3_600_000);
}

async function buildHeaders(
  env: AppEnv,
  subscription: { secret: string | null },
  payload: string,
  deliveryId: string
): Promise<Record<string, string>> {
  const timestamp = Date.now().toString();
  const secret = subscription.secret || env.WEBHOOK_SECRET || "";
  const signature = secret
    ? `sha256=${await hmacSha256Hex(secret, payload)}`
    : "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Webhook-Event": JSON.parse(payload).type,
    "X-Webhook-Delivery": deliveryId,
    "X-Webhook-Timestamp": timestamp,
  };
  if (signature) {
    headers["X-Webhook-Signature"] = signature;
  }
  return headers;
}

async function attemptDelivery(
  db: WorkspaceDb,
  env: AppEnv,
  row: {
    id: string;
    subscriptionId: string;
    url: string;
    payload: string;
    event: string;
    attemptCount: number;
  }
): Promise<{
  status: "delivered" | "failed";
  statusCode?: number;
  error?: string;
}> {
  const subscription = await db
    .select({ secret: workspaceWebhookSubscriptions.secret })
    .from(workspaceWebhookSubscriptions)
    .where(eq(workspaceWebhookSubscriptions.id, row.subscriptionId))
    .get();

  const headers = await buildHeaders(
    env,
    subscription ?? { secret: null },
    row.payload,
    row.id
  );

  try {
    const res = await fetch(row.url, {
      method: "POST",
      headers,
      body: row.payload,
    });
    const status = res.ok ? ("delivered" as const) : ("failed" as const);
    let error: string | undefined;
    if (!res.ok) {
      const responseText = await res.text().catch(() => "");
      if (responseText) {
        error = responseText.slice(0, 500);
      }
    }
    return { status, statusCode: res.status, error };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function deliverWebhooks(
  db: WorkspaceDb,
  env: AppEnv,
  organizationId: string,
  event: RealtimeEvent
): Promise<{ needsRetry: boolean; retryAt?: number }> {
  const subscriptions = await db
    .select()
    .from(workspaceWebhookSubscriptions)
    .where(eq(workspaceWebhookSubscriptions.organizationId, organizationId))
    .all();

  if (subscriptions.length === 0) {
    return { needsRetry: false };
  }

  const payload = JSON.stringify(event);

  const results = await Promise.all(
    subscriptions
      .filter(
        (sub) =>
          sub.events === "*" || sub.events.split(",").includes(event.type)
      )
      .map(async (sub) => {
        const deliveryId = crypto.randomUUID();
        const ts = new Date().toISOString();
        await db.insert(workspaceOutboundWebhookDeliveries).values({
          id: deliveryId,
          organizationId,
          subscriptionId: sub.id,
          event: event.type,
          payload,
          url: sub.url,
          status: "pending",
          attemptCount: 1,
          createdAt: ts,
          updatedAt: ts,
        });

        const result = await attemptDelivery(db, env, {
          id: deliveryId,
          subscriptionId: sub.id,
          url: sub.url,
          payload,
          event: event.type,
          attemptCount: 1,
        });

        await db
          .update(workspaceOutboundWebhookDeliveries)
          .set({
            status: result.status,
            statusCode: result.statusCode ?? null,
            error: result.error ?? null,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(workspaceOutboundWebhookDeliveries.id, deliveryId));

        return result;
      })
  );

  let needsRetry = false;
  let retryAt: number | undefined;
  for (const result of results) {
    if (result.status !== "delivered") {
      needsRetry = true;
      const candidate = Date.now() + retryDelayMs(1);
      if (retryAt === undefined || candidate < retryAt) {
        retryAt = candidate;
      }
    }
  }

  return { needsRetry, retryAt };
}

export async function retryWebhookDeliveries(
  db: WorkspaceDb,
  env: AppEnv,
  organizationId: string
): Promise<{ hasMore: boolean; retryAt?: number }> {
  const remaining = await db
    .select()
    .from(workspaceOutboundWebhookDeliveries)
    .where(
      and(
        eq(workspaceOutboundWebhookDeliveries.organizationId, organizationId),
        ne(workspaceOutboundWebhookDeliveries.status, "delivered"),
        lt(workspaceOutboundWebhookDeliveries.attemptCount, MAX_ATTEMPTS)
      )
    )
    .all();
  if (remaining.length === 0) {
    return { hasMore: false };
  }

  const results = await Promise.all(
    remaining.map(async (row) => {
      const attemptCount = row.attemptCount + 1;
      await db
        .update(workspaceOutboundWebhookDeliveries)
        .set({ attemptCount })
        .where(eq(workspaceOutboundWebhookDeliveries.id, row.id));

      const result = await attemptDelivery(db, env, {
        id: row.id,
        subscriptionId: row.subscriptionId,
        url: row.url,
        payload: row.payload,
        event: row.event,
        attemptCount,
      });

      await db
        .update(workspaceOutboundWebhookDeliveries)
        .set({
          status: result.status,
          statusCode: result.statusCode ?? null,
          error: result.error ?? null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(workspaceOutboundWebhookDeliveries.id, row.id));

      return { attemptCount, result };
    })
  );

  let hasMore = false;
  let retryAt: number | undefined;
  for (const { attemptCount, result } of results) {
    if (result.status !== "delivered" && attemptCount < MAX_ATTEMPTS) {
      hasMore = true;
      const candidate = Date.now() + retryDelayMs(attemptCount);
      if (retryAt === undefined || candidate < retryAt) {
        retryAt = candidate;
      }
    }
  }

  return { hasMore, retryAt };
}
