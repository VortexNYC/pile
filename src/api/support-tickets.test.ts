import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import {
  apikey as apikeyTable,
  supportTicketAttachments,
  supportTicketEvents,
  supportTicketNotes,
  user as userTable,
} from "../global/schema.js";
import { createCustomer as createSupportCustomer } from "../global/support-contacts.js";
import {
  createTicketFromIntercom,
  createTicketFromPlain,
  createTicketFromZendesk,
} from "../global/support-tickets.js";
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

  async function createCustomer(overrides: {
    email: string;
    fullName?: string;
  }) {
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

    const createRes = await fetch(
      `/workspaces/${organizationId}/support/tickets`,
      {
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
      }
    );
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
    const got = (await getRes.json()) as {
      ticket: { id: string; title: string };
    };
    expect(got.ticket.title).toBe("Cannot log in");

    const listRes = await fetch(
      `/workspaces/${organizationId}/support/tickets?q=log+in`
    );
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

    const createRes = await fetch(
      `/workspaces/${organizationId}/support/tickets`,
      {
        method: "POST",
        body: JSON.stringify({
          customerId,
          title: "Bug report",
          sourceChannel: "chat",
        }),
      }
    );
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

  it("assigns monotonic per-workspace ticket numbers", async () => {
    const customerId = await createCustomer({
      email: "numbering-1@example.com",
      fullName: "Numbering One",
    });

    const firstRes = await fetch(
      `/workspaces/${organizationId}/support/tickets`,
      {
        method: "POST",
        body: JSON.stringify({
          customerId,
          title: "First ticket",
          sourceChannel: "chat",
        }),
      }
    );
    expect(firstRes.status).toBe(201);
    const first = (await firstRes.json()) as { ticket: { number: number } };
    expect(first.ticket.number).toBeGreaterThanOrEqual(1);

    const secondRes = await fetch(
      `/workspaces/${organizationId}/support/tickets`,
      {
        method: "POST",
        body: JSON.stringify({
          customerId,
          title: "Second ticket",
          sourceChannel: "chat",
        }),
      }
    );
    expect(secondRes.status).toBe(201);
    const second = (await secondRes.json()) as { ticket: { number: number } };
    expect(second.ticket.number).toBe(first.ticket.number + 1);
  });

  it("rejects creating a ticket for a customer outside the workspace", async () => {
    const res = await fetch(`/workspaces/${organizationId}/support/tickets`, {
      method: "POST",
      body: JSON.stringify({
        customerId: crypto.randomUUID(),
        title: "Orphan ticket",
        sourceChannel: "chat",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("imports an Intercom conversation as a support ticket", async () => {
    const db = createD1(env.D1);
    const customer = await createSupportCustomer(db, {
      organizationId,
      email: "intercom@example.com",
      fullName: "Intercom Customer",
      externalId: null,
      externalSource: null,
    });

    const ticket = await createTicketFromIntercom(
      db,
      organizationId,
      customer.id,
      {
        id: "conv-123",
        state: "open",
        priority: "high",
        source: {
          type: "email",
          subject: "Cannot log in",
          body: "<p>I forgot my password</p>",
        },
        created_at: 1700000000,
        updated_at: 1700000100,
        replies: [
          {
            body: "We can reset it for you",
            direction: "outbound",
            actorType: "user",
            actorId: "admin-1",
            createdAt: "2023-11-14T11:15:00.000Z",
            attachments: [
              {
                externalId: "att-1",
                url: "https://example.com/faq.pdf",
                fileName: "faq.pdf",
                contentType: "application/pdf",
                size: 12345,
              },
            ],
          },
          {
            body: "<p>Internal: escalate this</p>",
            direction: "outbound",
            kind: "note",
            actorType: "user",
            actorId: "admin-2",
            createdAt: "2023-11-14T11:16:00.000Z",
          },
          {
            body: "That worked, thanks",
            direction: "inbound",
            createdAt: "2023-11-14T11:20:00.000Z",
          },
        ],
        events: [
          {
            type: "status_change",
            actorType: "system",
            actorId: null,
            createdAt: "2023-11-14T11:21:00.000Z",
            metadata: { previousStatus: "open", newStatus: "closed" },
          },
        ],
      }
    );

    expect(ticket.status).toBe("todo");
    expect(ticket.priority).toBe("high");
    expect(ticket.events.length).toBeGreaterThanOrEqual(5);

    const events = await db
      .select()
      .from(supportTicketEvents)
      .where(eq(supportTicketEvents.ticketId, ticket.id));

    const noteEvent = events.find((e) => e.type === "note");
    expect(noteEvent).toBeDefined();
    expect(noteEvent?.actorType).toBe("user");
    expect(noteEvent?.actorId).toBe("admin-2");
    if (!noteEvent) {
      throw new Error("note event missing");
    }

    const notes = await db
      .select()
      .from(supportTicketNotes)
      .where(eq(supportTicketNotes.eventId, noteEvent.id));
    expect(notes[0]?.body).toBe("Internal: escalate this");

    const messageEvent = events.find(
      (e) => e.type === "message" && e.actorType === "user"
    );
    expect(messageEvent?.actorId).toBe("admin-1");
    if (!messageEvent) {
      throw new Error("message event missing");
    }

    const attachments = await db
      .select()
      .from(supportTicketAttachments)
      .where(eq(supportTicketAttachments.eventId, messageEvent.id));
    expect(attachments.length).toBe(1);
    expect(attachments[0]?.externalId).toBe("att-1");
    expect(attachments[0]?.url).toBe("https://example.com/faq.pdf");
    expect(attachments[0]?.fileName).toBe("faq.pdf");

    const statusEvent = events.find((e) => e.type === "status_change");
    expect(statusEvent).toBeDefined();
    expect(statusEvent?.metadata).toContain("previousStatus");
  });

  it("imports a Plain thread as a support ticket", async () => {
    const db = createD1(env.D1);
    const customer = await createSupportCustomer(db, {
      organizationId,
      email: "plain@example.com",
      fullName: "Plain Customer",
      externalId: null,
      externalSource: null,
    });

    const ticket = await createTicketFromPlain(
      db,
      organizationId,
      customer.id,
      {
        id: "thread-456",
        status: "done",
        priority: "low",
        source: {
          type: "chat",
          body: "Feature request: dark mode",
        },
        createdAt: "2023-11-14T12:00:00.000Z",
        updatedAt: "2023-11-14T12:05:00.000Z",
        replies: [
          {
            body: "Thanks for the suggestion",
            direction: "outbound",
            actorType: "machine",
            actorId: "bot-1",
            createdAt: "2023-11-14T12:02:00.000Z",
          },
          {
            body: "Internal note: triage",
            direction: "outbound",
            kind: "note",
            actorType: "user",
            actorId: "agent-1",
            createdAt: "2023-11-14T12:03:00.000Z",
          },
        ],
        events: [
          {
            type: "priority_change",
            actorType: "system",
            actorId: null,
            createdAt: "2023-11-14T12:04:00.000Z",
            metadata: { previousPriority: "medium", newPriority: "low" },
          },
        ],
      }
    );

    expect(ticket.status).toBe("done");
    expect(ticket.priority).toBe("low");
    expect(ticket.externalSource).toBe("plain");

    const events = await db
      .select()
      .from(supportTicketEvents)
      .where(eq(supportTicketEvents.ticketId, ticket.id));

    const noteEvent = events.find(
      (e) => e.type === "note" && e.actorType === "user"
    );
    expect(noteEvent?.actorId).toBe("agent-1");

    const machineEvent = events.find(
      (e) => e.type === "message" && e.actorType === "machine"
    );
    expect(machineEvent?.actorId).toBe("bot-1");

    const priorityEvent = events.find((e) => e.type === "priority_change");
    expect(priorityEvent).toBeDefined();
    expect(priorityEvent?.metadata).toContain("previousPriority");
  });

  it("imports a Zendesk ticket as a support ticket", async () => {
    const db = createD1(env.D1);
    const customer = await createSupportCustomer(db, {
      organizationId,
      email: "zendesk@example.com",
      fullName: "Zendesk Customer",
      externalId: null,
      externalSource: null,
    });

    const ticket = await createTicketFromZendesk(
      db,
      organizationId,
      customer.id,
      {
        id: "zd-789",
        status: "open",
        priority: "urgent",
        subject: "Refund request",
        description: "I need a refund for my last purchase",
        createdAt: "2023-11-14T13:00:00.000Z",
        updatedAt: "2023-11-14T13:05:00.000Z",
        replies: [
          {
            body: "Can you provide the order number?",
            direction: "outbound",
            actorType: "user",
            actorId: "agent-1",
            createdAt: "2023-11-14T13:02:00.000Z",
            attachments: [
              {
                externalId: "att-99",
                url: "https://example.com/receipt.pdf",
                fileName: "receipt.pdf",
                contentType: "application/pdf",
                size: 54321,
              },
            ],
          },
          {
            body: "Escalating to billing team",
            direction: "outbound",
            kind: "note",
            actorType: "user",
            actorId: "agent-2",
            createdAt: "2023-11-14T13:03:00.000Z",
          },
        ],
        events: [
          {
            type: "assignment_change",
            actorType: "system",
            actorId: null,
            createdAt: "2023-11-14T13:04:00.000Z",
            metadata: { assigneeId: "group-billing" },
          },
        ],
      }
    );

    expect(ticket.status).toBe("todo");
    expect(ticket.priority).toBe("urgent");
    expect(ticket.externalSource).toBe("zendesk");

    const events = await db
      .select()
      .from(supportTicketEvents)
      .where(eq(supportTicketEvents.ticketId, ticket.id));

    const noteEvent = events.find((e) => e.type === "note");
    expect(noteEvent?.actorType).toBe("user");
    expect(noteEvent?.actorId).toBe("agent-2");

    const messageEvent = events.find(
      (e) => e.type === "message" && e.actorId === "agent-1"
    );
    expect(messageEvent).toBeDefined();

    const attachments = messageEvent
      ? await db
          .select()
          .from(supportTicketAttachments)
          .where(eq(supportTicketAttachments.eventId, messageEvent.id))
      : [];
    expect(attachments.length).toBe(1);
    expect(attachments[0]?.externalId).toBe("att-99");
    expect(attachments[0]?.url).toBe("https://example.com/receipt.pdf");

    const assignmentEvent = events.find((e) => e.type === "assignment_change");
    expect(assignmentEvent).toBeDefined();
    expect(assignmentEvent?.metadata).toContain("assigneeId");
  });
});
