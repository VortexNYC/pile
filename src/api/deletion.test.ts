import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

env.WEBHOOK_QUEUE = null as unknown as typeof env.WEBHOOK_QUEUE;

import { createD1 } from "../global/db.js";
import {
  organization,
  supportCustomers,
  supportTicketAttachments,
  supportTicketEvents,
  supportTickets,
  supportWidgetKeys,
  supportWidgetSessions,
  user as userTable,
} from "../global/schema.js";
import { sweepExpiredCaptureArtifacts } from "../global/support-capture.js";
import { createCustomer } from "../global/support-contacts.js";
import { createTicket } from "../global/support-tickets.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

const origin = (
  env.ALLOWED_ORIGINS ??
  env.BETTER_AUTH_URL ??
  "https://pile.example.workers.dev"
)
  .toString()
  .split(",")[0]
  .trim();

async function getSessionCookie(): Promise<{
  cookie: string;
  userId: string;
}> {
  const auth = createAuth(env);
  const email = `del-${crypto.randomUUID()}@example.com`;
  const password = "password123";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: "Del Owner" },
  });
  const userId = z.object({ user: z.object({ id: z.string() }) }).parse(signUp)
    .user.id;
  const signInRes = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookie = signInRes.headers
    .getSetCookie()
    .find((c) => c.includes("better-auth.session_token="));
  if (!cookie) throw new Error("No session cookie");
  return { cookie, userId };
}

