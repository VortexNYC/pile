import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  like,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import { VortexError } from "../platform/errors.js";
import type { D1Client } from "./db.js";
import {
  labels,
  supportCompanies,
  supportCustomerCompanies,
  supportCustomerIdentities,
  supportCustomers,
  supportTicketAssignments,
  supportTicketEvents,
  supportTicketLabels,
  supportTicketMessages,
  supportTicketNotes,
  supportTickets,
  user,
} from "./schema.js";
import { getCustomerById } from "./support-contacts.js";

export type SupportTicketStatus = "todo" | "done" | "snoozed";
export type SupportTicketPriority = "low" | "medium" | "high" | "urgent";
export type SupportTicketSource =
  | "intercom"
  | "zendesk"
  | "plain"
  | "email"
  | "slack"
  | "msteams"
  | "discord"
  | "chat"
  | "api"
  | "manual";
export type SupportTicketChannel =
  | "email"
  | "slack"
  | "msteams"
  | "discord"
  | "chat"
  | "capture"
  | "api"
  | "intercom"
  | "zendesk"
  | "plain";
export type SupportTicketMessageDirection = "inbound" | "outbound";
export type SupportTicketMessageChannel =
  | "email"
  | "slack"
  | "msteams"
  | "discord"
  | "chat"
  | "api";
export type SupportTicketEventType =
  | "message"
  | "note"
  | "status_change"
  | "priority_change"
  | "assignment_change"
  | "label_added"
  | "label_removed"
  | "customer_event"
  | "field_change";
export type SupportTicketActorType = "customer" | "user" | "machine" | "system";

export type SupportTicketInput = {
  id?: string;
  organizationId: string;
  customerId: string;
  title: string;
  sourceChannel: SupportTicketChannel;
  priority?: SupportTicketPriority;
  status?: SupportTicketStatus;
  externalId?: string | null;
  externalSource?: SupportTicketSource;
  issueId?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type SupportTicket = {
  id: string;
  organizationId: string;
  customerId: string;
  number: number;
  externalId: string | null;
  externalSource: SupportTicketSource;
  title: string;
  status: SupportTicketStatus;
  priority: SupportTicketPriority;
  sourceChannel: SupportTicketChannel;
  issueId: string | null;
  lastCustomerMessageAt: string | null;
  lastAgentMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SupportTicketWithRelations = SupportTicket & {
  customer: {
    id: string;
    email: string;
    fullName: string | null;
    phone: string | null;
  };
  companies: { id: string; name: string; isPrimary: boolean }[];
  identities: { id: string; type: string; value: string; isPrimary: boolean }[];
  labels: { id: string; labelId: string; name: string; color: string | null }[];
  assignees: {
    id: string;
    userId: string;
    name: string | null;
    isPrimary: boolean;
  }[];
  events: SupportTicketEventWithDetails[];
};

export type SupportTicketEvent = {
  id: string;
  ticketId: string;
  type: SupportTicketEventType;
  actorType: SupportTicketActorType;
  actorId: string | null;
  createdAt: string;
};

export type SupportTicketMessage = {
  id: string;
  eventId: string;
  direction: SupportTicketMessageDirection;
  textContent: string;
  markdownContent: string | null;
  channel: SupportTicketMessageChannel;
  customerId: string | null;
  userId: string | null;
};

export type SupportTicketNote = {
  id: string;
  eventId: string;
  body: string;
};

export type SupportTicketEventWithDetails = SupportTicketEvent & {
  message?: SupportTicketMessage;
  note?: SupportTicketNote;
};

export async function nextTicketNumber(
  db: D1Client,
  organizationId: string
): Promise<number> {
  const result = await db.run(sql`
    INSERT INTO support_ticket_counters (organization_id, next_number)
    VALUES (${organizationId}, 2)
    ON CONFLICT (organization_id) DO UPDATE SET next_number = next_number + 1
    RETURNING (next_number - 1) AS next_number
  `);

  const rows = z
    .array(z.object({ next_number: z.number() }))
    .parse(result.results);
  return rows[0].next_number;
}

export async function createTicket(
  db: D1Client,
  input: SupportTicketInput
): Promise<SupportTicket> {
  const customer = await getCustomerById(
    db,
    input.organizationId,
    input.customerId
  );
  if (!customer) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Customer not found in workspace",
    });
  }

  const id = input.id ?? crypto.randomUUID();
  const number = await nextTicketNumber(db, input.organizationId);
  const status: SupportTicketStatus = input.status ?? "todo";
  const priority: SupportTicketPriority = input.priority ?? "medium";
  const externalSource: SupportTicketSource = input.externalSource ?? "manual";
  const now = new Date().toISOString();
  const createdAt = input.createdAt ?? now;
  const updatedAt = input.updatedAt ?? now;

  await db.insert(supportTickets).values({
    id,
    organizationId: input.organizationId,
    customerId: input.customerId,
    number,
    externalId: input.externalId ?? null,
    externalSource,
    title: input.title,
    status,
    priority,
    sourceChannel: input.sourceChannel,
    issueId: input.issueId ?? null,
    lastCustomerMessageAt: null,
    lastAgentMessageAt: null,
    createdAt,
    updatedAt,
  });

  return {
    id,
    organizationId: input.organizationId,
    customerId: input.customerId,
    number,
    externalId: input.externalId ?? null,
    externalSource,
    title: input.title,
    status,
    priority,
    sourceChannel: input.sourceChannel,
    issueId: input.issueId ?? null,
    lastCustomerMessageAt: null,
    lastAgentMessageAt: null,
    createdAt,
    updatedAt,
  };
}

