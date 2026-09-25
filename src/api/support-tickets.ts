import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { supportTicketAttachments } from "../global/schema.js";
import { getCustomerById } from "../global/support-contacts.js";
import { maybeEscalate } from "../global/support-escalation.js";
import {
  addTicketMessage,
  addTicketNote,
  addTicketVote,
  createTicket,
  getTicketById,
  hydrateTicketRelations,
  listTicketEvents,
  listTicketVotes,
  listTickets,
  removeTicketVote,
  setTicketAssignees,
  setTicketLabels,
  updateTicket,
} from "../global/support-tickets.js";
import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
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
  "linear",
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
  "linear",
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
  externalId: z.string().nullable(),
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
  snoozedUntil: z.string().nullable(),
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
  snoozedUntil: z.string().datetime().nullable().optional(),
  issueId: z.string().nullable().optional(),
  actorType: supportTicketActorTypeEnum.optional(),
  actorId: z.string().nullable().optional(),
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
  sourceChannel: supportTicketChannelEnum.optional(),
  externalSource: supportTicketSourceEnum.optional(),
  assignedTo: z.string().optional(),
  q: z.string().optional(),
});

const listEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

const snoozeBodySchema = z.object({
  until: z.string().datetime(),
  actorType: supportTicketActorTypeEnum.optional(),
  actorId: z.string().nullable().optional(),
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

function resolveActor(
  identity: WorkspaceIdentity,
  input?: {
    actorType?: z.infer<typeof supportTicketActorTypeEnum>;
    actorId?: string | null;
  }
): {
  actorType: z.infer<typeof supportTicketActorTypeEnum>;
  actorId: string | null;
} {
  const actorType =
    input?.actorType ?? (identity.type === "agent" ? "agent" : "user");
  const identityActor =
    actorType === "customer" ? null : (input?.actorId ?? identity.id);
  const actorId = input?.actorId ?? identityActor;
  return { actorType, actorId };
}

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

const ticketArtifactSchema = z.object({
  id: z.string(),
  type: z.string(),
  fileName: z.string().nullable(),
  contentType: z.string().nullable(),
  size: z.number().nullable(),
  url: z.string().nullable(),
  available: z.boolean(),
  content: z.unknown().optional(),
});

const listTicketArtifactsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/tickets/{ticketId}/artifacts",
  tags: ["support-tickets"],
  middleware: [rls("read")],
  request: {
    params: ticketIdParam,
  },
  responses: {
    200: {
      description:
        "Ticket artifacts — attachments with inline content for text/JSON payloads (debugger.json, network logs, replay HTML). One call gives an agent the full capture bundle for debugging.",
      content: {
        "application/json": {
          schema: z.object({ artifacts: z.array(ticketArtifactSchema) }),
        },
      },
    },
    404: { description: "Ticket not found" },
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

const votePriorityEnum = z.enum(["nice_to_have", "important", "must_have"]);

const ticketVoteSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  customerId: z.string().nullable(),
  voterEmail: z.string(),
  priority: votePriorityEnum.nullable(),
  castByActorType: z.enum(["user", "agent"]).nullable(),
  castByActorId: z.string().nullable(),
  sourceTicketId: z.string().nullable(),
  createdAt: z.string(),
});

const addVoteBodySchema = z.object({
  email: z.string().trim().email(),
  customerId: z.string().optional(),
  priority: votePriorityEnum.nullish(),
  sourceTicketId: z.string().optional(),
});

const removeVoteQuerySchema = z
  .object({
    voteId: z.string().optional(),
    email: z.string().trim().email().optional(),
  })
  .refine((v) => v.voteId !== undefined || v.email !== undefined, {
    message: "voteId or email is required",
  });

const addVoteRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/tickets/{ticketId}/votes",
  tags: ["support-tickets"],
  middleware: [rls("write")],
  request: {
    params: ticketIdParam,
    body: {
      content: {
        "application/json": { schema: addVoteBodySchema },
      },
    },
  },
  responses: {
    201: {
      description:
        "Vote added — idempotent per (ticket, email); repeat calls update priority/provenance. When the caller is staff or an agent, the vote is recorded as cast on behalf of the voter.",
      content: {
        "application/json": {
          schema: z.object({
            vote: ticketVoteSchema,
            created: z.boolean(),
          }),
        },
      },
    },
  },
});

const removeVoteRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/support/tickets/{ticketId}/votes",
  tags: ["support-tickets"],
  middleware: [rls("write")],
  request: {
    params: ticketIdParam,
    query: removeVoteQuerySchema,
  },
  responses: {
    200: {
      description: "Vote removed",
      content: {
        "application/json": {
          schema: z.object({ removed: z.boolean() }),
        },
      },
    },
  },
});

const listVotesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/tickets/{ticketId}/votes",
  tags: ["support-tickets"],
  middleware: [rls("read")],
  request: {
    params: ticketIdParam,
  },
  responses: {
    200: {
      description: "Votes on the ticket, oldest first",
      content: {
        "application/json": {
          schema: z.object({
            votes: z.array(ticketVoteSchema),
            count: z.number(),
          }),
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

    const ticket = await createTicket(
      db,
      {
        organizationId,
        customerId: body.customerId,
        title: body.title,
        sourceChannel: body.sourceChannel,
        priority: body.priority,
        status: body.status,
        externalId: body.externalId,
        externalSource: body.externalSource,
        issueId: body.issueId,
      },
      c.env
    );

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
      await addTicketMessage(
        db,
        organizationId,
        ticket.id,
        {
          direction: "inbound",
          textContent: body.message.textContent,
          markdownContent: body.message.markdownContent,
          channel: body.message.channel,
          customerId: ticket.customerId,
        },
        c.env
      );
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
      sourceChannel: query.sourceChannel,
      externalSource: query.externalSource,
      assignedTo: query.assignedTo,
      q: query.q,
    });

    const withRelations = await hydrateTicketRelations(
      db,
      organizationId,
      tickets
    );

    return c.json({ tickets: withRelations, nextCursor });
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

  app.openapi(listTicketArtifactsRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const ticket = await getTicketById(db, organizationId, ticketId);
    if (!ticket) {
      ticketNotFound();
    }

    const rows = await db
      .select()
      .from(supportTicketAttachments)
      .where(
        and(
          eq(supportTicketAttachments.organizationId, organizationId),
          eq(supportTicketAttachments.ticketId, ticketId)
        )
      );

    const INLINE_TYPES = new Set(["debugger_json", "log", "network", "replay"]);
    const MAX_INLINE_BYTES = 512 * 1024;
    const artifacts = await Promise.all(
      rows.map(async (row) => {
        const object = row.r2Key
          ? await c.env.ATTACHMENTS_BUCKET.get(row.r2Key)
          : null;
        const artifact: z.infer<typeof ticketArtifactSchema> = {
          id: row.id,
          type: row.type,
          fileName: row.fileName,
          contentType: row.contentType,
          size: row.size,
          url: row.url,
          available: row.r2Key === null || object !== null,
        };
        if (
          object &&
          INLINE_TYPES.has(row.type) &&
          (row.size === null || row.size <= MAX_INLINE_BYTES)
        ) {
          const text = await object.text();
          try {
            artifact.content = JSON.parse(text) as unknown;
          } catch {
            artifact.content = text;
          }
        }
        return artifact;
      })
    );

    return c.json({ artifacts });
  });

  app.openapi(updateTicketRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const { actorType, actorId } = resolveActor(identity, body);
    const db = createD1(c.env.D1);
    const { actorType: _actorType, actorId: _actorId, ...updates } = body;
    const ticket = await updateTicket(
      db,
      organizationId,
      ticketId,
      {
        ...updates,
        actorType,
        actorId,
      },
      c.env
    );
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
    const identity = c.get("workspaceIdentity");
    const { actorType, actorId } = resolveActor(identity, body);
    const db = createD1(c.env.D1);
    const event = await addTicketMessage(
      db,
      organizationId,
      ticketId,
      {
        ...body,
        actorType,
        actorId,
      },
      c.env
    );
    return c.json({ event }, 201);
  });

  app.openapi(addNoteRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const { actorType, actorId } = resolveActor(identity, body);
    const db = createD1(c.env.D1);
    const event = await addTicketNote(
      db,
      organizationId,
      ticketId,
      {
        ...body,
        actorType,
        actorId,
      },
      c.env
    );
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
    const identity = c.get("workspaceIdentity");
    const { actorType, actorId } = resolveActor(identity);
    const db = createD1(c.env.D1);
    await updateTicket(
      db,
      organizationId,
      ticketId,
      {
        status: "done",
        actorType,
        actorId,
      },
      c.env
    );
    const full =
      (await getTicketById(db, organizationId, ticketId)) ?? ticketNotFound();
    return c.json({ ticket: full });
  });

  app.openapi(markTodoRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const { actorType, actorId } = resolveActor(identity);
    const db = createD1(c.env.D1);
    await updateTicket(
      db,
      organizationId,
      ticketId,
      {
        status: "todo",
        actorType,
        actorId,
      },
      c.env
    );
    const full =
      (await getTicketById(db, organizationId, ticketId)) ?? ticketNotFound();
    return c.json({ ticket: full });
  });

  app.openapi(snoozeRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const body = c.req.valid("json");
    const until = new Date(body.until);
    if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
      throw new VortexError({
        status: 400,
        code: "BAD_REQUEST",
        message: "Snooze until must be a future date",
      });
    }
    const identity = c.get("workspaceIdentity");
    const { actorType, actorId } = resolveActor(identity, body);
    const db = createD1(c.env.D1);
    await updateTicket(
      db,
      organizationId,
      ticketId,
      {
        status: "snoozed",
        snoozedUntil: body.until,
        actorType,
        actorId,
      },
      c.env
    );
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

  app.openapi(addVoteRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const ticket = await getTicketById(db, organizationId, ticketId);
    if (!ticket) {
      ticketNotFound();
    }

    const identity = c.get("workspaceIdentity");
    const onBehalf = identity.type === "user" || identity.type === "agent";
    const { vote, created } = await addTicketVote(
      db,
      organizationId,
      ticketId,
      {
        voterEmail: body.email,
        customerId: body.customerId ?? null,
        priority: body.priority ?? null,
        castByActorType: onBehalf ? identity.type : null,
        castByActorId: onBehalf ? identity.id : null,
        sourceTicketId: body.sourceTicketId ?? null,
      }
    );
    return c.json({ vote, created }, 201);
  });

  app.openapi(removeVoteRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const query = c.req.valid("query");
    const db = createD1(c.env.D1);
    const removed = await removeTicketVote(db, organizationId, ticketId, {
      voteId: query.voteId,
      email: query.email,
    });
    return c.json({ removed });
  });

  app.openapi(listVotesRoute, async (c) => {
    const { organizationId, ticketId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const ticket = await getTicketById(db, organizationId, ticketId);
    if (!ticket) {
      ticketNotFound();
    }
    const votes = await listTicketVotes(db, organizationId, ticketId);
    return c.json({ votes, count: votes.length });
  });
}
