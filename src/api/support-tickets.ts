import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { getCustomerById } from "../global/support-contacts.js";
import { maybeEscalate } from "../global/support-escalation.js";
import {
  addTicketMessage,
  addTicketNote,
  createTicket,
  getTicketById,
  listTicketEvents,
  listTickets,
  setTicketAssignees,
  setTicketLabels,
  updateTicket,
} from "../global/support-tickets.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const supportTicketStatusEnum = z.enum(["todo", "done", "snoozed"]);
const supportTicketPriorityEnum = z.enum(["low", "medium", "high", "urgent"]);
const supportTicketSourceEnum = z.enum([
  "intercom",
  "zendesk",
  "plain",
  "email",
  "slack",
  "msteams",
  "discord",
  "chat",
  "api",
  "manual",
]);
const supportTicketChannelEnum = z.enum([
  "email",
  "slack",
  "msteams",
  "discord",
  "chat",
  "capture",
  "api",
  "intercom",
  "zendesk",
  "plain",
]);
const supportTicketMessageChannelEnum = z.enum([
  "email",
  "slack",
  "msteams",
  "discord",
  "chat",
  "capture",
  "api",
  "intercom",
  "zendesk",
  "plain",
]);
const supportTicketActorTypeEnum = z.enum([
  "customer",
  "user",
  "agent",
  "automation",
]);

const supportCustomerSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string().nullable(),
  phone: z.string().nullable(),
});

const supportCompanySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  isPrimary: z.boolean(),
});

const supportCustomerIdentitySummarySchema = z.object({
  id: z.string(),
  type: z.enum([
    "email",
    "phone",
    "slack",
    "msteams",
    "discord",
    "whatsapp",
    "chat",
    "api",
    "social",
    "custom",
  ]),
  value: z.string(),
  subType: z.string().nullable(),
  isPrimary: z.boolean(),
});

const supportLabelSummarySchema = z.object({
  id: z.string(),
  labelId: z.string(),
  name: z.string(),
  color: z.string().nullable(),
});

const supportAssigneeSummarySchema = z.object({
  id: z.string(),
  type: z.enum(["user", "team"]),
  assigneeId: z.string(),
  name: z.string().nullable(),
  isPrimary: z.boolean(),
});

const supportTicketMessageSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  textContent: z.string(),
  markdownContent: z.string().nullable(),
  channel: supportTicketMessageChannelEnum,
  customerId: z.string().nullable(),
  userId: z.string().nullable(),
});

const supportTicketNoteSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  body: z.string(),
});

export const supportTicketEventSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  type: z.string(),
  subType: z.string().nullable(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  metadata: z.string().nullable(),
  createdAt: z.string(),
  message: supportTicketMessageSchema.optional(),
  note: supportTicketNoteSchema.optional(),
});

export const supportTicketSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  customerId: z.string(),
  number: z.number().int(),
  externalId: z.string().nullable(),
  externalSource: z.string(),
  title: z.string(),
  status: supportTicketStatusEnum,
  priority: supportTicketPriorityEnum,
  sourceChannel: supportTicketChannelEnum,
  issueId: z.string().nullable(),
  lastCustomerMessageAt: z.string().nullable(),
  lastAgentMessageAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  customer: supportCustomerSummarySchema,
  companies: z.array(supportCompanySummarySchema),
  identities: z.array(supportCustomerIdentitySummarySchema),
  labels: z.array(supportLabelSummarySchema),
  assignees: z.array(supportAssigneeSummarySchema),
  events: z.array(supportTicketEventSchema),
});

const createTicketBodySchema = z.object({
  customerId: z.string(),
  title: z.string().min(1),
  sourceChannel: supportTicketChannelEnum,
  priority: supportTicketPriorityEnum.default("medium"),
  status: supportTicketStatusEnum.default("todo"),
  externalId: z.string().optional(),
  externalSource: supportTicketSourceEnum.default("manual"),
  issueId: z.string().optional(),
  message: z
    .object({
      textContent: z.string(),
      markdownContent: z.string().optional(),
      channel: supportTicketMessageChannelEnum.default("chat"),
    })
    .optional(),
});

const updateTicketBodySchema = z.object({
  title: z.string().min(1).optional(),
  status: supportTicketStatusEnum.optional(),
  priority: supportTicketPriorityEnum.optional(),
  issueId: z.string().nullable().optional(),
});