export async function getTicketById(
  db: D1Client,
  organizationId: string,
  ticketId: string
): Promise<SupportTicketWithRelations | null> {
  const [ticket] = await db
    .select()
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.id, ticketId),
        eq(supportTickets.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!ticket) {
    return null;
  }

  const [customerRows, companies, identities, labelsList, assignees, events] =
    await Promise.all([
      db
        .select({
          id: supportCustomers.id,
          email: supportCustomers.email,
          fullName: supportCustomers.fullName,
          phone: supportCustomers.phone,
        })
        .from(supportCustomers)
        .where(eq(supportCustomers.id, ticket.customerId))
        .limit(1),
      db
        .select({
          id: supportCustomerCompanies.id,
          name: supportCompanies.name,
          isPrimary: supportCustomerCompanies.isPrimary,
        })
        .from(supportCustomerCompanies)
        .innerJoin(
          supportCompanies,
          eq(supportCustomerCompanies.companyId, supportCompanies.id)
        )
        .where(eq(supportCustomerCompanies.customerId, ticket.customerId)),
      db
        .select()
        .from(supportCustomerIdentities)
        .where(eq(supportCustomerIdentities.customerId, ticket.customerId)),
      db
        .select({
          id: supportTicketLabels.id,
          labelId: supportTicketLabels.labelId,
          name: labels.name,
          color: labels.color,
        })
        .from(supportTicketLabels)
        .innerJoin(labels, eq(supportTicketLabels.labelId, labels.id))
        .where(eq(supportTicketLabels.ticketId, ticketId)),
      db
        .select({
          id: supportTicketAssignments.id,
          userId: supportTicketAssignments.userId,
          name: user.name,
          isPrimary: supportTicketAssignments.isPrimary,
        })
        .from(supportTicketAssignments)
        .innerJoin(user, eq(supportTicketAssignments.userId, user.id))
        .where(eq(supportTicketAssignments.ticketId, ticketId)),
      listTicketEvents(db, organizationId, ticketId, { limit: 20 }),
    ]);

  const customer = customerRows[0];
  if (!customer) {
    throw new VortexError("Customer for ticket not found", 500);
  }

  return {
    ...ticket,
    customer,
    companies: companies.map((c) => ({
      id: c.id,
      name: c.name,
      isPrimary: c.isPrimary,
    })),
    identities,
    labels: labelsList,
    assignees,
    events,
  };
}

export type ListTicketsOptions = {
  limit: number;
  cursor?: string;
  customerId?: string;
  status?: SupportTicketStatus;
  priority?: SupportTicketPriority;
  assignedTo?: string;
  q?: string;
};

