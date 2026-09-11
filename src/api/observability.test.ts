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
  const userId = `observability-user-${crypto.randomUUID()}`;
  await db
    .insert(userTable)
    .values({
      id: userId,
      name: "Observability User",
      email: `${userId}@example.com`,
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, userId);
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Observability test",
    slug: `observability-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: userId,
  });

  const auth = createAuth(env);
  const adminResult = await auth.api.createApiKey({
    body: {
      userId,
      name: "test-admin",
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const adminParsed = z.object({ key: z.string() }).parse(adminResult);

  return { organizationId: workspace!.id, token: adminParsed.key };
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

describe("observability API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("rejects metrics without auth", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/observability/metrics`
    );
    expect(res.status).toBe(401);
  });

  it("returns workspace metrics", async () => {
    const deliveryId = `delivery-${crypto.randomUUID()}`;
    const db = createD1(env.D1);
    await db.insert(webhookDeliveries).values({
      deliveryId,
      source: "github",
      event: "issues",
      organizationId,
      status: "completed",
      payload: "{}",
    });

    const res = await fetch(
      `/workspaces/${organizationId}/observability/metrics`,
      {},
      token
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      supportTickets: { total: number };
      supportCustomers: { total: number };
      webhookDeliveries: {
        total: number;
        completed: number;
        pending: number;
        failed: number;
      };
      tokens: { total: number };
    }>();
    expect(body.supportTickets.total).toBe(0);
    expect(body.supportCustomers.total).toBe(0);
    expect(body.webhookDeliveries.total).toBeGreaterThanOrEqual(1);
    expect(body.webhookDeliveries.completed).toBeGreaterThanOrEqual(1);
    expect(body.webhookDeliveries.pending).toBe(0);
    expect(body.webhookDeliveries.failed).toBe(0);
    expect(body.tokens.total).toBeGreaterThanOrEqual(1);
  });
});
