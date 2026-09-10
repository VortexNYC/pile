import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  hmacSha1Hex,
  hmacSha256Base64,
  hmacSha256Hex,
} from "../global/crypto.js";
import { createD1 } from "../global/db.js";
import {
  supportChannels,
  supportTickets,
  user as userTable,
} from "../global/schema.js";
import { getTicketById } from "../global/support-tickets.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAdminHeaders } from "../platform/test-auth.js";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-1",
      name: "Test User",
      email: "user-1@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const headers = await createAdminHeaders(env, "user-1");
  const workspace = await createWorkspace(db, env, headers, {
    name: "Webhook test workspace",
    slug: `webhook-test-${crypto.randomUUID()}`,
    key: `W${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-1",
  });
  const organizationId = workspace!.id;

  await db.insert(supportChannels).values([
    {
      id: crypto.randomUUID(),
      organizationId,
      type: "intercom",
      name: "intercom",
      isActive: true,
      config: JSON.stringify({ secretName: "INTERCOM_CLIENT_SECRET" }),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: crypto.randomUUID(),
      organizationId,
      type: "zendesk",
      name: "zendesk",
      isActive: true,
      config: JSON.stringify({ secretName: "ZENDESK_WEBHOOK_SECRET" }),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: crypto.randomUUID(),
      organizationId,
      type: "plain",
      name: "plain",
      isActive: true,
      config: JSON.stringify({ secretName: "PLAIN_WEBHOOK_SECRET" }),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
  ]);

  return organizationId;
}

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string>
) {
  const raw = JSON.stringify(body);
  const request = new Request(`https://example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: raw,
  });
  return app.fetch(request, env);
}

function intercomNotification(overrides: { topic?: string; id?: string } = {}) {
  const id = overrides.id ?? crypto.randomUUID();
  return {
    type: "notification_event" as const,
    id,
    topic: overrides.topic ?? "conversation.user.created",
    app_id: "test",
    created_at: Math.floor(Date.now() / 1000),
    data: {
      item: {
        id: `conv-${id}`,
        title: "Intercom support question",
        state: "open" as const,
        priority: "not_priority" as const,
        source: {
          type: "conversation",
          subject: "Need help",
          body: "<p>I cannot log in.</p>",
          author: {
            type: "user" as const,
            id: "user-1",
            name: "Customer One",
            email: "customer1@example.com",
          },
        },
        created_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      },
    },
  };
}