export async function listTickets(
  db: D1Client,
  organizationId: string,
  options: ListTicketsOptions
): Promise<{ tickets: SupportTicket[]; nextCursor: string | null }> {
  const conditions: (SQL<unknown> | undefined)[] = [
    eq(supportTickets.organizationId, organizationId),
  ];

  if (options.customerId) {
    conditions.push(eq(supportTickets.customerId, options.customerId));
  }
  if (options.status) {
    conditions.push(eq(supportTickets.status, options.status));
  }
  if (options.priority) {
    conditions.push(eq(supportTickets.priority, options.priority));
  }
  if (options.assignedTo) {
    const ticketIds = await db
      .select({ ticketId: supportTicketAssignments.ticketId })
      .from(supportTicketAssignments)
      .where(eq(supportTicketAssignments.userId, options.assignedTo));

    if (ticketIds.length === 0) {
      return { tickets: [], nextCursor: null };
    }

    conditions.push(
      inArray(
        supportTickets.id,
        ticketIds.map((t) => t.ticketId)
      )
    );
  }
  if (options.q) {
    const query = `%${options.q}%`;
    conditions.push(
      or(
        like(supportTickets.title, query),
        like(supportTickets.externalId, query)
      )
    );
  }
  if (options.cursor) {
    conditions.push(gt(supportTickets.createdAt, options.cursor));
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);
  const limit = Math.max(1, Math.min(options.limit, 100));

  const tickets = await db
    .select()
    .from(supportTickets)
    .where(where)
    .orderBy(desc(supportTickets.createdAt))
    .limit(limit + 1);

  const hasMore = tickets.length > limit;
  const sliced = hasMore ? tickets.slice(0, -1) : tickets;
  const nextCursor = hasMore ? sliced[sliced.length - 1].createdAt : null;

  return { tickets: sliced, nextCursor };
}

export async function updateTicket(
  db: D1Client,
  organizationId: string,
  ticketId: string,
  input: {
    title?: string;
    status?: SupportTicketStatus;
    priority?: SupportTicketPriority;
    issueId?: string | null;
    actorType?: SupportTicketActorType;
    actorId?: string | null;
  }
): Promise<SupportTicket | null> {
  const [existing] = await db
    .select()
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.id, ticketId),
        eq(supportTickets.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();
  const updates: Partial<typeof supportTickets.$inferSelect> = {
    updatedAt: now,
  };

  if (input.title !== undefined) updates.title = input.title;
  if (input.issueId !== undefined) updates.issueId = input.issueId;

  const eventsToCreate: (typeof supportTicketEvents.$inferInsert)[] = [];

  if (input.status !== undefined && input.status !== existing.status) {
    updates.status = input.status;
    eventsToCreate.push({
      id: crypto.randomUUID(),
      ticketId,
      type: "status_change",
      actorType: input.actorType ?? "user",
      actorId: input.actorId ?? null,
      createdAt: now,
    });
  }

  if (input.priority !== undefined && input.priority !== existing.priority) {
    updates.priority = input.priority;
    eventsToCreate.push({
      id: crypto.randomUUID(),
      ticketId,
      type: "priority_change",
      actorType: input.actorType ?? "user",
      actorId: input.actorId ?? null,
      createdAt: now,
    });
  }

  await db
    .update(supportTickets)
    .set(updates)
    .where(
      and(
        eq(supportTickets.id, ticketId),
        eq(supportTickets.organizationId, organizationId)
      )
    );

  if (eventsToCreate.length > 0) {
    await db.insert(supportTicketEvents).values(eventsToCreate);
  }

  const [updated] = await db
    .select()
    .from(supportTickets)
    .where(eq(supportTickets.id, ticketId))
    .limit(1);

  return updated ?? null;
}

