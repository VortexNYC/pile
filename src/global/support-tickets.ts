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

import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import type { D1Client } from "./db.js";
import {
  labels,
  supportCompanies,
  supportCustomerCompanies,
  supportCustomerIdentities,
  supportCustomers,
  supportTicketAssignments,
  supportTicketAttachments,
  supportTicketEvents,
  supportTicketLabels,
  supportTicketMessages,
  supportTicketNotes,
  supportTickets,
  team,
  user,
} from "./schema.js";
import {
  getCustomerById,
  type SupportCustomerIdentity,
} from "./support-contacts.js";
import { createTeam } from "./teams.js";

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
  | "capture"
  | "api"
  | "intercom"
  | "zendesk"
  | "plain";
export type SupportTicketEventType =
  | "message"
  | "note"
  | "status_change"
  | "priority_change"
  | "assignment_change"
  | "label_added"
  | "label_removed"
  | "customer_event"
  | "thread_event"
  | "survey_requested"
  | "survey_received"
  | "sla_change"
  | "link_added"
  | "link_changed"
  | "link_removed"
  | "discussion"
  | "discussion_resolved"
  | "external_reference_changed"
  | "notification"
  | "watchers_changed"
  | "call"
  | "voicemail"
  | "custom_entry"
  | "field_change";
export type SupportTicketActorType =
  | "customer"
  | "user"
  | "agent"
  | "automation";

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
  identities: SupportCustomerIdentity[];
  labels: { id: string; labelId: string; name: string; color: string | null }[];
  assignees: {
    id: string;
    type: "user" | "team";
    assigneeId: string;
    name: string | null;
    isPrimary: boolean;
  }[];
  events: SupportTicketEventWithDetails[];
};

export type SupportTicketEvent = {
  id: string;
  ticketId: string;
  type: SupportTicketEventType;
  subType: string | null;
  actorType: SupportTicketActorType;
  actorId: string | null;
  metadata: string | null;
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
          teamId: supportTicketAssignments.teamId,
          userName: user.name,
          teamName: team.name,
          isPrimary: supportTicketAssignments.isPrimary,
        })
        .from(supportTicketAssignments)
        .leftJoin(user, eq(supportTicketAssignments.userId, user.id))
        .leftJoin(team, eq(supportTicketAssignments.teamId, team.id))
        .where(eq(supportTicketAssignments.ticketId, ticketId)),
      listTicketEvents(db, organizationId, ticketId, { limit: 20 }),
    ]);

  const customer = customerRows[0];
  if (!customer) {
    throw new VortexError({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Customer for ticket not found",
    });
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
    assignees: assignees.map((a) => {
      const assigneeId = a.userId ?? a.teamId;
      if (!assigneeId) {
        throw new VortexError({
          code: "INTERNAL_ERROR",
          status: 500,
          message: "Invalid support ticket assignment",
        });
      }
      return {
        id: a.id,
        type: a.userId ? "user" : "team",
        assigneeId,
        name: a.userName ?? a.teamName ?? null,
        isPrimary: a.isPrimary,
      };
    }),
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
      .where(
        or(
          eq(supportTicketAssignments.userId, options.assignedTo),
          eq(supportTicketAssignments.teamId, options.assignedTo)
        )
      );

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

  const eventsToCreate: (typeof supportTicketEvents.$inferInsert)[] = [];

  if (input.issueId !== undefined && input.issueId !== existing.issueId) {
    updates.issueId = input.issueId;
    const actorType = input.actorType ?? "user";
    const actorId = input.actorId ?? null;
    if (!existing.issueId && input.issueId) {
      eventsToCreate.push({
        id: crypto.randomUUID(),
        ticketId,
        type: "link_added",
        actorType,
        actorId,
        metadata: JSON.stringify({ issueId: input.issueId }),
        createdAt: now,
      });
    } else if (existing.issueId && !input.issueId) {
      eventsToCreate.push({
        id: crypto.randomUUID(),
        ticketId,
        type: "link_removed",
        actorType,
        actorId,
        metadata: JSON.stringify({ issueId: existing.issueId }),
        createdAt: now,
      });
    } else if (
      existing.issueId &&
      input.issueId &&
      existing.issueId !== input.issueId
    ) {
      eventsToCreate.push({
        id: crypto.randomUUID(),
        ticketId,
        type: "link_changed",
        actorType,
        actorId,
        metadata: JSON.stringify({
          fromIssueId: existing.issueId,
          toIssueId: input.issueId,
        }),
        createdAt: now,
      });
    }
  }

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

export async function findUserByEmail(
  db: D1Client,
  email: string
): Promise<{ id: string } | null> {
  const [found] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);
  return found ?? null;
}

