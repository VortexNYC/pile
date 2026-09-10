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
import {
  createCustomer as createSupportCustomer,
  createCompany,
  getCustomerById,
  setCustomerCompanies,
  setCustomerIdentities,
} from "../global/support-contacts.js";
import {
  createTicketFromIntercom,
  createTicketFromPlain,
  createTicketFromZendesk,
  findOrCreateTeam,
  findUserByEmail,
  getTicketById,
  setTicketAssignees,
} from "../global/support-tickets.js";
import { createWorkspace } from "../global/workspaces.js";
import { intercomSupportOptionsSchema } from "../import/intercom-support.js";
import { plainSupportOptionsSchema } from "../import/plain-support.js";
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
            subType: "comment",
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
            subType: "note",
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
            subType: "close",
            actorType: "automation",
            actorId: null,
            createdAt: "2023-11-14T11:21:00.000Z",
            metadata: { previousStatus: "open", newStatus: "closed" },
          },
          {
            type: "survey_received",
            subType: "conversation_rating",
            actorType: "customer",
            actorId: "contact-1",
            createdAt: "2023-11-14T11:22:00.000Z",
            metadata: { rating: "5" },
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
    expect(noteEvent?.subType).toBe("note");
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
    expect(messageEvent?.subType).toBe("comment");
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
    expect(statusEvent?.subType).toBe("close");
    expect(statusEvent?.metadata).toContain("previousStatus");

    const surveyEvent = events.find((e) => e.type === "survey_received");
    expect(surveyEvent).toBeDefined();
    expect(surveyEvent?.subType).toBe("conversation_rating");
    expect(surveyEvent?.actorType).toBe("customer");
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
            actorType: "agent",
            actorId: "bot-1",
            subType: "ChatEntry",
            createdAt: "2023-11-14T12:02:00.000Z",
          },
          {
            body: "Internal note: triage",
            direction: "outbound",
            kind: "note",
            actorType: "user",
            actorId: "agent-1",
            subType: "NoteEntry",
            createdAt: "2023-11-14T12:03:00.000Z",
          },
        ],
        events: [
          {
            type: "priority_change",
            subType: "ThreadPriorityChangedEntry",
            actorType: "automation",
            actorId: null,
            createdAt: "2023-11-14T12:04:00.000Z",
            metadata: { previousPriority: "medium", newPriority: "low" },
          },
          {
            type: "sla_change",
            subType: "ServiceLevelAgreementStatusTransitionedEntry",
            actorType: "automation",
            actorId: null,
            createdAt: "2023-11-14T12:04:30.000Z",
            metadata: {
              previousStatus: "IMMINENT_BREACH",
              nextStatus: "BREACHED",
            },
          },
          {
            type: "survey_requested",
            subType: "CustomerSurveyRequestedEntry",
            actorType: "automation",
            actorId: null,
            createdAt: "2023-11-14T12:04:45.000Z",
            metadata: { customerSurveyId: "survey-1" },
          },
          {
            type: "link_added",
            subType: "ThreadLinkCreatedEntry",
            actorType: "user",
            actorId: "agent-1",
            createdAt: "2023-11-14T12:05:00.000Z",
            metadata: { threadLink: { id: "link-1", title: "Related bug" } },
          },
          {
            type: "custom_entry",
            subType: "CustomEntry",
            actorType: "automation",
            actorId: null,
            createdAt: "2023-11-14T12:05:30.000Z",
            metadata: { title: "Order status", type: "tracking" },
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
    expect(noteEvent?.subType).toBe("NoteEntry");

    const agentEvent = events.find(
      (e) => e.type === "message" && e.actorType === "agent"
    );
    expect(agentEvent?.actorId).toBe("bot-1");
    expect(agentEvent?.subType).toBe("ChatEntry");

    const priorityEvent = events.find((e) => e.type === "priority_change");
    expect(priorityEvent).toBeDefined();
    expect(priorityEvent?.subType).toBe("ThreadPriorityChangedEntry");
    expect(priorityEvent?.metadata).toContain("previousPriority");

    const slaEvent = events.find((e) => e.type === "sla_change");
    expect(slaEvent).toBeDefined();
    expect(slaEvent?.subType).toBe(
      "ServiceLevelAgreementStatusTransitionedEntry"
    );

    const surveyEvent = events.find((e) => e.type === "survey_requested");
    expect(surveyEvent).toBeDefined();
    expect(surveyEvent?.subType).toBe("CustomerSurveyRequestedEntry");

    const linkEvent = events.find((e) => e.type === "link_added");
    expect(linkEvent).toBeDefined();
    expect(linkEvent?.subType).toBe("ThreadLinkCreatedEntry");

    const customEvent = events.find((e) => e.type === "custom_entry");
    expect(customEvent).toBeDefined();
    expect(customEvent?.subType).toBe("CustomEntry");
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
            subType: "Comment",
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
            subType: "InternalComment",
            createdAt: "2023-11-14T13:03:00.000Z",
          },
        ],
        events: [
          {
            type: "assignment_change",
            subType: "Change:group_id",
            actorType: "automation",
            actorId: null,
            createdAt: "2023-11-14T13:04:00.000Z",
            metadata: { assigneeId: "group-billing" },
          },
          {
            type: "label_added",
            subType: "Change:tags",
            actorType: "user",
            actorId: "agent-1",
            createdAt: "2023-11-14T13:04:30.000Z",
            metadata: { tag: "billing" },
          },
          {
            type: "survey_received",
            subType: "SatisfactionRating",
            actorType: "customer",
            actorId: "requester-1",
            createdAt: "2023-11-14T13:05:00.000Z",
            metadata: { score: "good" },
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
    expect(noteEvent?.subType).toBe("InternalComment");

    const messageEvent = events.find(
      (e) => e.type === "message" && e.actorId === "agent-1"
    );
    expect(messageEvent).toBeDefined();
    expect(messageEvent?.subType).toBe("Comment");

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
    expect(assignmentEvent?.subType).toBe("Change:group_id");
    expect(assignmentEvent?.metadata).toContain("assigneeId");

    const labelEvent = events.find((e) => e.type === "label_added");
    expect(labelEvent).toBeDefined();
    expect(labelEvent?.subType).toBe("Change:tags");

    const surveyEvent = events.find((e) => e.type === "survey_received");
    expect(surveyEvent).toBeDefined();
    expect(surveyEvent?.subType).toBe("SatisfactionRating");
    expect(surveyEvent?.actorType).toBe("customer");
  });

  it("preserves customer companies and identities", async () => {
    const db = createD1(env.D1);
    const customer = await createSupportCustomer(db, {
      organizationId,
      email: "contact@acme.example",
      fullName: "Contact Person",
      externalId: null,
      externalSource: null,
    });

    const company = await createCompany(db, {
      organizationId,
      name: "Acme",
      domain: "acme.example",
      externalId: "acme-123",
      externalSource: "test",
    });

    await setCustomerCompanies(db, organizationId, customer.id, [
      { companyId: company.id, isPrimary: true },
    ]);

    await setCustomerIdentities(db, organizationId, customer.id, [
      {
        type: "email",
        subType: "work",
        value: "contact@acme.example",
        isPrimary: true,
      },
      {
        type: "slack",
        subType: "SlackCustomerIdentity",
        value: "U123456",
        isPrimary: false,
      },
      {
        type: "social",
        subType: "twitter",
        value: "@acme_support",
        isPrimary: false,
      },
    ]);

    const fetched = await getCustomerById(db, organizationId, customer.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.companies.length).toBe(1);
    expect(fetched?.companies[0]?.companyId).toBe(company.id);
    expect(fetched?.companies[0]?.isPrimary).toBe(true);

    const emailIdentity = fetched?.identities.find((i) => i.type === "email");
    expect(emailIdentity?.value).toBe("contact@acme.example");
    expect(emailIdentity?.subType).toBe("work");

    const socialIdentity = fetched?.identities.find((i) => i.type === "social");
    expect(socialIdentity?.subType).toBe("twitter");
  });

  it("populates ticket assignments from provider agent emails", async () => {
    const db = createD1(env.D1);
    const user = await findUserByEmail(db, "user-1@example.com");
    expect(user).not.toBeNull();

    const customer = await createSupportCustomer(db, {
      organizationId,
      email: "assigned@example.com",
      fullName: "Assigned Customer",
      externalId: null,
      externalSource: null,
    });

    const ticket = await createTicketFromPlain(
      db,
      organizationId,
      customer.id,
      {
        id: "thread-assigned",
        status: "todo",
        priority: "medium",
        source: {
          type: "chat",
          body: "I need help",
        },
        createdAt: "2023-11-14T14:00:00.000Z",
        updatedAt: "2023-11-14T14:00:00.000Z",
        replies: [],
        events: [],
      }
    );

    await setTicketAssignees(db, organizationId, ticket.id, [
      { userId: user!.id, isPrimary: true },
    ]);

    const fetched = await getTicketById(db, organizationId, ticket.id);
    expect(fetched?.assignees.length).toBe(1);
    expect(fetched?.assignees[0]?.type).toBe("user");
    expect(fetched?.assignees[0]?.assigneeId).toBe(user!.id);
    expect(fetched?.assignees[0]?.isPrimary).toBe(true);
  });

  it("populates ticket assignments for a team", async () => {
    const db = createD1(env.D1);
    const team = await findOrCreateTeam(
      db,
      organizationId,
      "Support",
      "user-1"
    );

    const customer = await createSupportCustomer(db, {
      organizationId,
      email: "team-assigned@example.com",
      fullName: "Team Assigned Customer",
      externalId: null,
      externalSource: null,
    });

    const ticket = await createTicketFromPlain(
      db,
      organizationId,
      customer.id,
      {
        id: "thread-team",
        status: "todo",
        priority: "medium",
        source: {
          type: "chat",
          body: "I need help",
        },
        createdAt: "2023-11-14T14:00:00.000Z",
        updatedAt: "2023-11-14T14:00:00.000Z",
        replies: [],
        events: [],
      }
    );

    await setTicketAssignees(db, organizationId, ticket.id, [
      { teamId: team.id, isPrimary: true },
    ]);

    const fetched = await getTicketById(db, organizationId, ticket.id);
    expect(fetched?.assignees.length).toBe(1);
    expect(fetched?.assignees[0]?.type).toBe("team");
    expect(fetched?.assignees[0]?.assigneeId).toBe(team.id);
    expect(fetched?.assignees[0]?.isPrimary).toBe(true);
  });

  it("populates ticket assignments for both a user and a team", async () => {
    const db = createD1(env.D1);
    const user = await findUserByEmail(db, "user-1@example.com");
    const team = await findOrCreateTeam(
      db,
      organizationId,
      "Zendesk Group",
      "user-1"
    );

    const customer = await createSupportCustomer(db, {
      organizationId,
      email: "mixed-assigned@example.com",
      fullName: "Mixed Assigned Customer",
      externalId: null,
      externalSource: null,
    });

    const ticket = await createTicketFromPlain(
      db,
      organizationId,
      customer.id,
      {
        id: "thread-mixed",
        status: "todo",
        priority: "medium",
        source: {
          type: "chat",
          body: "I need help",
        },
        createdAt: "2023-11-14T14:00:00.000Z",
        updatedAt: "2023-11-14T14:00:00.000Z",
        replies: [],
        events: [],
      }
    );

    await setTicketAssignees(db, organizationId, ticket.id, [
      { userId: user!.id, isPrimary: true },
      { teamId: team.id, isPrimary: false },
    ]);

    const fetched = await getTicketById(db, organizationId, ticket.id);
    expect(fetched?.assignees.length).toBe(2);

    const userAssignee = fetched?.assignees.find((a) => a.type === "user");
    expect(userAssignee?.assigneeId).toBe(user!.id);
    expect(userAssignee?.isPrimary).toBe(true);

    const teamAssignee = fetched?.assignees.find((a) => a.type === "team");
    expect(teamAssignee?.assigneeId).toBe(team.id);
    expect(teamAssignee?.isPrimary).toBe(false);
  });

  it("requires a teamId or teamName for Plain support imports", () => {
    const missing = plainSupportOptionsSchema.safeParse({});
    expect(missing.success).toBe(false);

    const byId = plainSupportOptionsSchema.safeParse({ teamId: "team-id" });
    expect(byId.success).toBe(true);

    const byName = plainSupportOptionsSchema.safeParse({
      teamName: "Support",
    });
    expect(byName.success).toBe(true);
  });

  it("accepts teamId or teamName for Intercom support imports", () => {
    const byId = intercomSupportOptionsSchema.safeParse({
      teamId: "team-id",
    });
    expect(byId.success).toBe(true);

    const byName = intercomSupportOptionsSchema.safeParse({
      teamName: "Support",
    });
    expect(byName.success).toBe(true);
  });
});