export async function addTicketMessage(
  db: D1Client,
  organizationId: string,
  ticketId: string,
  input: {
    direction: SupportTicketMessageDirection;
    textContent: string;
    markdownContent?: string | null;
    channel: SupportTicketMessageChannel;
    customerId?: string | null;
    userId?: string | null;
    createdAt?: string;
  }
): Promise<SupportTicketEventWithDetails> {
  await ensureTicket(db, organizationId, ticketId);

  const now = new Date().toISOString();
  const messageCreatedAt = input.createdAt ?? now;
  const eventId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const actorType: SupportTicketActorType = input.customerId
    ? "customer"
    : input.userId
      ? "user"
      : "system";
  const actorId = input.customerId ?? input.userId ?? null;

  await db.insert(supportTicketEvents).values({
    id: eventId,
    ticketId,
    type: "message",
    actorType,
    actorId,
    createdAt: messageCreatedAt,
  });

  await db.insert(supportTicketMessages).values({
    id: messageId,
    eventId,
    direction: input.direction,
    textContent: input.textContent,
    markdownContent: input.markdownContent ?? null,
    channel: input.channel,
    customerId: input.customerId ?? null,
    userId: input.userId ?? null,
  });

  await db
    .update(supportTickets)
    .set({
      ...(input.direction === "inbound"
        ? { lastCustomerMessageAt: messageCreatedAt }
        : { lastAgentMessageAt: messageCreatedAt }),
      updatedAt: messageCreatedAt,
    })
    .where(
      and(
        eq(supportTickets.id, ticketId),
        eq(supportTickets.organizationId, organizationId)
      )
    );

  return {
    id: eventId,
    ticketId,
    type: "message",
    actorType,
    actorId,
    createdAt: messageCreatedAt,
    message: {
      id: messageId,
      eventId,
      direction: input.direction,
      textContent: input.textContent,
      markdownContent: input.markdownContent ?? null,
      channel: input.channel,
      customerId: input.customerId ?? null,
      userId: input.userId ?? null,
    },
  };
}

type AddTicketMessageInput = {
  direction: SupportTicketMessageDirection;
  textContent: string;
  markdownContent?: string | null;
  channel: SupportTicketMessageChannel;
  customerId?: string | null;
  userId?: string | null;
  createdAt?: string;
};

export async function addTicketMessagesBulk(
  db: D1Client,
  organizationId: string,
  ticketId: string,
  messages: AddTicketMessageInput[]
): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  await ensureTicket(db, organizationId, ticketId);

  const now = new Date().toISOString();
  const eventsToCreate: {
    id: string;
    ticketId: string;
    type: "message";
    actorType: SupportTicketActorType;
    actorId: string | null;
    createdAt: string;
  }[] = [];
  const messagesToCreate: {
    id: string;
    eventId: string;
    direction: SupportTicketMessageDirection;
    textContent: string;
    markdownContent: string | null;
    channel: SupportTicketMessageChannel;
    customerId: string | null;
    userId: string | null;
    createdAt: string;
  }[] = [];

  let lastCustomerMessageAt: string | null = null;
  let lastAgentMessageAt: string | null = null;
  let latestMessageAt: string | null = null;

  for (const message of messages) {
    const messageCreatedAt = message.createdAt ?? now;
    const actorType: SupportTicketActorType = message.customerId
      ? "customer"
      : message.userId
        ? "user"
        : "system";
    const actorId = message.customerId ?? message.userId ?? null;
    const eventId = crypto.randomUUID();
    const messageId = crypto.randomUUID();

    eventsToCreate.push({
      id: eventId,
      ticketId,
      type: "message",
      actorType,
      actorId,
      createdAt: messageCreatedAt,
    });

    messagesToCreate.push({
      id: messageId,
      eventId,
      direction: message.direction,
      textContent: message.textContent,
      markdownContent: message.markdownContent ?? null,
      channel: message.channel,
      customerId: message.customerId ?? null,
      userId: message.userId ?? null,
      createdAt: messageCreatedAt,
    });

    if (message.direction === "inbound") {
      if (
        lastCustomerMessageAt === null ||
        messageCreatedAt > lastCustomerMessageAt
      ) {
        lastCustomerMessageAt = messageCreatedAt;
      }
    } else {
      if (
        lastAgentMessageAt === null ||
        messageCreatedAt > lastAgentMessageAt
      ) {
        lastAgentMessageAt = messageCreatedAt;
      }
    }

    if (latestMessageAt === null || messageCreatedAt > latestMessageAt) {
      latestMessageAt = messageCreatedAt;
    }
  }

  await db.insert(supportTicketEvents).values(eventsToCreate);
  await db.insert(supportTicketMessages).values(messagesToCreate);

  await db
    .update(supportTickets)
    .set({
      ...(lastCustomerMessageAt ? { lastCustomerMessageAt } : {}),
      ...(lastAgentMessageAt ? { lastAgentMessageAt } : {}),
      ...(latestMessageAt ? { updatedAt: latestMessageAt } : {}),
    })
    .where(
      and(
        eq(supportTickets.id, ticketId),
        eq(supportTickets.organizationId, organizationId)
      )
    );
}

