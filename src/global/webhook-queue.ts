import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { VortexError } from "../platform/errors.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { createD1, type D1Client } from "./db.js";
import { webhookDeliveries } from "./schema.js";

export type WebhookSource =
  | "intercom"
  | "intercom-agent"
  | "github"
  | "slack"
  | "zendesk"
  | "plain"
  | "jam"
  | "jam-intercom-recorded"
  | "jam-intercom-opted-out"
  | "jam-recording-link";

export interface WebhookQueueMessage {
  deliveryId: string;
}

const webhookQueueMessageSchema = z.object({
  deliveryId: z.string(),
});

export interface EnqueueWebhookInput {
  deliveryId?: string;
  source: WebhookSource;
  event: string;
  organizationId?: string;
  payload: unknown;
}

export type WebhookProcessor = (
  db: D1Client,
  env: WorkerEnv,
  payload: unknown
) => Promise<void>;

const MAX_WEBHOOK_ATTEMPTS = 3;
const PROCESSING_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

type WebhookDeliveryStatus = "pending" | "processing" | "completed" | "failed";

export interface WebhookDeliveryRow {
  deliveryId: string;
  source: string;
  event: string;
  organizationId: string | null;
  processedAt: string;
  status: WebhookDeliveryStatus;
  attemptCount: number;
  payload: string | null;
  lastError: string | null;
  nextRetryAt: string | null;
  lockedAt: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function enqueueWebhook(
  db: D1Client,
  env: WorkerEnv,
  input: EnqueueWebhookInput,
  processors?: Map<WebhookSource, WebhookProcessor>
): Promise<{ deliveryId: string }> {
  const deliveryId = input.deliveryId ?? crypto.randomUUID();
  const payloadText =
    input.payload === undefined ? null : JSON.stringify(input.payload);

  const inserted = await db
    .insert(webhookDeliveries)
    .values({
      deliveryId,
      source: input.source,
      event: input.event,
      organizationId: input.organizationId ?? null,
      status: "pending",
      attemptCount: 0,
      payload: payloadText,
    })
    .onConflictDoNothing()
    .returning()
    .get();

  if (inserted === undefined) {
    return { deliveryId };
  }

  if (env.WEBHOOK_QUEUE) {
    await env.WEBHOOK_QUEUE.send({ deliveryId } satisfies WebhookQueueMessage);
  } else if (processors) {
    await processWebhookDeliveryById(db, env, deliveryId, processors);
  } else {
    throw new VortexError({
      code: "CONFIG_ERROR",
      status: 500,
      message:
        "WEBHOOK_QUEUE is not configured and no inline processors provided",
    });
  }

  return { deliveryId };
}

export async function startWebhookDelivery(
  db: D1Client,
  deliveryId: string
): Promise<WebhookDeliveryRow | null> {
  const lockedAt = nowIso();

  const [row] = await db
    .update(webhookDeliveries)
    .set({
      status: "processing",
      attemptCount: sql`${webhookDeliveries.attemptCount} + 1`,
      lockedAt,
    })
    .where(
      and(
        eq(webhookDeliveries.deliveryId, deliveryId),
        eq(webhookDeliveries.status, "pending")
      )
    )
    .returning();

  if (!row) {
    return null;
  }

  return row as unknown as WebhookDeliveryRow;
}

export async function completeWebhookDelivery(
  db: D1Client,
  deliveryId: string
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({ status: "completed", lastError: null, nextRetryAt: null })
    .where(eq(webhookDeliveries.deliveryId, deliveryId));
}

export async function failWebhookDelivery(
  db: D1Client,
  deliveryId: string,
  error: unknown,
  attemptCount: number
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  if (attemptCount >= MAX_WEBHOOK_ATTEMPTS) {
    await db
      .update(webhookDeliveries)
      .set({ status: "failed", lastError: message, nextRetryAt: null })
      .where(eq(webhookDeliveries.deliveryId, deliveryId));
  } else {
    await db
      .update(webhookDeliveries)
      .set({
        status: "pending",
        lastError: message,
        nextRetryAt: nowIso(),
      })
      .where(eq(webhookDeliveries.deliveryId, deliveryId));
  }
}

export async function reprocessStuckDeliveries(
  db: D1Client,
  env: WorkerEnv
): Promise<void> {
  const deadline = new Date(
    Date.now() - PROCESSING_LOCK_TIMEOUT_MS
  ).toISOString();

  const stuck = await db
    .select({ deliveryId: webhookDeliveries.deliveryId })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, "processing"),
        sql`${webhookDeliveries.lockedAt} < ${deadline}`
      )
    )
    .all();

  await Promise.all(
    stuck.map(async (row) => {
      await db
        .update(webhookDeliveries)
        .set({ status: "pending", lockedAt: null })
        .where(eq(webhookDeliveries.deliveryId, row.deliveryId));
      if (env.WEBHOOK_QUEUE) {
        await env.WEBHOOK_QUEUE.send({ deliveryId: row.deliveryId });
      }
    })
  );
}

export async function processWebhookQueueBatch(
  batch: MessageBatch,
  env: WorkerEnv,
  processors: Map<WebhookSource, WebhookProcessor>
): Promise<void> {
  const db = createD1(env.D1);

  await Promise.all(
    batch.messages.map(async (message) => {
      const parse = webhookQueueMessageSchema.safeParse(message.body);
      if (!parse.success) {
        message.ack();
        return;
      }
      const deliveryId = parse.data.deliveryId;
      const delivery = await startWebhookDelivery(db, deliveryId);

      if (!delivery) {
        message.ack();
        return;
      }

      try {
        await processWebhookDelivery(db, env, delivery, processors);
        await completeWebhookDelivery(db, deliveryId);
        message.ack();
      } catch (error) {
        await failWebhookDelivery(db, deliveryId, error, delivery.attemptCount);
        if (delivery.attemptCount >= MAX_WEBHOOK_ATTEMPTS) {
          message.ack();
        } else {
          message.retry();
        }
      }
    })
  );
}

export async function processWebhookDeliveryById(
  db: D1Client,
  env: WorkerEnv,
  deliveryId: string,
  processors: Map<WebhookSource, WebhookProcessor>
): Promise<void> {
  const delivery = await startWebhookDelivery(db, deliveryId);
  if (!delivery) {
    return;
  }

  try {
    await processWebhookDelivery(db, env, delivery, processors);
    await completeWebhookDelivery(db, deliveryId);
  } catch (error) {
    await failWebhookDelivery(db, deliveryId, error, delivery.attemptCount);
    throw error;
  }
}

async function processWebhookDelivery(
  db: D1Client,
  env: WorkerEnv,
  delivery: WebhookDeliveryRow,
  processors: Map<WebhookSource, WebhookProcessor>
): Promise<void> {
  const source = delivery.source as WebhookSource;
  const processor = processors.get(source);

  if (!processor) {
    throw new VortexError({
      code: "CONFIG_ERROR",
      status: 500,
      message: `Webhook source ${source} is not queued yet`,
    });
  }

  const payload = delivery.payload ? JSON.parse(delivery.payload) : null;
  await processor(db, env, payload);
}
