import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

env.WEBHOOK_QUEUE = null as unknown as typeof env.WEBHOOK_QUEUE;

import { hmacSha256Hex } from "../global/crypto.js";
import { createD1 } from "../global/db.js";
import {
  supportCustomers,
  supportTicketEvents,
  user as userTable,
} from "../global/schema.js";
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
      id: "user-widget",
      name: "Widget User",
      email: "widget-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-widget");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Support widget test",
    slug: `support-widget-${crypto.randomUUID()}`,
    key: `W${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-widget",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-widget",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

function widgetFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = path.startsWith("http") ? path : `https://example.com${path}`;
  const request = new Request(url, init);
  return app.fetch(request, env) as Promise<Response>;
}

const widgetKeySchema = z.object({
  id: z.string(),
  key: z.string(),
  hmacSecret: z.string(),
  requireEmail: z.boolean(),
});

const sessionSchema = z.object({
  sessionToken: z.string(),
  ticketId: z.string().nullable(),
  identityVerified: z.boolean(),
});

async function createKey(
  organizationId: string,
  token: string,
  body: Record<string, unknown> = {}
) {
  const res = await widgetFetch(
    `/workspaces/${organizationId}/support/widget-keys`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Test widget", ...body }),
    }
  );
  expect(res.status).toBe(201);
  return widgetKeySchema.parse(await res.json());
}