export async function addTicketNote(
  db: D1Client,
  organizationId: string,
  ticketId: string,
  input: { body: string; userId: string }
): Promise<SupportTicketEventWithDetails> {
  await ensureTicket(db, organizationId, ticketId);

  const now = new Date().toISOString();
  const eventId = crypto.randomUUID();
  const noteId = crypto.randomUUID();

  await db.insert(supportTicketEvents).values({
    id: eventId,
    ticketId,
    type: "note",
    actorType: "user",
    actorId: input.userId,
    createdAt: now,
  });

  await db.insert(supportTicketNotes).values({
    id: noteId,
    eventId,
    body: input.body,
  });

  await db
    .update(supportTickets)
    .set({ updatedAt: now })
    .where(
      and(
        eq(supportTickets.id, ticketId),
        eq(supportTickets.organizationId, organizationId)
      )
    );

  return {
    id: eventId,
    ticketId,
    type: "note",
    actorType: "user",
    actorId: input.userId,
    createdAt: now,
    note: {
      id: noteId,
      eventId,
      body: input.body,
    },
  };
}

async function ensureTicket(
  db: D1Client,
  organizationId: string,
  ticketId: string
): Promise<void> {
  const [ticket] = await db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.id, ticketId),
        eq(supportTickets.organizationId, organizationId)
      )
    )
    .limit(1);

  if (!ticket) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Ticket not found",
    });
  }
}

export async function listTicketEvents(
  db: D1Client,
  organizationId: string,
  ticketId: string,
  options: { limit: number; cursor?: string }
): Promise<SupportTicketEventWithDetails[]> {
  await ensureTicket(db, organizationId, ticketId);
  const conditions = [eq(supportTicketEvents.ticketId, ticketId)];
  if (options.cursor) {
    conditions.push(gt(supportTicketEvents.createdAt, options.cursor));
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);
  const limit = Math.max(1, Math.min(options.limit, 100));

  const events = await db
    .select()
    .from(supportTicketEvents)
    .where(where)
    .orderBy(asc(supportTicketEvents.createdAt))
    .limit(limit + 1);

  if (events.length === 0) {
    return [];
  }

  const [messages, notes] = await Promise.all([
    db
      .select()
      .from(supportTicketMessages)
      .where(
        inArray(
          supportTicketMessages.eventId,
          events.map((e) => e.id)
        )
      ),
    db
      .select()
      .from(supportTicketNotes)
      .where(
        inArray(
          supportTicketNotes.eventId,
          events.map((e) => e.id)
        )
      ),
  ]);

  const messageMap = new Map(messages.map((m) => [m.eventId, m]));
  const noteMap = new Map(notes.map((n) => [n.eventId, n]));

  return events.map((event) => ({
    id: event.id,
    ticketId: event.ticketId,
    type: event.type,
    actorType: event.actorType,
    actorId: event.actorId,
    createdAt: event.createdAt,
    message: messageMap.get(event.id),
    note: noteMap.get(event.id),
  }));
}

export async function findSupportTicketByExternalId(
  db: D1Client,
  organizationId: string,
  externalId: string,
  externalSource: SupportTicketSource
): Promise<SupportTicket | null> {
  const [ticket] = await db
    .select()
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.organizationId, organizationId),
        eq(supportTickets.externalId, externalId),
        eq(supportTickets.externalSource, externalSource)
      )
    )
    .limit(1);
  return ticket ?? null;
}

export type ExternalSupportReply = {
  body: string;
  direction: SupportTicketMessageDirection;
  channel?: SupportTicketMessageChannel;
  customerId?: string | null;
  userId?: string | null;
  createdAt?: string;
};

export type IntercomSupportConversation = {
  id: string;
  title?: string | null;
  state: "open" | "closed" | "snoozed";
  priority?: "none" | "low" | "medium" | "high" | "urgent";
  source: {
    type?: string;
    subject?: string | null;
    body?: string | null;
  };
  created_at?: number;
  updated_at?: number;
  replies: ExternalSupportReply[];
};

