import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable, webhookDeliveries } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-webhooks",
      name: "Webhooks User",
      email: "webhooks-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-webhooks");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Webhooks test",
    slug: `webhooks-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-webhooks",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-webhooks",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

async function fetch(
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : undefined),
    ...(init.headers as Record<string, string> | undefined),
  };
  const request = new Request(`https://example.com${path}`, {
    ...init,
    headers,
  });
  return app.fetch(request, env);
}

describe("webhooks API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("rejects creating a webhook without auth", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/webhook-subscriptions`,
      {
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/webhook",
          events: "issue.created",
        }),
      }
    );
    expect(res.status).toBe(403);
  });

  it("rejects an invalid webhook url", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/webhook-subscriptions`,
      {
        method: "POST",
        body: JSON.stringify({
          url: "not-a-url",
          events: "issue.created",
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown webhook", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/webhook-subscriptions/00000000-0000-0000-0000-000000000000`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects updating an unknown webhook", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/webhook-subscriptions/00000000-0000-0000-0000-000000000000`,
      {
        method: "PATCH",
        body: JSON.stringify({
          url: "https://example.com/webhook2",
        }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects deleting an unknown webhook", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/webhook-subscriptions/00000000-0000-0000-0000-000000000000`,
      {
        method: "DELETE",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects listing deliveries without auth", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/webhook-subscriptions/00000000-0000-0000-0000-000000000000/deliveries`
    );
    expect(res.status).toBe(401);
  });

  it("lists inbound webhook deliveries", async () => {
    const db = createD1(env.D1);
    const deliveryId = `delivery-${crypto.randomUUID()}`;
    await db.insert(webhookDeliveries).values({
      deliveryId,
      source: "github",
      event: "issues",
      organizationId,
      status: "completed",
      payload: "{}",
    });

    const res = await fetch(`/workspaces/${organizationId}/webhook-deliveries`, {}, token);
    expect(res.status).toBe(200);
    const body = await res.json<{ deliveries: unknown[] }>();
    expect(body.deliveries.length).toBeGreaterThanOrEqual(1);
    expect(
      body.deliveries.some(
        (d) => (d as { deliveryId: string }).deliveryId === deliveryId
      )
    ).toBe(true);
  });

  it("filters inbound webhook deliveries by status", async () => {
    const db = createD1(env.D1);
    const completedId = `delivery-${crypto.randomUUID()}`;
    const pendingId = `delivery-${crypto.randomUUID()}`;
    await db.insert(webhookDeliveries).values([
      {
        deliveryId: completedId,
        source: "github",
        event: "issues",
        organizationId,
        status: "completed",
        payload: "{}",
      },
      {
        deliveryId: pendingId,
        source: "github",
        event: "issues",
        organizationId,
        status: "pending",
        payload: "{}",
      },
    ]);

    const res = await fetch(
      `/workspaces/${organizationId}/webhook-deliveries?status=completed`,
      {},
      token
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ deliveries: unknown[] }>();
    expect(
      body.deliveries.some(
        (d) => (d as { deliveryId: string }).deliveryId === completedId
      )
    ).toBe(true);
    expect(
      body.deliveries.some(
        (d) => (d as { deliveryId: string }).deliveryId === pendingId
      )
    ).toBe(false);
  });

  it("rejects inbound webhook delivery log without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/webhook-deliveries`);
    expect(res.status).toBe(401);
  });
});