async function startSession(key: string, body: Record<string, unknown> = {}) {
  const res = await widgetFetch(`/support/widget/${key}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, data: res.ok ? sessionSchema.parse(await res.json()) : null };
}

describe("support widget", () => {
  it("creates, lists, and revokes widget keys", async () => {
    const { organizationId, token } = await seedWorkspace();
    const key = await createKey(organizationId, token, {
      allowedOrigins: ["https://acme.com"],
      greeting: "How can we help?",
      brandColor: "#ff0066",
    });
    expect(key.key.startsWith("wgt_")).toBe(true);
    expect(key.hmacSecret.length).toBeGreaterThan(0);

    const list = await widgetFetch(
      `/workspaces/${organizationId}/support/widget-keys`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    const listed = z
      .object({ widgetKeys: z.array(widgetKeySchema) })
      .parse(await list.json());
    expect(listed.widgetKeys.map((k) => k.id)).toContain(key.id);

    const revoke = await widgetFetch(
      `/workspaces/${organizationId}/support/widget-keys/${key.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${token}` } }
    );
    expect(revoke.status).toBe(200);

    const { res } = await startSession(key.key);
    expect(res.status).toBe(404);
  });

  it("creates an anonymous session, turns the first message into a ticket, and polls replies", async () => {
    const { organizationId, token } = await seedWorkspace();
    const key = await createKey(organizationId, token);

    const { data: session } = await startSession(key.key);
    expect(session).not.toBeNull();
    expect(session!.ticketId).toBeNull();
    expect(session!.identityVerified).toBe(false);

    const headers = {
      "content-type": "application/json",
      "x-pile-widget-session": session!.sessionToken,
    };
    const send = await widgetFetch(`/support/widget/${key.key}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "checkout is broken", email: "a@b.co" }),
    });
    expect(send.status).toBe(200);
    const { ticketId } = z
      .object({ messageId: z.string(), ticketId: z.string() })
      .parse(await send.json());

    // The message is a real support ticket inbound message.
    const db = createD1(env.D1);
    const events = await db
      .select()
      .from(supportTicketEvents)
      .where(eq(supportTicketEvents.ticketId, ticketId));
    expect(events.some((e) => e.type === "message")).toBe(true);

    // Resuming the session returns the same ticket — conversation continuity.
    const { data: resumed } = await startSession(key.key, {
      sessionToken: session!.sessionToken,
    });
    expect(resumed!.ticketId).toBe(ticketId);

    const poll = await widgetFetch(`/support/widget/${key.key}/messages`, {
      headers,
    });
    const { messages } = z
      .object({
        messages: z.array(
          z.object({ direction: z.string(), text: z.string() })
        ),
      })
      .parse(await poll.json());
    expect(messages).toHaveLength(1);
    expect(messages[0].direction).toBe("inbound");
    expect(messages[0].text).toBe("checkout is broken");

    // ?after= cursor yields nothing new.
    const eventsRows = await db
      .select()
      .from(supportTicketEvents)
      .where(eq(supportTicketEvents.ticketId, ticketId));
    const last = eventsRows[0].createdAt;
    const pollAfter = await widgetFetch(
      `/support/widget/${key.key}/messages?after=${encodeURIComponent(last)}`,
      { headers }
    );
    const { messages: none } = z
      .object({ messages: z.array(z.unknown()) })
      .parse(await pollAfter.json());
    expect(none).toHaveLength(0);
  });

  it("dedupes retried messages on externalId", async () => {
    const { organizationId, token } = await seedWorkspace();
    const key = await createKey(organizationId, token);
    const { data: session } = await startSession(key.key);

    const headers = {
      "content-type": "application/json",
      "x-pile-widget-session": session!.sessionToken,
    };
    const body = JSON.stringify({
      text: "payment failed twice",
      externalId: "client-msg-1",
    });
    const first = await widgetFetch(`/support/widget/${key.key}/messages`, {
      method: "POST",
      headers,
      body,
    });
    const second = await widgetFetch(`/support/widget/${key.key}/messages`, {
      method: "POST",
      headers,
      body,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = z
      .object({ messageId: z.string(), ticketId: z.string() })
      .parse(await first.json());
    const b = z
      .object({ messageId: z.string(), ticketId: z.string() })
      .parse(await second.json());
    expect(b.messageId).toBe(a.messageId);
    expect(b.ticketId).toBe(a.ticketId);

    const db = createD1(env.D1);
    const events = await db
      .select()
      .from(supportTicketEvents)
      .where(eq(supportTicketEvents.ticketId, a.ticketId));
    expect(
      events.filter(
        (e) => e.type === "message" && e.externalId === "client-msg-1"
      )
    ).toHaveLength(1);
  });

  it("verifies identifierHash and dedupes the contact on externalId", async () => {
    const { organizationId, token } = await seedWorkspace();
    const key = await createKey(organizationId, token);
    const hash = await hmacSha256Hex(key.hmacSecret, "user_42");

    const { data: verified } = await startSession(key.key, {
      externalId: "user_42",
      email: "ada@acme.com",
      name: "Ada",
      identifierHash: hash,
    });
    expect(verified!.identityVerified).toBe(true);

    const db = createD1(env.D1);
    const customers = await db
      .select()
      .from(supportCustomers)
      .where(eq(supportCustomers.externalId, "user_42"));
    expect(customers).toHaveLength(1);
    expect(customers[0].email).toBe("ada@acme.com");

    // A second verified session for the same externalId reuses the contact.
    const { data: second } = await startSession(key.key, {
      externalId: "user_42",
      identifierHash: hash,
    });
    expect(second!.identityVerified).toBe(true);
    const after = await db
      .select()
      .from(supportCustomers)
      .where(eq(supportCustomers.externalId, "user_42"));
    expect(after).toHaveLength(1);

    // A forged hash falls back to unverified, not an error.
    const { data: forged } = await startSession(key.key, {
      externalId: "user_99",
      identifierHash: "deadbeef",
    });
    expect(forged!.identityVerified).toBe(false);
  });

  it("enforces requireEmail and rejects wrong session tokens", async () => {
    const { organizationId, token } = await seedWorkspace();
    const key = await createKey(organizationId, token, { requireEmail: true });

    const { res } = await startSession(key.key);
    expect(res.status).toBe(400);

    const { data } = await startSession(key.key, { email: "v@acme.com" });
    expect(data).not.toBeNull();

    const wrongSession = await widgetFetch(
      `/support/widget/${key.key}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pile-widget-session": "wgs_forged",
        },
        body: JSON.stringify({ text: "hi" }),
      }
    );
    expect(wrongSession.status).toBe(401);
  });
});
