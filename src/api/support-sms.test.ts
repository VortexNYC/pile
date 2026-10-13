import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import {
  organization as organizationTable,
  supportSmsThreads,
  supportTicketEvents,
  supportTicketMessages,
  supportTickets,
} from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

const ORIGIN = "http://localhost";
const now = new Date();

const groupPost = (groupId: string) =>
  app.fetch(
    new Request(`${ORIGIN}/support/sms/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_number: "+15550007777",
        to_number: "+15040001111",
        content: "group ping",
        group_id: groupId,
      }),
    }),
    env
  );

describe("support-sms", () => {
  let organizationId = "";

  beforeAll(async () => {
    const db = createD1(env.D1);
    const userTable = (await import("../global/schema.js")).user;
    await db
      .insert(userTable)
      .values({
        id: "sms-user-1",
        name: "SMS Test User",
        email: "sms-user-1@example.com",
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, "sms-user-1");
    const workspace = await createWorkspace(db, env, headers, {
      name: "SMS workspace",
      slug: `sms-${crypto.randomUUID()}`,
      key: `S${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      ownerId: "sms-user-1",
    });
    organizationId = workspace!.id;
    // The number this deployment's Sendblue account routes to this org.
    await db
      .update(organizationTable)
      .set({ metadata: JSON.stringify({ smsNumber: "+15040001111" }) })
      .where(eq(organizationTable.id, organizationId))
      .run();
    const auth = await createAuth(env);
    await auth.api.createApiKey({
      body: {
        userId: "sms-user-1",
        name: "sms-test-admin",
        metadata: { organizationId, permissions: "admin" },
      },
    });
  });

  it("creates a thread, ticket, and inbound message from an sms", async () => {
    const res = await app.fetch(
      new Request(`${ORIGIN}/support/sms/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_number: "+15550001234",
          to_number: "+15040001111",
          content: "store hours today?",
        }),
      }),
      env
    );
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 300));
    const db = createD1(env.D1);
    const [thread] = await db
      .select()
      .from(supportSmsThreads)
      .where(eq(supportSmsThreads.phone, "+15550001234"))
      .limit(1);
    expect(thread).toBeDefined();
    const [ticket] = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, thread.ticketId!))
      .limit(1);
    expect(ticket.sourceChannel).toBe("sms");
    const events = await db
      .select({ id: supportTicketEvents.id })
      .from(supportTicketEvents)
      .where(eq(supportTicketEvents.ticketId, ticket.id))
      .all();
    const inbound = await db
      .select()
      .from(supportTicketMessages)
      .where(eq(supportTicketMessages.eventId, events.map((e) => e.id)[0]!))
      .all();
    expect(inbound.some((m) => m.textContent === "store hours today?")).toBe(
      true
    );
  });

  it("accepts unknown numbers silently", async () => {
    const res = await app.fetch(
      new Request(`${ORIGIN}/support/sms/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_number: "+15550009999",
          to_number: "+19999999999",
          content: "wrong number",
        }),
      }),
      env
    );
    expect(res.status).toBe(202);
  });
  it("groups inbound texts on group_id into one thread", async () => {
    const r1 = await groupPost("g_abc123");
    expect(r1.status).toBe(202);
    const r2 = await groupPost("g_abc123");
    expect(r2.status).toBe(202);
    await new Promise((r) => setTimeout(r, 400));
    const db = createD1(env.D1);
    const threads = await db
      .select()
      .from(supportSmsThreads)
      .where(eq(supportSmsThreads.groupId, "g_abc123"))
      .all();
    expect(threads).toHaveLength(1);
  });
});