async function seedWorkspace(userId = "user-del") {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: userId,
      name: "Del User",
      email: `${userId}@example.com`,
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, userId);
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Deletion test",
    slug: `del-${crypto.randomUUID()}`,
    key: `D${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: userId,
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId,
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key, userId };
}

async function seedTicket(organizationId: string) {
  const db = createD1(env.D1);
  const customer = await createCustomer(db, {
    organizationId,
    email: "delete-me@example.com",
    fullName: "Delete Me",
    externalId: "cust_ext_1",
  });
  const ticket = await createTicket(db, {
    organizationId,
    customerId: customer.id,
    title: "delete me",
    sourceChannel: "chat",
    externalSource: "chat",
  });
  return { customer, ticket };
}

describe("deletion", () => {
  it("anonymizes a customer and drops widget sessions, keeping tickets", async () => {
    const { organizationId, token } = await seedWorkspace();
    const db = createD1(env.D1);
    const { customer, ticket } = await seedTicket(organizationId);

    const widgetKey = { id: crypto.randomUUID() };
    await db.insert(supportWidgetKeys).values({
      id: widgetKey.id,
      organizationId,
      key: `wgt_${crypto.randomUUID().replace(/-/g, "")}`,
      hmacSecret: "test-secret",
      name: "test",
    });
    await db.insert(supportWidgetSessions).values({
      id: crypto.randomUUID(),
      organizationId,
      widgetKeyId: widgetKey.id,
      token: `wgs_${crypto.randomUUID().replace(/-/g, "")}`,
      customerId: customer.id,
      ticketId: ticket.id,
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });

    const res = await app.fetch(
      new Request(
        `https://example.com/workspaces/${organizationId}/support/customers/${customer.id}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        }
      ),
      env
    );
    expect(res.status).toBe(200);

    const after = await db
      .select()
      .from(supportCustomers)
      .where(eq(supportCustomers.id, customer.id))
      .get();
    expect(after!.email).toBe(`deleted-${customer.id}@redacted.local`);
    expect(after!.fullName).toBeNull();
    expect(after!.externalId).toBeNull();

    const sessions = await db
      .select()
      .from(supportWidgetSessions)
      .where(eq(supportWidgetSessions.customerId, customer.id));
    expect(sessions).toHaveLength(0);

    const kept = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, ticket.id))
      .get();
    expect(kept).toBeDefined();
  });

  it("sweeps expired capture artifacts from R2 and D1", async () => {
    const { organizationId } = await seedWorkspace("user-sweep");
    const db = createD1(env.D1);
    const { ticket } = await seedTicket(organizationId);

    const eventId = crypto.randomUUID();
    await db.insert(supportTicketEvents).values({
      id: eventId,
      ticketId: ticket.id,
      type: "message",
      actorType: "customer",
      createdAt: new Date().toISOString(),
    });
    const r2Key = `${organizationId}/capture/${crypto.randomUUID()}/log/console.log`;
    await env.ATTACHMENTS_BUCKET.put(r2Key, "stale log");
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    await db.insert(supportTicketAttachments).values({
      id: crypto.randomUUID(),
      organizationId,
      ticketId: ticket.id,
      eventId,
      type: "log",
      r2Key,
      fileName: "console.log",
      createdAt: old,
    });
    // Fresh attachment must survive the sweep.
    const freshKey = `${organizationId}/capture/${crypto.randomUUID()}/log/new.log`;
    await env.ATTACHMENTS_BUCKET.put(freshKey, "fresh");
    await db.insert(supportTicketAttachments).values({
      id: crypto.randomUUID(),
      organizationId,
      ticketId: ticket.id,
      eventId,
      type: "log",
      r2Key: freshKey,
      fileName: "new.log",
      createdAt: new Date().toISOString(),
    });

    const { removed } = await sweepExpiredCaptureArtifacts(
      db,
      env.ATTACHMENTS_BUCKET,
      30
    );
    expect(removed).toBe(1);
    expect(await env.ATTACHMENTS_BUCKET.get(r2Key)).toBeNull();
    expect(await env.ATTACHMENTS_BUCKET.get(freshKey)).not.toBeNull();
    const rows = await db
      .select()
      .from(supportTicketAttachments)
      .where(eq(supportTicketAttachments.ticketId, ticket.id));
    expect(rows).toHaveLength(1);
  });

  it("deletes a workspace: org rows, R2 objects, and DO storage", async () => {
    const { cookie, userId } = await getSessionCookie();
    const db = createD1(env.D1);
    const workspace = await createWorkspace(
      db,
      env,
      new Headers({ Cookie: cookie }),
      {
        name: "Delete me",
        slug: `del-${crypto.randomUUID()}`,
        key: `D${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        ownerId: userId,
      }
    );
    const organizationId = workspace!.id;
    const { customer, ticket } = await seedTicket(organizationId);
    void customer;

    const eventId = crypto.randomUUID();
    await db.insert(supportTicketEvents).values({
      id: eventId,
      ticketId: ticket.id,
      type: "message",
      actorType: "customer",
      createdAt: new Date().toISOString(),
    });
    const r2Key = `${organizationId}/capture/${crypto.randomUUID()}/log/x.log`;
    await env.ATTACHMENTS_BUCKET.put(r2Key, "payload");
    await db.insert(supportTicketAttachments).values({
      id: crypto.randomUUID(),
      organizationId,
      ticketId: ticket.id,
      eventId,
      type: "log",
      r2Key,
      fileName: "x.log",
    });

    // Human session required — API keys cannot delete workspaces.
    const anonRes = await app.fetch(
      new Request(`https://example.com/workspaces/${organizationId}`, {
        method: "DELETE",
      }),
      env
    );
    expect([401, 403]).toContain(anonRes.status);

    const res = await app.fetch(
      new Request(`https://example.com/workspaces/${organizationId}`, {
        method: "DELETE",
        headers: { Cookie: cookie, Origin: origin },
      }),
      env
    );
    expect(res.status).toBe(200);

    expect(
      await db
        .select()
        .from(organization)
        .where(eq(organization.id, organizationId))
        .get()
    ).toBeUndefined();
    expect(
      await db
        .select()
        .from(supportTickets)
        .where(eq(supportTickets.organizationId, organizationId))
    ).toHaveLength(0);
    expect(await env.ATTACHMENTS_BUCKET.get(r2Key)).toBeNull();
  });
});
