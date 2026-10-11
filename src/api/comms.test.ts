import { createHmac } from "node:crypto";

import { env } from "cloudflare:test";
import { eq, and } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

env.WEBHOOK_QUEUE = null as unknown as typeof env.WEBHOOK_QUEUE;

import { createD1 } from "../global/db.js";
import { supportCustomers, user as userTable } from "../global/schema.js";
import { findOrCreateCustomerByEmail } from "../global/support-contacts.js";
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
      id: "user-comms",
      name: "Comms User",
      email: "comms-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-comms");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Comms test",
    slug: `comms-${crypto.randomUUID()}`,
    key: `C${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-comms",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-comms",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

function req(path: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return app.fetch(
    new Request(`https://example.com${path}`, { ...init, headers }),
    env
  ) as Promise<Response>;
}

describe("comms events", () => {
  let organizationId: string;
  let token: string;
  let customerId: string;
  const secret = "comms-test-secret";

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
    const db = createD1(env.D1);
    const customer = await findOrCreateCustomerByEmail(
      db,
      organizationId,
      "buyer@acme.test",
      "Buyer Acme"
    );
    customerId = customer.id;
  });

  it("records a manual event on a customer", async () => {
    const res = await req(
      `/workspaces/${organizationId}/support/customers/${customerId}/events`,
      {
        method: "POST",
        body: JSON.stringify({
          type: "note",
          summary: "Left voicemail",
        }),
      },
      token
    );
    expect(res.status).toBe(201);
    const listed = await req(
      `/workspaces/${organizationId}/support/customers/${customerId}/events`,
      {},
      token
    );
    const body = z
      .object({ events: z.array(z.object({ summary: z.string() })) })
      .parse(await listed.json());
    expect(body.events.some((e) => e.summary === "Left voicemail")).toBe(true);
  });

  it("rejects the webhook before the secret is configured", async () => {
    const res = await req(`/webhooks/comms/${organizationId}/calcom`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("records a cal.com booking on the matching customer", async () => {
    const configure = await req(
      `/workspaces/${organizationId}/comms/integrations/calcom`,
      {
        method: "PUT",
        body: JSON.stringify({ webhookSecret: secret }),
      },
      token
    );
    expect(configure.status).toBe(200);

    const payload = JSON.stringify({
      triggerEvent: "BOOKING_CREATED",
      payload: {
        uid: "cal-booking-1",
        title: "Intro call",
        startTime: "2026-03-10T15:00:00Z",
        attendees: [{ email: "buyer@acme.test", name: "Buyer Acme" }],
      },
    });
    const signature = createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    const res = await req(`/webhooks/comms/${organizationId}/calcom`, {
      method: "POST",
      headers: { "x-cal-signature-256": signature },
      body: payload,
    });
    expect(res.status).toBe(200);
    const body = z.object({ recorded: z.number() }).parse(await res.json());
    expect(body.recorded).toBe(1);

    const listed = await req(
      `/workspaces/${organizationId}/support/customers/${customerId}/events`,
      {},
      token
    );
    const events = z
      .object({ events: z.array(z.object({ summary: z.string() })) })
      .parse(await listed.json());
    expect(
      events.events.some((e) => e.summary.includes("Call booked: Intro call"))
    ).toBe(true);
  });

  it("rejects a bad cal.com signature", async () => {
    const res = await req(`/webhooks/comms/${organizationId}/calcom`, {
      method: "POST",
      headers: { "x-cal-signature-256": "deadbeef" },
      body: JSON.stringify({ triggerEvent: "BOOKING_CREATED", payload: {} }),
    });
    expect(res.status).toBe(401);
  });
});
