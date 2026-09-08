import { env, runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { member, organization, user as userTable } from "../global/schema.js";
import { createDefaultTeam } from "../global/teams.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { WorkspaceDO } from "./durable-object.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends WorkerEnv {}
}

const WORKSPACE_ID = "webhook-test-workspace";

async function ensureWorkspace() {
  const db = createD1(env.D1);
  const existing = await db
    .select()
    .from(organization)
    .where(eq(organization.id, WORKSPACE_ID))
    .get();
  if (existing) return;

  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-1",
      name: "Test",
      email: "user-1@test.local",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  await db.insert(organization).values({
    id: WORKSPACE_ID,
    name: "Webhook test workspace",
    slug: "webhook-test-workspace",
    metadata: JSON.stringify({ key: "WEB" }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: WORKSPACE_ID,
    userId: "user-1",
    role: "owner",
    createdAt: now,
  });
  await createDefaultTeam(db, WORKSPACE_ID, "WEB", "user-1");
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
    await instance.setOrganizationId(WORKSPACE_ID);
    return callback(instance);
  });
}

async function cleanupWorkspace() {
  const stub = getStub();
  const subs = await withWorkspace(stub, (instance) =>
    instance.listWebhookSubscriptions()
  );
  for (const sub of subs) {
    await withWorkspace(stub, (instance) =>
      instance.deleteWebhookSubscription(sub.id)
    );
  }
}

describe("deliverWebhooks", () => {
  beforeAll(ensureWorkspace);
  beforeEach(cleanupWorkspace);

  it("records a failed delivery for a matching subscription", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Webhook test issue" })
    );

    const sub = await withWorkspace(stub, (instance) =>
      instance.createWebhookSubscription({
        url: "http://127.0.0.1:1/webhook",
        events: "issue.created",
      })
    );
    if (!sub) {
      throw new Error("Webhook subscription not created");
    }

    await withWorkspace(stub, (instance) =>
      instance.deliverWebhooks({
        type: "issue.created",
        organizationId: WORKSPACE_ID,
        issue,
      })
    );

    const deliveries = await withWorkspace(stub, (instance) =>
      instance.listWebhookDeliveries(sub.id)
    );

    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe("failed");
    expect(deliveries[0].subscriptionId).toBe(sub.id);
    expect(deliveries[0].event).toBe("issue.created");
    expect(deliveries[0].attemptCount).toBe(1);
  });

  it("retries failed deliveries and increments attemptCount", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Webhook retry test issue" })
    );

    const sub = await withWorkspace(stub, (instance) =>
      instance.createWebhookSubscription({
        url: "http://127.0.0.1:1/webhook",
        events: "issue.created",
      })
    );
    if (!sub) {
      throw new Error("Webhook subscription not created");
    }

    await withWorkspace(stub, (instance) =>
      instance.deliverWebhooks({
        type: "issue.created",
        organizationId: WORKSPACE_ID,
        issue,
      })
    );

    const result = await withWorkspace(stub, (instance) =>
      instance.retryWebhookDeliveries()
    );
    expect(result.hasMore).toBe(true);
    expect(typeof result.retryAt).toBe("number");

    const deliveries = await withWorkspace(stub, (instance) =>
      instance.listWebhookDeliveries(sub.id)
    );

    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe("failed");
    expect(deliveries[0].attemptCount).toBe(2);
  });

  it("delivers comment.created events to matching subscriptions", async () => {
    const stub = getStub();
    const issue = await withWorkspace(stub, (instance) =>
      instance.createIssue({ title: "Comment webhook test issue" })
    );
    const comment = await withWorkspace(stub, (instance) =>
      instance.createComment({
        issueId: issue.id,
        authorId: "user-1",
        body: "A comment",
      })
    );
    if (!comment) {
      throw new Error("Comment not created");
    }

    const sub = await withWorkspace(stub, (instance) =>
      instance.createWebhookSubscription({
        url: "http://127.0.0.1:1/webhook",
        events: "comment.created",
      })
    );
    if (!sub) {
      throw new Error("Webhook subscription not created");
    }

    await withWorkspace(stub, (instance) =>
      instance.deliverWebhooks({
        type: "comment.created",
        organizationId: WORKSPACE_ID,
        issue,
        comment,
      })
    );

    const deliveries = await withWorkspace(stub, (instance) =>
      instance.listWebhookDeliveries(sub.id)
    );

    expect(deliveries.length).toBe(1);
    expect(deliveries[0].event).toBe("comment.created");
    expect(deliveries[0].status).toBe("failed");
    expect(deliveries[0].attemptCount).toBe(1);
  });
});