export type PlainSupportThread = {
  id: string;
  title?: string | null;
  status: "todo" | "done" | "snoozed";
  priority?: "none" | "low" | "medium" | "high" | "urgent";
  source: {
    type?: string;
    subject?: string | null;
    body?: string | null;
  };
  createdAt?: string;
  updatedAt?: string;
  replies: ExternalSupportReply[];
};

function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function asMessageChannel(
  sourceType: string | null | undefined
): SupportTicketMessageChannel {
  if (
    sourceType === "email" ||
    sourceType === "slack" ||
    sourceType === "msteams" ||
    sourceType === "discord" ||
    sourceType === "chat" ||
    sourceType === "api"
  ) {
    return sourceType;
  }
  return "chat";
}

function asTicketChannel(
  sourceType: string | null | undefined
): SupportTicketChannel {
  if (
    sourceType === "email" ||
    sourceType === "slack" ||
    sourceType === "msteams" ||
    sourceType === "discord" ||
    sourceType === "chat" ||
    sourceType === "capture" ||
    sourceType === "api" ||
    sourceType === "intercom" ||
    sourceType === "zendesk" ||
    sourceType === "plain"
  ) {
    return sourceType;
  }
  return "chat";
}

function intercomStateToTicketStatus(
  state: IntercomSupportConversation["state"]
): SupportTicketStatus {
  const map: Record<string, SupportTicketStatus> = {
    open: "todo",
    closed: "done",
    snoozed: "snoozed",
  };
  return map[state] ?? "todo";
}

function plainStateToTicketStatus(
  status: PlainSupportThread["status"]
): SupportTicketStatus {
  const map: Record<string, SupportTicketStatus> = {
    todo: "todo",
    done: "done",
    snoozed: "snoozed",
  };
  return map[status] ?? "todo";
}

function externalPriorityToTicketPriority(
  priority: "none" | "low" | "medium" | "high" | "urgent" | undefined
): SupportTicketPriority {
  if (!priority || priority === "none") return "medium";
  return priority;
}

export async function createTicketFromIntercom(
  db: D1Client,
  organizationId: string,
  customerId: string,
  conversation: IntercomSupportConversation,
  overrides: {
    title?: string;
    status?: SupportTicketStatus;
    priority?: SupportTicketPriority;
  } = {}
): Promise<SupportTicketWithRelations> {
  const existing = await findSupportTicketByExternalId(
    db,
    organizationId,
    conversation.id,
    "intercom"
  );
  if (existing) {
    const full = await getTicketById(db, organizationId, existing.id);
    return (
      full ?? {
        ...existing,
        customer: {
          id: existing.customerId,
          email: "",
          fullName: null,
          phone: null,
        },
        companies: [],
        identities: [],
        labels: [],
        assignees: [],
        events: [],
      }
    );
  }

  const body = stripHtml(conversation.source?.body);
  const subject = conversation.source?.subject ?? null;
  const title =
    overrides.title ??
    conversation.title ??
    subject ??
    (body.slice(0, 120) || `Intercom conversation ${conversation.id}`);

  const createdAt = conversation.created_at
    ? new Date(conversation.created_at * 1000).toISOString()
    : new Date().toISOString();
  const updatedAt = conversation.updated_at
    ? new Date(conversation.updated_at * 1000).toISOString()
    : createdAt;

  const sourceChannel = asTicketChannel(conversation.source?.type);
  const messageChannel = asMessageChannel(conversation.source?.type);

  const ticket = await createTicket(db, {
    organizationId,
    customerId,
    title,
    sourceChannel,
    status: overrides.status ?? intercomStateToTicketStatus(conversation.state),
    priority:
      overrides.priority ??
      externalPriorityToTicketPriority(conversation.priority),
    externalId: conversation.id,
    externalSource: "intercom",
    createdAt,
    updatedAt,
  });

  const firstMessage = body || subject || "(no content)";
  const sortedReplies = conversation.replies.toSorted(
    (a, b) =>
      (a.createdAt ? Date.parse(a.createdAt) : 0) -
      (b.createdAt ? Date.parse(b.createdAt) : 0)
  );
  const allMessages: AddTicketMessageInput[] = [
    {
      direction: "inbound",
      textContent: firstMessage,
      channel: messageChannel,
      customerId,
      createdAt,
    },
    ...sortedReplies.map((reply) => ({
      direction: reply.direction,
      textContent: stripHtml(reply.body) || "(no content)",
      markdownContent: reply.body,
      channel: reply.channel ?? messageChannel,
      customerId: reply.direction === "inbound" ? customerId : reply.customerId,
      userId: reply.userId,
      createdAt: reply.createdAt,
    })),
  ];
  await addTicketMessagesBulk(db, organizationId, ticket.id, allMessages);

  const lastReply = sortedReplies.at(-1);
  const finalUpdatedAt =
    lastReply?.createdAt && lastReply.createdAt > updatedAt
      ? lastReply.createdAt
      : updatedAt;
  await db
    .update(supportTickets)
    .set({ updatedAt: finalUpdatedAt })
    .where(
      and(
        eq(supportTickets.id, ticket.id),
        eq(supportTickets.organizationId, organizationId)
      )
    );

  const full = await getTicketById(db, organizationId, ticket.id);
  if (!full) {
    throw new VortexError("Imported ticket not found", 500);
  }
  return full;
}