export async function findTeamByName(
  db: D1Client,
  organizationId: string,
  name: string
): Promise<{ id: string } | null> {
  const [found] = await db
    .select({ id: team.id })
    .from(team)
    .where(and(eq(team.organizationId, organizationId), eq(team.name, name)))
    .limit(1);
  return found ?? null;
}

export async function findOrCreateTeam(
  db: D1Client,
  env: AppEnv,
  headers: Headers,
  organizationId: string,
  name: string,
  ownerId: string
) {
  const existing = await findTeamByName(db, organizationId, name);
  if (existing) return existing;

  const key =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30) || "team";

  return createTeam(db, env, headers, { organizationId, name, key, ownerId });
}

export type SupportTicketAssigneeInput =
  | { userId: string; isPrimary?: boolean }
  | { teamId: string; isPrimary?: boolean };

export async function setTicketAssignees(
  db: D1Client,
  organizationId: string,
  ticketId: string,
  assignees: SupportTicketAssigneeInput[]
): Promise<void> {
  await ensureTicket(db, organizationId, ticketId);

  await db
    .delete(supportTicketAssignments)
    .where(eq(supportTicketAssignments.ticketId, ticketId));

  if (assignees.length === 0) return;

  const rows = assignees.map((assignee) => {
    if ("userId" in assignee) {
      return {
        id: crypto.randomUUID(),
        ticketId,
        userId: assignee.userId,
        teamId: null,
        isPrimary: assignee.isPrimary ?? false,
      };
    }
    if ("teamId" in assignee) {
      return {
        id: crypto.randomUUID(),
        ticketId,
        userId: null,
        teamId: assignee.teamId,
        isPrimary: assignee.isPrimary ?? false,
      };
    }
    throw new VortexError({
      code: "UNPROCESSABLE_CONTENT",
      status: 422,
      message: "Invalid support ticket assignee",
    });
  });

  await db.insert(supportTicketAssignments).values(rows);
}

