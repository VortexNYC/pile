import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { apikey as apikeyTable, user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";

const ORIGIN = "https://your-domain.com";

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

  const workspace = await createWorkspace(db, env, {
    name: "Test workspace",
    slug: `test-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-1",
  });

  return workspace!.id;
}

async function createAdminTokenRecord(organizationId: string) {
  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-1",
      name: "test-admin",
      metadata: { organizationId, permissions: "admin" },
    },
  });
  const parsed = z.object({ id: z.string(), key: z.string() }).parse(result);
  const db = createD1(env.D1);
  await db
    .update(apikeyTable)
    .set({ rateLimitEnabled: false })
    .where(eq(apikeyTable.id, parsed.id));
  return { id: parsed.id, token: parsed.key };
}

describe("support-tickets API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    organizationId = await seedWorkspace();
    const record = await createAdminTokenRecord(organizationId);
    token = record.token;
  });

  function fetch(path: string, init: RequestInit = {}) {
    const request = new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    return app.fetch(request, env);
  }

  async function createCustomer(overrides: { email: string; fullName?: string }) {
    const res = await fetch(`/workspaces/${organizationId}/support/customers`, {
      method: "POST",
      body: JSON.stringify(overrides),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { customer: { id: string } };
    return body.customer.id;
  }

  it("creates, gets, lists, and updates a ticket", async () => {
    const customerId = await createCustomer({
      email: "ticket-test@example.com",
      fullName: "Ticket Tester",
    });

    const createRes = await fetch(`/workspaces/${organizationId}/support/tickets`, {
      method: "POST",
      body: JSON.stringify({
        customerId,
        title: "Cannot log in",
        sourceChannel: "email",
        priority: "high",
        message: {
          textContent: "I forgot my password",
        },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      ticket: { id: string; number: number; status: string; events: unknown[] };
    };
    expect(created.ticket.number).toBeGreaterThanOrEqual(1);
    expect(created.ticket.status).toBe("todo");
    expect(created.ticket.events.length).toBeGreaterThanOrEqual(1);

    const getRes = await fetch(
      `/workspaces/${organizationId}/support/tickets/${created.ticket.id}`
    );
    expect(getRes.status).toBe(200);
    const got = (await getRes.json()) as { ticket: { id: string; title: string } };
    expect(got.ticket.title).toBe("Cannot log in");

    const listRes = await fetch(`/workspaces/${organizationId}/support/tickets?q=log+in`);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { tickets: unknown[] };
    expect(list.tickets.length).toBeGreaterThanOrEqual(1);

    const patchRes = await fetch(
      `/workspaces/${organizationId}/support/tickets/${created.ticket.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "snoozed",
          priority: "low",
        }),
      }
    );
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      ticket: { status: string; priority: string };
    };
    expect(patched.ticket.status).toBe("snoozed");
    expect(patched.ticket.priority).toBe("low");
  });

  it("adds messages, notes, and lists the event timeline", async () => {
    const customerId = await createCustomer({
      email: "timeline@example.com",
      fullName: "Timeline Tester",
    });

    const createRes = await fetch(`/workspaces/${organizationId}/support/tickets`, {
      method: "POST",
      body: JSON.stringify({
        customerId,
        title: "Bug report",
        sourceChannel: "chat",
      }),
    });
    const { ticket } = (await createRes.json()) as { ticket: { id: string } };

    const messageRes = await fetch(
      `/workspaces/${organizationId}/support/tickets/${ticket.id}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          direction: "outbound",
          textContent: "We are looking into this",
          channel: "chat",
          userId: "user-1",
        }),
      }
    );
    expect(messageRes.status).toBe(201);
    const message = (await messageRes.json()) as {
      event: { type: string; message: { textContent: string } };
    };
    expect(message.event.type).toBe("message");
    expect(message.event.message.textContent).toBe("We are looking into this");

    const noteRes = await fetch(
      `/workspaces/${organizationId}/support/tickets/${ticket.id}/notes`,
      {
        method: "POST",
        body: JSON.stringify({
          body: "Escalate to engineering",
          userId: "user-1",
        }),
      }
    );
    expect(noteRes.status).toBe(201);
    const note = (await noteRes.json()) as {
      event: { type: string; note: { body: string } };
    };
    expect(note.event.type).toBe("note");
    expect(note.event.note.body).toBe("Escalate to engineering");

    const eventsRes = await fetch(
      `/workspaces/${organizationId}/support/tickets/${ticket.id}/events`
    );
    expect(eventsRes.status).toBe(200);
    const events = (await eventsRes.json()) as { events: unknown[] };
    expect(events.events.length).toBeGreaterThanOrEqual(2);

    const doneRes = await fetch(
      `/workspaces/${organizationId}/support/tickets/${ticket.id}/done`,
      { method: "POST" }
    );
    expect(doneRes.status).toBe(200);
    const done = (await doneRes.json()) as { ticket: { status: string } };
    expect(done.ticket.status).toBe("done");

    const todoRes = await fetch(
      `/workspaces/${organizationId}/support/tickets/${ticket.id}/todo`,
      { method: "POST" }
    );
    expect(todoRes.status).toBe(200);
    const todo = (await todoRes.json()) as { ticket: { status: string } };
    expect(todo.ticket.status).toBe("todo");
  });
});
