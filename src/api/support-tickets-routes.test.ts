import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createCustomer } from "../global/support-contacts.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import {
  supportTicketEventSchema,
  supportTicketSchema,
} from "./support-tickets.js";

const ticketResponseSchema = z.object({ ticket: supportTicketSchema });
const listTicketsResponseSchema = z.object({
  tickets: z.array(z.object({ id: z.string() })),
});
const eventResponseSchema = z.object({ event: supportTicketEventSchema });
const labelResponseSchema = z.object({ id: z.string() });

let organizationId: string;
let adminToken: string;
let customerId: string;

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

  const workspaceHeaders = await createAdminHeaders(env, "user-1");
  const workspace = await createWorkspace(db, env, workspaceHeaders, {
    name: "Support ticket test workspace",
    slug: `support-ticket-test-${crypto.randomUUID()}`,
    key: `S${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-1",
  });
  const orgId = workspace!.id;

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-1",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: orgId, permissions: "admin" },
    },
  });
  const token = z.object({ key: z.string() }).parse(result).key;

  return { organizationId: orgId, token };
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${adminToken}`,
    ...extraHeaders,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return app.fetch(new Request(`https://example.com${path}`, init), env);
}

describe("support ticket routes", () => {
  beforeAll(async () => {
    const seed = await seedWorkspace();
    organizationId = seed.organizationId;
    adminToken = seed.token;

    const db = createD1(env.D1);
    const customer = await createCustomer(db, {
      organizationId,
      email: "customer@example.com",
      fullName: "Customer One",
    });
    customerId = customer.id;
  });

  it("creates a support ticket", async () => {
    const res = await request(
      "POST",
      `/workspaces/${organizationId}/support/tickets`,
      {
        customerId,
        title: "Cannot log in",
        sourceChannel: "email",
        priority: "high",
        message: {
          textContent: "I forgot my password.",
          channel: "email",
        },
      }
    );

    expect(res.status).toBe(201);
    const body = ticketResponseSchema.parse(await res.json());
    expect(body.ticket.title).toBe("Cannot log in");
    expect(body.ticket.status).toBe("todo");
    expect(body.ticket.priority).toBe("high");
    expect(body.ticket.customer.email).toBe("customer@example.com");
    expect(body.ticket.events.length).toBeGreaterThan(0);
  });

  it("lists and gets a support ticket", async () => {
    const createRes = await request(
      "POST",
      `/workspaces/${organizationId}/support/tickets`,
      {
        customerId,
        title: "List ticket test",
        sourceChannel: "chat",
      }
    );
    const createBody = ticketResponseSchema.parse(await createRes.json());
    const ticketId = createBody.ticket.id;

    const getRes = await request(
      "GET",
      `/workspaces/${organizationId}/support/tickets/${ticketId}`
    );
    expect(getRes.status).toBe(200);
    const getBody = ticketResponseSchema.parse(await getRes.json());
    expect(getBody.ticket.id).toBe(ticketId);

    const listRes = await request(
      "GET",
      `/workspaces/${organizationId}/support/tickets`
    );
    expect(listRes.status).toBe(200);
    const listBody = listTicketsResponseSchema.parse(await listRes.json());
    expect(listBody.tickets.some((t) => t.id === ticketId)).toBe(true);
  });

  it("updates a support ticket", async () => {
    const createRes = await request(
      "POST",
      `/workspaces/${organizationId}/support/tickets`,
      {
        customerId,
        title: "Update ticket test",
        sourceChannel: "email",
      }
    );
    const { ticket } = ticketResponseSchema.parse(await createRes.json());

    const patchRes = await request(
      "PATCH",
      `/workspaces/${organizationId}/support/tickets/${ticket.id}`,
      { title: "Updated title", priority: "urgent" }
    );
    expect(patchRes.status).toBe(200);
    const body = ticketResponseSchema.parse(await patchRes.json());
    expect(body.ticket.title).toBe("Updated title");
    expect(body.ticket.priority).toBe("urgent");
  });

  it("adds a message and a note", async () => {
    const createRes = await request(
      "POST",
      `/workspaces/${organizationId}/support/tickets`,
      {
        customerId,
        title: "Message note test",
        sourceChannel: "email",
      }
    );
    const { ticket } = ticketResponseSchema.parse(await createRes.json());

    const messageRes = await request(
      "POST",
      `/workspaces/${organizationId}/support/tickets/${ticket.id}/messages`,
      {
        direction: "outbound",
        textContent: "Can you try resetting?",
        channel: "email",
        userId: "user-1",
      }
    );
    expect(messageRes.status).toBe(201);
    const messageBody = eventResponseSchema.parse(await messageRes.json());
    expect(messageBody.event.message?.textContent).toBe(
      "Can you try resetting?"
    );

    const noteRes = await request(
      "POST",
      `/workspaces/${organizationId}/support/tickets/${ticket.id}/notes`,
      { body: "Internal note", userId: "user-1" }
    );
    expect(noteRes.status).toBe(201);
    const noteBody = eventResponseSchema.parse(await noteRes.json());
    expect(noteBody.event.note?.body).toBe("Internal note");
  });

  it("marks a ticket done and todo", async () => {
    const createRes = await request(
      "POST",
      `/workspaces/${organizationId}/support/tickets`,
      {
        customerId,
        title: "Status test",
        sourceChannel: "email",
      }
    );
    const { ticket } = ticketResponseSchema.parse(await createRes.json());

    const doneRes = await request(
      "POST",
      `/workspaces/${organizationId}/support/tickets/${ticket.id}/done`
    );
    expect(doneRes.status).toBe(200);
    const doneBody = ticketResponseSchema.parse(await doneRes.json());
    expect(doneBody.ticket.status).toBe("done");

    const todoRes = await request(
      "POST",
      `/workspaces/${organizationId}/support/tickets/${ticket.id}/todo`
    );
    expect(todoRes.status).toBe(200);
    const todoBody = ticketResponseSchema.parse(await todoRes.json());
    expect(todoBody.ticket.status).toBe("todo");
  });

  it("sets assignees and labels", async () => {
    const createRes = await request(
      "POST",
      `/workspaces/${organizationId}/support/tickets`,
      {
        customerId,
        title: "Assignees labels test",
        sourceChannel: "email",
      }
    );
    const { ticket } = ticketResponseSchema.parse(await createRes.json());

    const assigneesRes = await request(
      "PUT",
      `/workspaces/${organizationId}/support/tickets/${ticket.id}/assignees`,
      { assignees: [{ userId: "user-1", isPrimary: true }] }
    );
    expect(assigneesRes.status).toBe(200);
    const assigneesBody = ticketResponseSchema.parse(await assigneesRes.json());
    expect(assigneesBody.ticket.assignees.length).toBe(1);
    expect(assigneesBody.ticket.assignees[0].assigneeId).toBe("user-1");

    const labelRes = await request(
      "POST",
      `/workspaces/${organizationId}/labels`,
      { name: "bug", color: "#ff0000" }
    );
    expect(labelRes.status).toBe(201);
    const label = labelResponseSchema.parse(await labelRes.json());

    const labelsRes = await request(
      "PUT",
      `/workspaces/${organizationId}/support/tickets/${ticket.id}/labels`,
      { labels: [label.id] }
    );
    expect(labelsRes.status).toBe(200);
    const labelsBody = ticketResponseSchema.parse(await labelsRes.json());
    expect(labelsBody.ticket.labels.length).toBe(1);
    expect(labelsBody.ticket.labels[0].labelId).toBe(label.id);
  });
});