const addMessageBodySchema = z.object({
  direction: z.enum(["inbound", "outbound"]),
  textContent: z.string(),
  markdownContent: z.string().optional(),
  channel: supportTicketMessageChannelEnum,
  customerId: z.string().optional(),
  userId: z.string().optional(),
  actorType: supportTicketActorTypeEnum.optional(),
  actorId: z.string().optional().nullable(),
  subType: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const addNoteBodySchema = z.object({
  body: z.string(),
  userId: z.string().optional(),
  actorType: supportTicketActorTypeEnum.optional(),
  actorId: z.string().optional().nullable(),
  subType: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const listTicketsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  customerId: z.string().optional(),
  status: supportTicketStatusEnum.optional(),
  priority: supportTicketPriorityEnum.optional(),
  assignedTo: z.string().optional(),
  q: z.string().optional(),
});

const listEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

const snoozeBodySchema = z.object({
  until: z.string(),
});

const supportTicketAssigneeSchema = z.union([
  z.object({
    userId: z.string(),
    teamId: z.string().optional(),
    isPrimary: z.boolean().default(false),
  }),
  z.object({
    userId: z.string().optional(),
    teamId: z.string(),
    isPrimary: z.boolean().default(false),
  }),
]);

const setAssigneesBodySchema = z.object({
  assignees: z.array(supportTicketAssigneeSchema),
});

const setLabelsBodySchema = z.object({
  labels: z.array(z.string()),
});

const orgParam = z.object({ organizationId: z.string() });
const ticketIdParam = z.object({
  organizationId: z.string(),
  ticketId: z.string(),
});

function ticketNotFound(): never {
  throw new VortexError({
    code: "NOT_FOUND",
    status: 404,
    message: "Ticket not found",
  });
}

const createTicketRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/tickets",
  tags: ["support-tickets"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: {
        "application/json": { schema: createTicketBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Ticket created",
      content: {
        "application/json": {
          schema: z.object({ ticket: supportTicketSchema }),
        },
      },
    },
  },
});

const listTicketsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/tickets",
  tags: ["support-tickets"],
  middleware: [rls("read")],
  request: {
    params: orgParam,
    query: listTicketsQuerySchema,
  },
  responses: {
    200: {
      description: "Tickets list",
      content: {
        "application/json": {
          schema: z.object({
            tickets: z.array(supportTicketSchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
  },
});

const getTicketRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/tickets/{ticketId}",
  tags: ["support-tickets"],
  middleware: [rls("read")],
  request: {
    params: ticketIdParam,
  },
  responses: {
    200: {
      description: "Ticket",
      content: {
        "application/json": {
          schema: z.object({ ticket: supportTicketSchema }),
        },
      },
    },
  },
});

const updateTicketRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/support/tickets/{ticketId}",
  tags: ["support-tickets"],
  middleware: [rls("write")],
  request: {
    params: ticketIdParam,
    body: {
      content: {
        "application/json": { schema: updateTicketBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Ticket updated",
      content: {
        "application/json": {
          schema: z.object({ ticket: supportTicketSchema }),
        },
      },
    },
  },
});

const addMessageRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/tickets/{ticketId}/messages",
  tags: ["support-tickets"],
  middleware: [rls("write")],
  request: {
    params: ticketIdParam,
    body: {
      content: {
        "application/json": { schema: addMessageBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Message added",
      content: {
        "application/json": {
          schema: z.object({ event: supportTicketEventSchema }),
        },
      },
    },
  },
});

const addNoteRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/tickets/{ticketId}/notes",
  tags: ["support-tickets"],
  middleware: [rls("write")],
  request: {
    params: ticketIdParam,
    body: {
      content: {
        "application/json": { schema: addNoteBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Note added",
      content: {
        "application/json": {
          schema: z.object({ event: supportTicketEventSchema }),
        },
      },
    },
  },
});

const listEventsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/tickets/{ticketId}/events",
  tags: ["support-tickets"],
  middleware: [rls("read")],
  request: {
    params: ticketIdParam,
    query: listEventsQuerySchema,
  },
  responses: {
    200: {
      description: "Ticket events",
      content: {
        "application/json": {
          schema: z.object({
            events: z.array(supportTicketEventSchema),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
  },
});

const markDoneRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/tickets/{ticketId}/done",
  tags: ["support-tickets"],
  middleware: [rls("write")],
  request: {
    params: ticketIdParam,
  },
  responses: {
    200: {
      description: "Ticket marked done",
      content: {
        "application/json": {
          schema: z.object({ ticket: supportTicketSchema }),
        },
      },
    },
  },
});

const markTodoRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/tickets/{ticketId}/todo",
  tags: ["support-tickets"],
  middleware: [rls("write")],
  request: {
    params: ticketIdParam,
  },
  responses: {
    200: {
      description: "Ticket marked todo",
      content: {
        "application/json": {
          schema: z.object({ ticket: supportTicketSchema }),
        },
      },
    },
  },
});

const snoozeRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/tickets/{ticketId}/snooze",
  tags: ["support-tickets"],
  middleware: [rls("write")],
  request: {
    params: ticketIdParam,
    body: {
      content: {
        "application/json": { schema: snoozeBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Ticket snoozed",
      content: {
        "application/json": {
          schema: z.object({ ticket: supportTicketSchema }),
        },
      },
    },
  },
});

const setAssigneesRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/support/tickets/{ticketId}/assignees",
  tags: ["support-tickets"],
  middleware: [rls("write")],
  request: {
    params: ticketIdParam,
    body: {
      content: {
        "application/json": { schema: setAssigneesBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Ticket assignees updated",
      content: {
        "application/json": {
          schema: z.object({ ticket: supportTicketSchema }),
        },
      },
    },
  },
});

const setLabelsRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/support/tickets/{ticketId}/labels",
  tags: ["support-tickets"],
  middleware: [rls("write")],
  request: {
    params: ticketIdParam,
    body: {
      content: {
        "application/json": { schema: setLabelsBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Ticket labels updated",
      content: {
        "application/json": {
          schema: z.object({ ticket: supportTicketSchema }),
        },
      },
    },
  },
});

export function registerSupportTicketRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(createTicketRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);

    const ticket = await createTicket(db, {
      organizationId,
      customerId: body.customerId,
      title: body.title,
      sourceChannel: body.sourceChannel,
      priority: body.priority,
      status: body.status,
      externalId: body.externalId,
      externalSource: body.externalSource,
      issueId: body.issueId,
    });

    const customer = await getCustomerById(
      db,
      organizationId,
      ticket.customerId
    );
    await maybeEscalate(c.env, db, organizationId, ticket, {
      text: body.message?.textContent ?? body.title,
      subject: body.title,
      customer,
      source: ticket.externalSource,
      channel: ticket.sourceChannel,
    });

    if (body.message) {
      await addTicketMessage(db, organizationId, ticket.id, {
        direction: "inbound",
        textContent: body.message.textContent,
        markdownContent: body.message.markdownContent,
        channel: body.message.channel,
        customerId: ticket.customerId,
      });
    }

    const full =
      (await getTicketById(db, organizationId, ticket.id)) ?? ticketNotFound();
    return c.json({ ticket: full }, 201);
  });

  app.openapi(listTicketsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const db = createD1(c.env.D1);
    const { tickets, nextCursor } = await listTickets(db, organizationId, {
      limit: query.limit,
      cursor: query.cursor,
      customerId: query.customerId,
      status: query.status,
      priority: query.priority,
      assignedTo: query.assignedTo,
      q: query.q,
    });

    const withRelations = await Promise.all(
      tickets.map((ticket) => getTicketById(db, organizationId, ticket.id))
    );

    return c.json({
      tickets: withRelations.filter(
        (t): t is NonNullable<typeof t> => t !== null
      ),
      nextCursor,
    });
  });

  app.openapi(getTicketRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const ticket = await getTicketById(db, organizationId, ticketId);
    if (!ticket) {
      ticketNotFound();
    }
    return c.json({ ticket });
  });

  app.openapi(updateTicketRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const ticket = await updateTicket(db, organizationId, ticketId, {
      ...body,
      actorType: "user",
      actorId: c.var.userId ?? null,
    });
    if (!ticket) {
      ticketNotFound();
    }
    const full =
      (await getTicketById(db, organizationId, ticket.id)) ?? ticketNotFound();
    return c.json({ ticket: full });
  });

  app.openapi(addMessageRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const event = await addTicketMessage(db, organizationId, ticketId, body);
    return c.json({ event }, 201);
  });

  app.openapi(addNoteRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const event = await addTicketNote(db, organizationId, ticketId, body);
    return c.json({ event }, 201);
  });

  app.openapi(listEventsRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const query = c.req.valid("query");
    const db = createD1(c.env.D1);
    const events = await listTicketEvents(db, organizationId, ticketId, {
      limit: query.limit,
      cursor: query.cursor,
    });
    const hasMore = events.length > query.limit;
    const sliced = hasMore ? events.slice(0, query.limit) : events;
    const nextCursor = hasMore ? sliced[sliced.length - 1].createdAt : null;
    return c.json({
      events: sliced,
      nextCursor,
    });
  });

  app.openapi(markDoneRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await updateTicket(db, organizationId, ticketId, {
      status: "done",
      actorType: "user",
    });
    const full =
      (await getTicketById(db, organizationId, ticketId)) ?? ticketNotFound();
    return c.json({ ticket: full });
  });

  app.openapi(markTodoRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await updateTicket(db, organizationId, ticketId, {
      status: "todo",
      actorType: "user",
    });
    const full =
      (await getTicketById(db, organizationId, ticketId)) ?? ticketNotFound();
    return c.json({ ticket: full });
  });

  app.openapi(snoozeRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    c.req.valid("json");
    const db = createD1(c.env.D1);
    await updateTicket(db, organizationId, ticketId, {
      status: "snoozed",
      actorType: "user",
    });
    const full =
      (await getTicketById(db, organizationId, ticketId)) ?? ticketNotFound();
    return c.json({ ticket: full });
  });

  app.openapi(setAssigneesRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const { assignees } = c.req.valid("json");
    const db = createD1(c.env.D1);
    await setTicketAssignees(db, organizationId, ticketId, assignees);
    const full =
      (await getTicketById(db, organizationId, ticketId)) ?? ticketNotFound();
    return c.json({ ticket: full });
  });

  app.openapi(setLabelsRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const { labels: labelIds } = c.req.valid("json");
    const db = createD1(c.env.D1);
    await setTicketLabels(db, organizationId, ticketId, labelIds);
    const full =
      (await getTicketById(db, organizationId, ticketId)) ?? ticketNotFound();
    return c.json({ ticket: full });
  });
}
