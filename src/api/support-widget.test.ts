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

  const auth = await createAuth(env);
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

  it("rate-limits anonymous session creation per IP", async () => {
    const { organizationId, token } = await seedWorkspace();
    const key = await createKey(organizationId, token);
    const ip = `10.${Date.now() % 255}.${crypto.randomUUID().slice(0, 2)}.1`;

    const statuses: number[] = [];
    for (let i = 0; i < 21; i += 1) {
      const res = await widgetFetch(`/support/widget/${key.key}/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": ip,
        },
        body: JSON.stringify({}),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses[20]).toBe(429);

    // A different IP is unaffected.
    const other = await widgetFetch(`/support/widget/${key.key}/session`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "192.0.2.99",
      },
      body: JSON.stringify({}),
    });
    expect(other.status).toBe(200);
  });

  it("lets a session customer vote on public tickets and refuses private ones", async () => {
    const { organizationId, token } = await seedWorkspace();
    const key = await createKey(organizationId, token);
    const authHeaders = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    // Staff create a customer + a public ticket and a private ticket.
    const customerRes = await widgetFetch(
      `/workspaces/${organizationId}/support/customers`,
      {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ email: "voter@example.com" }),
      }
    );
    const { customer } = z
      .object({ customer: z.object({ id: z.string() }) })
      .parse(await customerRes.json());

    const mkTicket = async (isPublic: boolean) => {
      const res = await widgetFetch(
        `/workspaces/${organizationId}/support/tickets`,
        {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            customerId: customer.id,
            title: `Idea ${crypto.randomUUID().slice(0, 8)}`,
            sourceChannel: "chat",
          }),
        }
      );
      const { ticket } = z
        .object({ ticket: z.object({ id: z.string() }) })
        .parse(await res.json());
      await widgetFetch(
        `/workspaces/${organizationId}/support/tickets/${ticket.id}`,
        {
          method: "PATCH",
          headers: authHeaders,
          body: JSON.stringify({ isPublic }),
        }
      );
      return ticket.id;
    };
    const publicTicketId = await mkTicket(true);
    const privateTicketId = await mkTicket(false);

    // Session identified by email → votes as that customer.
    const { data: session } = await startSession(key.key, {
      email: "voter@example.com",
    });
    const sessionHeaders = {
      "content-type": "application/json",
      "x-pile-widget-session": session!.sessionToken,
    };

    const vote = await widgetFetch(`/support/widget/${key.key}/votes`, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ ticketId: publicTicketId, priority: "must_have" }),
    });
    expect(vote.status).toBe(200);
    const voteBody = z
      .object({ created: z.boolean(), voteCount: z.number() })
      .parse(await vote.json());
    expect(voteBody).toEqual({ created: true, voteCount: 1 });

    // Idempotent — a repeat vote updates, doesn't duplicate.
    const revote = await widgetFetch(`/support/widget/${key.key}/votes`, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ ticketId: publicTicketId }),
    });
    const revoteBody = z
      .object({ created: z.boolean(), voteCount: z.number() })
      .parse(await revote.json());
    expect(revoteBody).toEqual({ created: false, voteCount: 1 });

    // The public board reflects the vote.
    const board = await widgetFetch(`/workspaces/${organizationId}/board`);
    const boardBody = z
      .object({
        columns: z.record(
          z.string(),
          z.array(z.object({ id: z.string(), voteCount: z.number() }))
        ),
      })
      .parse(await board.json());
    const boardItem = Object.values(boardBody.columns)
      .flat()
      .find((i) => i.id === publicTicketId);
    expect(boardItem?.voteCount).toBe(1);

    // Private tickets are invisible to the widget vote path.
    const privateVote = await widgetFetch(`/support/widget/${key.key}/votes`, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ ticketId: privateTicketId }),
    });
    expect(privateVote.status).toBe(404);

    // Anonymous session (no customer) can't vote.
    const { data: anon } = await startSession(key.key);
    const anonVote = await widgetFetch(`/support/widget/${key.key}/votes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pile-widget-session": anon!.sessionToken,
      },
      body: JSON.stringify({ ticketId: publicTicketId }),
    });
    expect(anonVote.status).toBe(401);

    // Unvote.
    const unvote = await widgetFetch(
      `/support/widget/${key.key}/votes/${publicTicketId}`,
      { method: "DELETE", headers: sessionHeaders }
    );
    const unvoteBody = z
      .object({ removed: z.boolean(), voteCount: z.number() })
      .parse(await unvote.json());
    expect(unvoteBody).toEqual({ removed: true, voteCount: 0 });
  });

  it("serves board + changelog to the widget and upgrades session identity", async () => {
    const { organizationId, token } = await seedWorkspace();
    const key = await createKey(organizationId, token);
    const authHeaders = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };

    // Anonymous session — no customer.
    const { data: anon } = await startSession(key.key);
    const anonHeaders = {
      "content-type": "application/json",
      "x-pile-widget-session": anon!.sessionToken,
    };

    // Idea submit requires identity → 401 anonymous.
    const denied = await widgetFetch(`/support/widget/${key.key}/ideas`, {
      method: "POST",
      headers: anonHeaders,
      body: JSON.stringify({ title: "Dark mode please" }),
    });
    expect(denied.status).toBe(401);

    // Upgrade the same session by supplying an email on resume.
    const { data: upgraded } = await startSession(key.key, {
      sessionToken: anon!.sessionToken,
      email: "upgraded@example.com",
    });
    expect(upgraded!.sessionToken).toBe(anon!.sessionToken);

    // Now the same session can submit an idea → public ticket + auto-vote.
    const idea = await widgetFetch(`/support/widget/${key.key}/ideas`, {
      method: "POST",
      headers: anonHeaders,
      body: JSON.stringify({
        title: "Dark mode please",
        text: "My eyes hurt",
      }),
    });
    expect(idea.status).toBe(201);
    const ideaBody = z
      .object({ ticketId: z.string(), voteCount: z.number() })
      .parse(await idea.json());
    expect(ideaBody.voteCount).toBe(1);

    // Widget board shows the idea flagged voted=true for this session.
    const board = await widgetFetch(`/support/widget/${key.key}/board`, {
      headers: anonHeaders,
    });
    const boardBody = z
      .object({
        items: z.array(
          z.object({
            id: z.string(),
            voted: z.boolean(),
            voteCount: z.number(),
          })
        ),
      })
      .parse(await board.json());
    const item = boardBody.items.find((i) => i.id === ideaBody.ticketId);
    expect(item).toMatchObject({ voted: true, voteCount: 1 });

    // And the same ticket is on the anonymous public board.
    const pub = await widgetFetch(`/workspaces/${organizationId}/board`);
    const pubBody = z
      .object({
        columns: z.record(z.string(), z.array(z.object({ id: z.string() }))),
      })
      .parse(await pub.json());
    expect(
      Object.values(pubBody.columns)
        .flat()
        .some((i) => i.id === ideaBody.ticketId)
    ).toBe(true);

    // Widget changelog — published entries only.
    const entry = await widgetFetch(`/workspaces/${organizationId}/changelog`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ title: "v1 shipped", body: "stuff" }),
    });
    const { entry: e } = z
      .object({ entry: z.object({ id: z.string() }) })
      .parse(await entry.json());
    await widgetFetch(
      `/workspaces/${organizationId}/changelog/${e.id}/publish`,
      { method: "POST", headers: authHeaders }
    );
    const changelog = await widgetFetch(`/support/widget/${key.key}/changelog`);
    const changelogBody = z
      .object({ entries: z.array(z.object({ title: z.string() })) })
      .parse(await changelog.json());
    expect(changelogBody.entries.map((en) => en.title)).toContain("v1 shipped");
  });

  it("serves chat.js loadable from other origins", async () => {
    const res = await widgetFetch("/chat.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin"
    );
    const api = await widgetFetch("/health");
    expect(api.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("mounts on a platform product origin: signed-in user opens a ticket without email", async () => {
    const { organizationId, token } = await seedWorkspace();
    const seal = "https://seal.vortex.nyc";
    const key = await createKey(organizationId, token, {
      name: "Seal",
      allowedOrigins: [seal],
    });
    expect(key.requireEmail).toBe(false);

    // Browser preflight for the session-scoped calls carries the custom
    // x-pile-widget-session header.
    const preflight = await widgetFetch(`/support/widget/${key.key}/messages`, {
      method: "OPTIONS",
      headers: {
        origin: seal,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-pile-widget-session",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(seal);
    expect(
      preflight.headers.get("access-control-allow-headers")?.toLowerCase()
    ).toContain("x-pile-widget-session");

    const identifierHash = await hmacSha256Hex(key.hmacSecret, "seal_user_7");
    const sessionRes = await widgetFetch(`/support/widget/${key.key}/session`, {
      method: "POST",
      headers: { origin: seal, "content-type": "application/json" },
      body: JSON.stringify({ externalId: "seal_user_7", identifierHash }),
    });
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.headers.get("access-control-allow-origin")).toBe(seal);
    const session = sessionSchema.parse(await sessionRes.json());
    expect(session.identityVerified).toBe(true);

    const sealHeaders = {
      origin: seal,
      "content-type": "application/json",
      "x-pile-widget-session": session.sessionToken,
    };
    const sent = await widgetFetch(`/support/widget/${key.key}/messages`, {
      method: "POST",
      headers: sealHeaders,
      body: JSON.stringify({ text: "Signing is stuck on the review step" }),
    });
    expect(sent.status).toBe(200);
    const { ticketId } = z
      .object({ ticketId: z.string() })
      .parse(await sent.json());

    const db = createD1(env.D1);
    const [contact] = await db
      .select()
      .from(supportCustomers)
      .where(eq(supportCustomers.externalId, "seal_user_7"));
    expect(contact.email).toBe("widget-seal_user_7@widget.pile");

    const thread = await widgetFetch(`/support/widget/${key.key}/messages`, {
      headers: sealHeaders,
    });
    expect(thread.status).toBe(200);

    const inbox = await widgetFetch(
      `/workspaces/${organizationId}/support/tickets/${ticketId}`,
      { headers: { authorization: `Bearer ${token}` } }
    );
    expect(inbox.status).toBe(200);

    // Any other origin is refused.
    const foreign = await widgetFetch(`/support/widget/${key.key}/session`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(foreign.status).toBe(401);
  });

  it("does not resume another signed-in user's session from a shared browser", async () => {
    const { organizationId, token } = await seedWorkspace();
    const key = await createKey(organizationId, token);
    const hashA = await hmacSha256Hex(key.hmacSecret, "user_a");
    const hashB = await hmacSha256Hex(key.hmacSecret, "user_b");

    const { data: a } = await startSession(key.key, {
      externalId: "user_a",
      identifierHash: hashA,
    });
    const sent = await widgetFetch(`/support/widget/${key.key}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-pile-widget-session": a!.sessionToken,
      },
      body: JSON.stringify({ text: "User A private thread" }),
    });
    expect(sent.status).toBe(200);

    // Same user resumes the same session.
    const { data: again } = await startSession(key.key, {
      sessionToken: a!.sessionToken,
      externalId: "user_a",
      identifierHash: hashA,
    });
    expect(again!.sessionToken).toBe(a!.sessionToken);
    expect(again!.ticketId).not.toBeNull();

    // User B signs in on the same browser with A's stored token.
    const { data: b } = await startSession(key.key, {
      sessionToken: a!.sessionToken,
      externalId: "user_b",
      identifierHash: hashB,
    });
    expect(b!.sessionToken).not.toBe(a!.sessionToken);
    expect(b!.ticketId).toBeNull();
    expect(b!.identityVerified).toBe(true);

    // Signed out: the stored token no longer opens A's thread either.
    const { data: anon } = await startSession(key.key, {
      sessionToken: a!.sessionToken,
    });
    expect(anon!.sessionToken).not.toBe(a!.sessionToken);
    expect(anon!.ticketId).toBeNull();
  });
});
