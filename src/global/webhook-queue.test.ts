import { createMessageBatch, env } from "cloudflare:test";
import { count, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "./db.js";
import { webhookDeliveries } from "./schema.js";
import {
  enqueueWebhook,
  processWebhookQueueBatch,
  reprocessStuckDeliveries,
  startWebhookDelivery,
  type WebhookProcessor,
  type WebhookQueueMessage,
} from "./webhook-queue.js";

// Route-level webhook tests exercise the inline fallback; queue behavior tests
// drive the state machine directly so they do not depend on a live Queue binding.
env.WEBHOOK_QUEUE = null as unknown as typeof env.WEBHOOK_QUEUE;

const throwingProcessor: WebhookProcessor = async () => {
  throw new Error("boom");
};

const neverCalledProcessor: WebhookProcessor = async () => {
  throw new Error("should not run");
};

const noopProcessor: WebhookProcessor = async () => {};

function makeQueueFake() {
  const sent: WebhookQueueMessage[] = [];
  const queue = {
    send: async (body: WebhookQueueMessage) => {
      sent.push(body);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    sendBatch: async () => ({
      metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    }),
    metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
  } as unknown as typeof env.WEBHOOK_QUEUE;
  return { queue, sent };
}

describe("webhook queue state machine", () => {
  beforeAll(() => {
    env.WEBHOOK_QUEUE = null as unknown as typeof env.WEBHOOK_QUEUE;
  });

  it("enqueueWebhook writes a pending delivery row", async () => {
    const db = createD1(env.D1);
    const { deliveryId } = await enqueueWebhook(
      db,
      env,
      {
        source: "intercom",
        event: "conversation.user.created",
        payload: { test: true },
      },
      new Map<string, WebhookProcessor>([["intercom", () => Promise.resolve()]])
    );
    const row = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, deliveryId))
      .get();
    expect(row?.status).toBe("completed");
    expect(row?.attemptCount).toBe(1);
  });

  it("enqueueWebhook deduplicates identical delivery ids", async () => {
    const db = createD1(env.D1);
    const { queue, sent } = makeQueueFake();
    env.WEBHOOK_QUEUE = queue;
    const input = {
      deliveryId: "dedup-delivery",
      source: "intercom" as const,
      event: "conversation.user.created",
      payload: { test: true },
    };

    const first = await enqueueWebhook(db, env, input);
    const second = await enqueueWebhook(db, env, input, new Map());

    expect(first.deliveryId).toBe("dedup-delivery");
    expect(second.deliveryId).toBe("dedup-delivery");
    expect(sent.length).toBe(1);

    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, "dedup-delivery"));
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("pending");
  });

  it("processWebhookQueueBatch completes a valid message", async () => {
    const db = createD1(env.D1);
    const deliveryId = "complete-delivery";
    let processed: unknown;
    const processor: WebhookProcessor = async (_db, _env, payload) => {
      processed = payload;
    };
    await db.insert(webhookDeliveries).values({
      deliveryId,
      source: "intercom",
      event: "conversation.user.created",
      status: "pending",
      attemptCount: 0,
      payload: JSON.stringify({ hello: "world" }),
    });

    const batch = createMessageBatch("webhook-queue", [
      {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        attempts: 1,
        body: { deliveryId },
      },
    ]);
    await processWebhookQueueBatch(
      batch,
      env,
      new Map([["intercom", processor]])
    );

    expect(processed).toEqual({ hello: "world" });
    const row = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, deliveryId))
      .get();
    expect(row?.status).toBe("completed");
  });

  it("processWebhookQueueBatch deduplicates messages for the same delivery", async () => {
    const db = createD1(env.D1);
    const deliveryId = "same-delivery";
    let callCount = 0;
    const processor: WebhookProcessor = async () => {
      callCount++;
    };
    await db.insert(webhookDeliveries).values({
      deliveryId,
      source: "intercom",
      event: "conversation.user.created",
      status: "pending",
      attemptCount: 0,
      payload: JSON.stringify({}),
    });

    const batch = createMessageBatch("webhook-queue", [
      {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        attempts: 1,
        body: { deliveryId },
      },
      {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        attempts: 1,
        body: { deliveryId },
      },
    ]);
    await processWebhookQueueBatch(
      batch,
      env,
      new Map([["intercom", processor]])
    );

    expect(callCount).toBe(1);
  });

  it("processWebhookQueueBatch acks malformed messages", async () => {
    const db = createD1(env.D1);
    const before = await db
      .select({ count: count() })
      .from(webhookDeliveries)
      .get();

    const batch = createMessageBatch("webhook-queue", [
      {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        attempts: 1,
        body: { notDeliveryId: "x" },
      },
    ]);
    await processWebhookQueueBatch(
      batch,
      env,
      new Map([["intercom", neverCalledProcessor]])
    );

    const after = await db
      .select({ count: count() })
      .from(webhookDeliveries)
      .get();
    expect(after?.count).toBe(before?.count);
  });

  it("processWebhookQueueBatch retries and then dead-letters a failing processor", async () => {
    const db = createD1(env.D1);
    const deliveryId = "fail-delivery";
    await db.insert(webhookDeliveries).values({
      deliveryId,
      source: "intercom",
      event: "conversation.user.created",
      status: "pending",
      attemptCount: 0,
      payload: JSON.stringify({}),
    });

    for (let i = 0; i < 3; i++) {
      const batch = createMessageBatch("webhook-queue", [
        {
          id: crypto.randomUUID(),
          timestamp: new Date(),
          attempts: i + 1,
          body: { deliveryId },
        },
      ]);
      await processWebhookQueueBatch(
        batch,
        env,
        new Map([["intercom", throwingProcessor]])
      );
    }

    const row = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, deliveryId))
      .get();
    expect(row?.status).toBe("failed");
    expect(row?.attemptCount).toBe(3);
    expect(row?.lastError).toBe("boom");
  });

  it("startWebhookDelivery returns null for a completed delivery", async () => {
    const db = createD1(env.D1);
    const deliveryId = "completed-delivery";
    await db.insert(webhookDeliveries).values({
      deliveryId,
      source: "intercom",
      event: "conversation.user.created",
      status: "completed",
      attemptCount: 1,
      payload: JSON.stringify({}),
    });
    const claimed = await startWebhookDelivery(db, deliveryId);
    expect(claimed).toBeNull();
  });

  it("reprocessStuckDeliveries recovers a stale processing row", async () => {
    const db = createD1(env.D1);
    const deliveryId = "stuck-delivery";
    await db.insert(webhookDeliveries).values({
      deliveryId,
      source: "intercom",
      event: "conversation.user.created",
      status: "processing",
      attemptCount: 1,
      lockedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      payload: JSON.stringify({}),
    });

    await reprocessStuckDeliveries(db, env);

    const row = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, deliveryId))
      .get();
    expect(row?.status).toBe("pending");
    expect(row?.lockedAt).toBeNull();

    const batch = createMessageBatch("webhook-queue", [
      {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        attempts: 1,
        body: { deliveryId },
      },
    ]);
    await processWebhookQueueBatch(
      batch,
      env,
      new Map([["intercom", noopProcessor]])
    );

    const completed = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.deliveryId, deliveryId))
      .get();
    expect(completed?.status).toBe("completed");
  });
});