export async function createTicketFromPlain(
  db: D1Client,
  organizationId: string,
  customerId: string,
  thread: PlainSupportThread,
  overrides: {
    title?: string;
    status?: SupportTicketStatus;
    priority?: SupportTicketPriority;
  } = {}
): Promise<SupportTicketWithRelations> {
  const existing = await findSupportTicketByExternalId(
    db,
    organizationId,
    thread.id,
    "plain"
  );
  if (existing) {
    const full = await getTicketById(db, organizationId, existing.id);
    if (!full) {
      throw new VortexError("Imported ticket not found", 500);
    }
    return full;
  }

  const body = stripHtml(thread.source?.body);
  const subject = thread.source?.subject ?? null;
  const title =
    overrides.title ??
    thread.title ??
    subject ??
    (body.slice(0, 120) || `Plain thread ${thread.id}`);

  const createdAt = thread.createdAt ?? new Date().toISOString();
  const updatedAt = thread.updatedAt ?? createdAt;

  const sourceChannel = asTicketChannel(thread.source?.type);
  const messageChannel = asMessageChannel(thread.source?.type);

  const ticket = await createTicket(db, {
    organizationId,
    customerId,
    title,
    sourceChannel,
    status: overrides.status ?? plainStateToTicketStatus(thread.status),
    priority:
      overrides.priority ?? externalPriorityToTicketPriority(thread.priority),
    externalId: thread.id,
    externalSource: "plain",
    createdAt,
    updatedAt,
  });

  const firstMessage = body || subject || "(no content)";
  const sortedReplies = thread.replies.toSorted(
    (a, b) =>
      (a.createdAt ? Date.parse(a.createdAt) : 0) -
      (b.createdAt ? Date.parse(b.createdAt) : 0)
  );
  const allMessages: AddTicketMessageInput[] = [
    {
      direction: "inbound",
      textContent: firstMessage,
      channel: messageChannel,
      customerId,
      createdAt,
    },
    ...sortedReplies.map((reply) => ({
      direction: reply.direction,
      textContent: stripHtml(reply.body) || "(no content)",
      markdownContent: reply.body,
      channel: reply.channel ?? messageChannel,
      customerId: reply.direction === "inbound" ? customerId : reply.customerId,
      userId: reply.userId,
      createdAt: reply.createdAt,
    })),
  ];
  await addTicketMessagesBulk(db, organizationId, ticket.id, allMessages);

  const lastReply = sortedReplies.at(-1);
  const finalUpdatedAt =
    lastReply?.createdAt && lastReply.createdAt > updatedAt
      ? lastReply.createdAt
      : updatedAt;
  await db
    .update(supportTickets)
    .set({ updatedAt: finalUpdatedAt })
    .where(
      and(
        eq(supportTickets.id, ticket.id),
        eq(supportTickets.organizationId, organizationId)
      )
    );

  const full = await getTicketById(db, organizationId, ticket.id);
  if (!full) {
    throw new VortexError("Imported ticket not found", 500);
  }
  return full;
}