export async function setTicketLabels(
  db: D1Client,
  organizationId: string,
  ticketId: string,
  labelIds: string[]
): Promise<void> {
  await ensureTicket(db, organizationId, ticketId);

  await db
    .delete(supportTicketLabels)
    .where(eq(supportTicketLabels.ticketId, ticketId));

  if (labelIds.length === 0) return;

  const validLabels = await db
    .select({ id: labels.id })
    .from(labels)
    .where(
      and(
        eq(labels.organizationId, organizationId),
        inArray(labels.id, labelIds)
      )
    );

  const validIds = validLabels.map((label) => label.id);
  const invalid = labelIds.filter((id) => !validIds.includes(id));
  if (invalid.length > 0) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: `Invalid labels: ${invalid.join(", ")}`,
    });
  }

  await db.insert(supportTicketLabels).values(
    validIds.map((labelId) => ({
      id: crypto.randomUUID(),
      ticketId,
      labelId,
    }))
  );
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
    actorType?: SupportTicketActorType;
    actorId?: string | null;
    subType?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }
): Promise<SupportTicketEventWithDetails> {
  await ensureTicket(db, organizationId, ticketId);

  const now = new Date().toISOString();
  const messageCreatedAt = input.createdAt ?? now;
  const eventId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const actorType: SupportTicketActorType =
    input.actorType ??
    (input.customerId ? "customer" : input.userId ? "user" : "automation");
  const actorId = input.actorId ?? input.customerId ?? input.userId ?? null;
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;

  await db.insert(supportTicketEvents).values({
    id: eventId,
    ticketId,
    type: "message",
    subType: input.subType ?? null,
    actorType,
    actorId,
    metadata,
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
    subType: input.subType ?? null,
    actorType,
    actorId,
    metadata,
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

export async function addTicketNote(
  db: D1Client,
  organizationId: string,
  ticketId: string,
  input: {
    body: string;
    userId?: string | null;
    actorType?: SupportTicketActorType;
    actorId?: string | null;
    subType?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }
): Promise<SupportTicketEventWithDetails> {
  await ensureTicket(db, organizationId, ticketId);

  const now = new Date().toISOString();
  const noteCreatedAt = input.createdAt ?? now;
  const eventId = crypto.randomUUID();
  const noteId = crypto.randomUUID();
  const actorType: SupportTicketActorType = input.actorType ?? "user";
  const actorId = input.actorId ?? input.userId ?? null;
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;

  await db.insert(supportTicketEvents).values({
    id: eventId,
    ticketId,
    type: "note",
    subType: input.subType ?? null,
    actorType,
    actorId,
    metadata,
    createdAt: noteCreatedAt,
  });

  await db.insert(supportTicketNotes).values({
    id: noteId,
    eventId,
    body: input.body,
  });

  await db
    .update(supportTickets)
    .set({ updatedAt: noteCreatedAt })
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
    subType: input.subType ?? null,
    actorType,
    actorId,
    metadata,
    createdAt: noteCreatedAt,
    note: {
      id: noteId,
      eventId,
      body: input.body,
    },
  };
}

export async function addTicketEvent(
  db: D1Client,
  organizationId: string,
  ticketId: string,
  input: {
    type: SupportTicketEventType;
    subType?: string | null;
    actorType?: SupportTicketActorType;
    actorId?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }
): Promise<SupportTicketEventWithDetails> {
  await ensureTicket(db, organizationId, ticketId);

  const now = new Date().toISOString();
  const eventCreatedAt = input.createdAt ?? now;
  const eventId = crypto.randomUUID();
  const actorType: SupportTicketActorType = input.actorType ?? "automation";
  const actorId = input.actorId ?? null;
  const metadata = input.metadata ? JSON.stringify(input.metadata) : null;

  await db.insert(supportTicketEvents).values({
    id: eventId,
    ticketId,
    type: input.type,
    subType: input.subType ?? null,
    actorType,
    actorId,
    metadata,
    createdAt: eventCreatedAt,
  });

  await db
    .update(supportTickets)
    .set({ updatedAt: eventCreatedAt })
    .where(
      and(
        eq(supportTickets.id, ticketId),
        eq(supportTickets.organizationId, organizationId)
      )
    );

  return {
    id: eventId,
    ticketId,
    type: input.type,
    subType: input.subType ?? null,
    actorType,
    actorId,
    metadata,
    createdAt: eventCreatedAt,
  };
}

export async function addSupportTicketAttachment(
  db: D1Client,
  organizationId: string,
  ticketId: string,
  eventId: string,
  input: {
    externalId?: string | null;
    url?: string | null;
    fileName?: string | null;
    contentType?: string | null;
    size?: number | null;
  }
): Promise<void> {
  await ensureTicket(db, organizationId, ticketId);

  await db.insert(supportTicketAttachments).values({
    id: crypto.randomUUID(),
    organizationId,
    ticketId,
    eventId,
    externalId: input.externalId ?? null,
    url: input.url ?? null,
    fileName: input.fileName ?? null,
    contentType: input.contentType ?? null,
    size: input.size ?? null,
    r2Key: null,
    createdAt: new Date().toISOString(),
  });
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
    subType: event.subType,
    actorType: event.actorType,
    actorId: event.actorId,
    metadata: event.metadata,
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

export type ExternalSupportAttachment = {
  externalId?: string | null;
  url?: string | null;
  fileName?: string | null;
  contentType?: string | null;
  size?: number | null;
};

export type ExternalSupportReply = {
  body: string;
  direction: SupportTicketMessageDirection;
  kind?: "message" | "note";
  channel?: SupportTicketMessageChannel;
  customerId?: string | null;
  userId?: string | null;
  actorType?: SupportTicketActorType;
  actorId?: string | null;
  subType?: string | null;
  attachments?: ExternalSupportAttachment[];
  metadata?: Record<string, unknown>;
  createdAt?: string;
};

export type ExternalSupportEvent = {
  type: SupportTicketEventType;
  subType?: string | null;
  actorType?: SupportTicketActorType;
  actorId?: string | null;
  createdAt?: string;
  metadata?: Record<string, unknown>;
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
  events?: ExternalSupportEvent[];
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
  events?: ExternalSupportEvent[];
};

export function stripHtml(html: string | null | undefined): string {
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

export function intercomStateToTicketStatus(
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

export function externalPriorityToTicketPriority(
  priority: "none" | "low" | "medium" | "high" | "urgent" | undefined
): SupportTicketPriority {
  if (!priority || priority === "none") return "medium";
  return priority;
}

async function ingestSupportTimeline(
  db: D1Client,
  organizationId: string,
  ticketId: string,
  customerId: string,
  input: {
    firstMessage: string;
    firstMessageCreatedAt: string;
    messageChannel: SupportTicketMessageChannel;
    replies: ExternalSupportReply[];
    events?: ExternalSupportEvent[];
    ticketUpdatedAt: string;
  }
): Promise<void> {
  await addTicketMessage(db, organizationId, ticketId, {
    direction: "inbound",
    textContent: input.firstMessage,
    channel: input.messageChannel,
    customerId,
    createdAt: input.firstMessageCreatedAt,
  });

  const sortedReplies = input.replies.toSorted(
    (a, b) =>
      (a.createdAt ? Date.parse(a.createdAt) : 0) -
      (b.createdAt ? Date.parse(b.createdAt) : 0)
  );
  const sortedEvents = (input.events ?? []).toSorted(
    (a, b) =>
      (a.createdAt ? Date.parse(a.createdAt) : 0) -
      (b.createdAt ? Date.parse(b.createdAt) : 0)
  );

  const createdAts: number[] = [
    Date.parse(input.ticketUpdatedAt),
    Date.parse(input.firstMessageCreatedAt),
    ...sortedReplies.map((reply) =>
      reply.createdAt ? Date.parse(reply.createdAt) : 0
    ),
    ...sortedEvents.map((event) =>
      event.createdAt ? Date.parse(event.createdAt) : 0
    ),
  ];

  await Promise.all(
    sortedReplies.map(async (reply) => {
      let event: SupportTicketEventWithDetails;
      if (reply.kind === "note") {
        event = await addTicketNote(db, organizationId, ticketId, {
          body: stripHtml(reply.body) || "(no content)",
          userId: reply.userId,
          actorType: reply.actorType,
          actorId: reply.actorId,
          subType: reply.subType,
          metadata: reply.metadata,
          createdAt: reply.createdAt,
        });
      } else {
        event = await addTicketMessage(db, organizationId, ticketId, {
          direction: reply.direction,
          textContent: stripHtml(reply.body) || "(no content)",
          markdownContent: reply.body,
          channel: reply.channel ?? input.messageChannel,
          customerId:
            reply.direction === "inbound" ? customerId : reply.customerId,
          userId: reply.userId,
          actorType: reply.actorType,
          actorId: reply.actorId,
          subType: reply.subType,
          metadata: reply.metadata,
          createdAt: reply.createdAt,
        });
      }
      await Promise.all(
        (reply.attachments ?? []).map((attachment) =>
          addSupportTicketAttachment(
            db,
            organizationId,
            ticketId,
            event.id,
            attachment
          )
        )
      );
    })
  );

  await Promise.all(
    sortedEvents.map((eventInput) =>
      addTicketEvent(db, organizationId, ticketId, {
        type: eventInput.type,
        subType: eventInput.subType,
        actorType: eventInput.actorType,
        actorId: eventInput.actorId,
        metadata: eventInput.metadata,
        createdAt: eventInput.createdAt,
      })
    )
  );

  const latest = Math.max(...createdAts);
  const finalUpdatedAt = Number.isFinite(latest)
    ? new Date(latest).toISOString()
    : input.ticketUpdatedAt;
  await db
    .update(supportTickets)
    .set({ updatedAt: finalUpdatedAt })
    .where(
      and(
        eq(supportTickets.id, ticketId),
        eq(supportTickets.organizationId, organizationId)
      )
    );
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
  await ingestSupportTimeline(db, organizationId, ticket.id, customerId, {
    firstMessage,
    firstMessageCreatedAt: createdAt,
    messageChannel,
    replies: conversation.replies,
    events: conversation.events,
    ticketUpdatedAt: updatedAt,
  });

  const full = await getTicketById(db, organizationId, ticket.id);
  if (!full) {
    throw new VortexError({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Imported ticket not found",
    });
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
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 500,
        message: "Imported ticket not found",
      });
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
  await ingestSupportTimeline(db, organizationId, ticket.id, customerId, {
    firstMessage,
    firstMessageCreatedAt: createdAt,
    messageChannel,
    replies: thread.replies,
    events: thread.events,
    ticketUpdatedAt: updatedAt,
  });

  const full = await getTicketById(db, organizationId, ticket.id);
  if (!full) {
    throw new VortexError({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Imported ticket not found",
    });
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
  events?: ExternalSupportEvent[];
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
  await ingestSupportTimeline(db, organizationId, created.id, customerId, {
    firstMessage,
    firstMessageCreatedAt: createdAt,
    messageChannel,
    replies: ticket.replies,
    events: ticket.events,
    ticketUpdatedAt: updatedAt,
  });

  const full = await getTicketById(db, organizationId, created.id);
  if (!full) {
    throw new VortexError({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Imported ticket not found",
    });
  }
  return full;
}
