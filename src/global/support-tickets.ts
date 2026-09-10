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
    RETURNING next_number
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
  const id = input.id ?? crypto.randomUUID();
  const number = await nextTicketNumber(db, input.organizationId);
  const status: SupportTicketStatus = input.status ?? "todo";
  const priority: SupportTicketPriority = input.priority ?? "medium";
  const externalSource: SupportTicketSource = input.externalSource ?? "manual";
  const now = new Date().toISOString();

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
    createdAt: now,
    updatedAt: now,
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
    createdAt: now,
    updatedAt: now,
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
      listTicketEvents(db, ticketId, { limit: 20 }),
    ]);

  return {
    ...ticket,
    customer: customerRows[0] ?? {
      id: ticket.customerId,
      email: "",
      fullName: null,
      phone: null,
    },
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
  }
): Promise<SupportTicketEventWithDetails> {
  await ensureTicket(db, organizationId, ticketId);

  const now = new Date().toISOString();
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
    createdAt: now,
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
        ? { lastCustomerMessageAt: now }
        : { lastAgentMessageAt: now }),
      updatedAt: now,
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
    createdAt: now,
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
  ticketId: string,
  options: { limit: number; cursor?: string }
): Promise<SupportTicketEventWithDetails[]> {
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