export type ZendeskSupportTicket = {
  id: string;
  subject?: string | null;
  description?: string | null;
  status: "open" | "pending" | "hold" | "solved" | "closed";
  priority?: "urgent" | "high" | "normal" | "low";
  source: {
    type?: string;
    subject?: string | null;
    body?: string | null;
  };
  createdAt?: string;
  updatedAt?: string;
  replies: ExternalSupportReply[];
};

function zendeskStatusToTicketStatus(
  status: ZendeskSupportTicket["status"]
): SupportTicketStatus {
  const map: Record<string, SupportTicketStatus> = {
    open: "todo",
    pending: "todo",
    hold: "todo",
    solved: "done",
    closed: "done",
  };
  return map[status] ?? "todo";
}

function zendeskPriorityToTicketPriority(
  priority: ZendeskSupportTicket["priority"]
): SupportTicketPriority {
  const map: Record<string, SupportTicketPriority> = {
    urgent: "urgent",
    high: "high",
    normal: "medium",
    low: "low",
  };
  return map[priority ?? "normal"] ?? "medium";
}

export async function createTicketFromZendesk(
  db: D1Client,
  organizationId: string,
  customerId: string,
  ticket: ZendeskSupportTicket,
  overrides: {
    title?: string;
    status?: SupportTicketStatus;
    priority?: SupportTicketPriority;
  } = {}
): Promise<SupportTicketWithRelations> {
  const existing = await findSupportTicketByExternalId(
    db,
    organizationId,
    ticket.id,
    "zendesk"
  );
  if (existing) {
    const full = await getTicketById(db, organizationId, existing.id);
    return (
      full ?? {
        ...existing,
        customer: {
          id: existing.customerId,
          email: "",
          fullName: null,
          phone: null,
        },
        companies: [],
        identities: [],
        labels: [],
        assignees: [],
        events: [],
      }
    );
  }

  const body = stripHtml(ticket.description ?? ticket.source?.body);
  const subject = ticket.subject ?? ticket.source?.subject ?? null;
  const title =
    overrides.title ??
    subject ??
    (body.slice(0, 120) || `Zendesk ticket ${ticket.id}`);

  const createdAt = ticket.createdAt ?? new Date().toISOString();
  const updatedAt = ticket.updatedAt ?? createdAt;

  const sourceChannel = asTicketChannel(ticket.source?.type);
  const messageChannel = asMessageChannel(ticket.source?.type);

  const created = await createTicket(db, {
    organizationId,
    customerId,
    title,
    sourceChannel,
    status: overrides.status ?? zendeskStatusToTicketStatus(ticket.status),
    priority:
      overrides.priority ?? zendeskPriorityToTicketPriority(ticket.priority),
    externalId: ticket.id,
    externalSource: "zendesk",
    createdAt,
    updatedAt,
  });

  const firstMessage = body || subject || "(no content)";
  const sortedReplies = ticket.replies.toSorted(
    (a, b) =>
      (a.createdAt ? Date.parse(a.createdAt) : 0) -
      (b.createdAt ? Date.parse(b.createdAt) : 0)
  );
  const allMessages: AddTicketMessageInput[] = [
    {
      direction: "inbound",
      textContent: firstMessage,
      channel: messageChannel,
      customerId,
      createdAt,
    },
    ...sortedReplies.map((reply) => ({
      direction: reply.direction,
      textContent: stripHtml(reply.body) || "(no content)",
      markdownContent: reply.body,
      channel: reply.channel ?? messageChannel,
      customerId: reply.direction === "inbound" ? customerId : reply.customerId,
      userId: reply.userId,
      createdAt: reply.createdAt,
    })),
  ];
  await addTicketMessagesBulk(db, organizationId, created.id, allMessages);

  const lastReply = sortedReplies.at(-1);
  const finalUpdatedAt =
    lastReply?.createdAt && lastReply.createdAt > updatedAt
      ? lastReply.createdAt
      : updatedAt;
  await db
    .update(supportTickets)
    .set({ updatedAt: finalUpdatedAt })
    .where(
      and(
        eq(supportTickets.id, created.id),
        eq(supportTickets.organizationId, organizationId)
      )
    );

  const full = await getTicketById(db, organizationId, created.id);
  if (!full) {
    throw new VortexError("Imported ticket not found", 500);
  }
  return full;
}