describe("support channel webhooks", () => {
  let organizationId: string;

  beforeAll(async () => {
    env.INTERCOM_CLIENT_SECRET = "intercom-secret";
    env.ZENDESK_WEBHOOK_SECRET = "zendesk-secret";
    env.PLAIN_WEBHOOK_SECRET = "plain-secret";
    organizationId = await seedWorkspace();
  });

  it("accepts a valid Intercom webhook and creates a support ticket", async () => {
    const body = intercomNotification();
    const raw = JSON.stringify(body);
    const signature = `sha1=${await hmacSha1Hex(env.INTERCOM_CLIENT_SECRET ?? "", raw)}`;

    const res = await post(
      `/support/webhooks/intercom/${organizationId}`,
      body,
      { "X-Hub-Signature": signature }
    );

    const text = await res.text();
    expect(res.status).toBe(200);
    const json = JSON.parse(text) as { ok: boolean };
    expect(json.ok).toBe(true);

    const db = createD1(env.D1);
    const ticket = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.externalId, `conv-${body.id}`))
      .get();
    expect(ticket).toBeDefined();
    expect(ticket?.title).toBe("Intercom support question");
  });

  it("rejects an Intercom webhook with a missing signature", async () => {
    const body = intercomNotification();
    const res = await post(
      `/support/webhooks/intercom/${organizationId}`,
      body,
      {}
    );
    expect(res.status).toBe(401);
  });

  it("rejects an Intercom webhook with an invalid signature", async () => {
    const body = intercomNotification();
    const res = await post(
      `/support/webhooks/intercom/${organizationId}`,
      body,
      { "X-Hub-Signature": "sha1=0000000000000000000000000000000000000000" }
    );
    expect(res.status).toBe(401);
  });

  it("does not duplicate Intercom ticket messages on replay", async () => {
    const body = intercomNotification();
    const raw = JSON.stringify(body);
    const signature = `sha1=${await hmacSha1Hex(env.INTERCOM_CLIENT_SECRET ?? "", raw)}`;

    const first = await post(
      `/support/webhooks/intercom/${organizationId}`,
      body,
      { "X-Hub-Signature": signature }
    );
    expect(first.status).toBe(200);

    const second = await post(
      `/support/webhooks/intercom/${organizationId}`,
      body,
      { "X-Hub-Signature": signature }
    );
    expect(second.status).toBe(200);

    const db = createD1(env.D1);
    const ticket = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.externalId, `conv-${body.id}`))
      .get();
    expect(ticket).toBeDefined();
    const full = await getTicketById(db, organizationId, ticket!.id);
    const messageEvents =
      full?.events.filter((event) => event.type === "message") ?? [];
    expect(messageEvents.length).toBe(1);
  });

  it("accepts a valid Zendesk webhook and creates a support ticket", async () => {
    const body = {
      ticket: {
        id: 123,
        subject: "Zendesk help request",
        description: "<p>My account is broken.</p>",
        status: "open",
        priority: "high",
        requester: {
          email: "zendesk-customer@example.com",
          name: "Zendesk Customer",
        },
        created_at: "2023-10-27T10:00:00.000Z",
        updated_at: "2023-10-27T10:00:00.000Z",
      },
    };
    const raw = JSON.stringify(body);
    const timestamp = "2023-10-27T10:00:00Z";
    const signature = await hmacSha256Base64(
      env.ZENDESK_WEBHOOK_SECRET ?? "",
      timestamp + raw
    );

    const res = await post(
      `/support/webhooks/zendesk/${organizationId}`,
      body,
      {
        "X-Zendesk-Webhook-Signature": signature,
        "X-Zendesk-Webhook-Signature-Timestamp": timestamp,
      }
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);

    const db = createD1(env.D1);
    const ticket = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.externalId, "123"))
      .get();
    expect(ticket).toBeDefined();
    expect(ticket?.title).toBe("Zendesk help request");
  });

  it("rejects a Zendesk webhook with an invalid signature", async () => {
    const body = {
      ticket: {
        id: 999,
        subject: "Bad",
        requester: { email: "a@b.com" },
      },
    };
    const res = await post(
      `/support/webhooks/zendesk/${organizationId}`,
      body,
      {
        "X-Zendesk-Webhook-Signature": "bad",
        "X-Zendesk-Webhook-Signature-Timestamp": "2023-10-27T10:00:00Z",
      }
    );
    expect(res.status).toBe(401);
  });

  it("accepts a valid Plain webhook and creates a support ticket", async () => {
    const body = {
      id: crypto.randomUUID(),
      type: "thread.thread_created",
      timestamp: "2023-10-27T10:00:00.000Z",
      workspaceId: "workspace_123",
      payload: {
        eventType: "thread.thread_created",
        thread: {
          id: "thread_123",
          title: "Plain help request",
          previewText: "I need help with my account.",
          status: "TODO",
          priority: "MEDIUM",
          customer: {
            id: "customer_123",
            email: { email: "plain-customer@example.com", isVerified: true },
            fullName: "Plain Customer",
          },
          createdAt: "2023-10-27T10:00:00.000Z",
          updatedAt: "2023-10-27T10:00:00.000Z",
        },
      },
      webhookMetadata: {},
    };
    const raw = JSON.stringify(body);
    const signature = await hmacSha256Hex(env.PLAIN_WEBHOOK_SECRET ?? "", raw);

    const res = await post(`/support/webhooks/plain/${organizationId}`, body, {
      "Plain-Request-Signature": signature,
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);

    const db = createD1(env.D1);
    const ticket = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.externalId, "thread_123"))
      .get();
    expect(ticket).toBeDefined();
    expect(ticket?.title).toBe("Plain help request");
  });

  it("rejects a Plain webhook with an invalid signature", async () => {
    const body = {
      id: crypto.randomUUID(),
      type: "thread.thread_created",
      timestamp: "2023-10-27T10:00:00.000Z",
      workspaceId: "workspace_123",
      payload: {
        eventType: "thread.thread_created",
        thread: {
          id: "thread_999",
          title: "Bad",
          status: "TODO",
          priority: "MEDIUM",
          customer: {
            id: "c",
            email: { email: "a@b.com", isVerified: true },
            fullName: "X",
          },
          createdAt: "2023-10-27T10:00:00.000Z",
          updatedAt: "2023-10-27T10:00:00.000Z",
        },
      },
      webhookMetadata: {},
    };
    const res = await post(`/support/webhooks/plain/${organizationId}`, body, {
      "Plain-Request-Signature":
        "0000000000000000000000000000000000000000000000000000000000000000",
    });
    expect(res.status).toBe(401);
  });
});
