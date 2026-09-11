import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { hmacSha256Hex } from "../global/crypto.js";
import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { getCustomerByEmail } from "../global/support-contacts.js";
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
      id: "user-channels",
      name: "Channels User",
      email: "channels-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-channels");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Support channels test",
    slug: `support-channels-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-channels",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-channels",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

describe("support-channels API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  function fetch(path: string, init: RequestInit = {}) {
    const request = new Request(`https://example.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    return app.fetch(request, env);
  }

  it("receives a generic incoming message on an active channel", async () => {
    const channelRes = await fetch(
      `/workspaces/${organizationId}/support-channels`,
      {
        method: "POST",
        body: JSON.stringify({
          type: "api",
          name: "api-inbound",
        }),
      }
    );
    expect(channelRes.status).toBe(201);
    const { id } = (await channelRes.json()) as { id: string };

    const incomingRes = await app.fetch(
      new Request(`https://example.com/support/incoming/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromEmail: "sender@example.com",
          fromName: "Sender",
          subject: "Help",
          text: "I need help",
        }),
      }),
      env
    );
    expect(incomingRes.status).toBe(201);
    const body = (await incomingRes.json()) as {
      ok: boolean;
      ticketId: string;
      ticketNumber: number;
    };
    expect(body.ok).toBe(true);
    expect(body.ticketNumber).toBeGreaterThan(0);

    const db = createD1(env.D1);
    const customer = await getCustomerByEmail(
      db,
      organizationId,
      "sender@example.com"
    );
    expect(customer).toBeDefined();
  });

  it("receives a Slack message event and creates a ticket", async () => {
    env.SLACK_SIGNING_SECRET = "slack-secret";

    const channelRes = await fetch(
      `/workspaces/${organizationId}/support-channels`,
      {
        method: "POST",
        body: JSON.stringify({
          type: "slack",
          name: "C12345",
        }),
      }
    );
    expect(channelRes.status).toBe(201);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = JSON.stringify({
      type: "event_callback",
      event: {
        type: "message",
        channel: "C12345",
        user: "U123",
        text: "Slack help",
        ts: "1234567890.123456",
        user_profile: {
          email: "slack-user@example.com",
          name: "Slack User",
        },
      },
    });
    const signature = `v0=${await hmacSha256Hex(
      "slack-secret",
      `v0:${timestamp}:${payload}`
    )}`;

    const res = await app.fetch(
      new Request(
        `https://example.com/support/webhooks/slack/${organizationId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Slack-Signature": signature,
            "X-Slack-Request-Timestamp": timestamp,
          },
          body: payload,
        }
      ),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const db = createD1(env.D1);
    const customer = await getCustomerByEmail(
      db,
      organizationId,
      "slack-user@example.com"
    );
    expect(customer).toBeDefined();
  });
});
