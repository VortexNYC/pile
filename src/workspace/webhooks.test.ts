import { env, runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { outboundWebhookDeliveries, workspaces } from "../global/schema.js";
import { createWebhookSubscription } from "../global/webhook-subscriptions.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { WorkspaceDO } from "./durable-object.js";
import { deliverWebhooks } from "./webhooks.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {}
}

const WORKSPACE_ID = "webhook-test-workspace";

async function ensureWorkspace() {
  const db = createD1(env.D1);
  const existing = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, WORKSPACE_ID))
    .get();
  if (existing) return;

  const now = new Date().toISOString();
  await db.insert(workspaces).values({
    id: WORKSPACE_ID,
    name: "Webhook test workspace",
    slug: "webhook-test-workspace",
    ownerId: "user-1",
    createdAt: now,
    updatedAt: now,
  });
}

function getStub() {
  const id = env.WORKSPACE_DURABLE_OBJECT.idFromName(WORKSPACE_ID);
  return env.WORKSPACE_DURABLE_OBJECT.get(id);
}

async function withWorkspace<T>(
  stub: ReturnType<typeof getStub>,
  callback: (instance: WorkspaceDO) => T | Promise<T>
): Promise<T> {
  return runInDurableObject(stub, async (instance) => {
    await instance.setWorkspaceId(WORKSPACE_ID);
    return callback(instance);
  });
}

describe("deliverWebhooks", () => {
  beforeAll(ensureWorkspace);

  it("records a failed delivery for a matching subscription", async () => {
    const db = createD1(env.D1);
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Webhook test issue" })
    );

    const sub = await createWebhookSubscription(db, WORKSPACE_ID, {
      url: "http://127.0.0.1:1/webhook",
      events: "issue.created",
    });
    if (!sub) {
      throw new Error("Webhook subscription not created");
    }

    await deliverWebhooks(env, WORKSPACE_ID, {
      type: "issue.created",
      workspaceId: WORKSPACE_ID,
      issue,
    });

    const deliveries = await db
      .select()
      .from(outboundWebhookDeliveries)
      .where(eq(outboundWebhookDeliveries.subscriptionId, sub.id))
      .all();

    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe("failed");
    expect(deliveries[0].subscriptionId).toBe(sub.id);
    expect(deliveries[0].event).toBe("issue.created");
  });
});
