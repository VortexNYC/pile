import { and, asc, count, eq, inArray, max, ne, notInArray } from "drizzle-orm";

import type { D1Client } from "./db.js";
import {
  labels,
  supportCustomers,
  supportSavedViews,
  supportTicketAssignments,
  supportTicketEvents,
  supportTicketLabels,
  supportTicketSlaEvents,
  supportTickets,
} from "./schema.js";
import type { SupportCustomer } from "./support-contacts.js";
import { listSupportAgents } from "./support-team.js";
import {
  listTickets,
  type SupportTicketChannel,
  type SupportTicketPriority,
  type SupportTicketStatus,
} from "./support-tickets.js";

export type SupportInboxTicket = {
  id: string;
  number: number;
  title: string;
  status: SupportTicketStatus;
  priority: SupportTicketPriority;
  customer: SupportCustomer;
  primaryAssignee: string | undefined;
  labels: string[];
  lastCustomerMessageAt: string | undefined;
  lastAgentMessageAt: string | undefined;
  sla: {
    firstResponseTargetAt?: string;
    firstResponseBreached: boolean;
    resolutionTargetAt?: string;
    resolutionBreached: boolean;
  } | null;
  createdAt: string;
  updatedAt: string;
};

export type ListInboxOptions = {
  limit: number;
  cursor?: string;
  status?: SupportTicketStatus;
  priority?: SupportTicketPriority;
  assignedTo?: string;
  customerId?: string;
  channel?: SupportTicketChannel;
  label?: string;
  slaBreach?: boolean;
  q?: string;
};

export async function listInboxTickets(
  db: D1Client,
  organizationId: string,
  options: ListInboxOptions
): Promise<{ tickets: SupportInboxTicket[]; nextCursor: string | null }> {
  const { tickets, nextCursor } = await listTickets(db, organizationId, {
    ...options,
    sourceChannel: options.channel,
    limit: options.limit,
    cursor: options.cursor,
  });

  const customerIds = [...new Set(tickets.map((t) => t.customerId))];
  const ticketIds = tickets.map((t) => t.id);

  const [
    customers,
    primaryAssignees,
    ticketLabels,
    lastCustomerMessages,
    lastAgentMessages,
    slaEvents,
  ] = await Promise.all([
    customerIds.length
      ? db
          .select()
          .from(supportCustomers)
          .where(
            and(
              eq(supportCustomers.organizationId, organizationId),
              inArray(supportCustomers.id, customerIds)
            )
          )
      : Promise.resolve([]),
    ticketIds.length
      ? db
          .select()
          .from(supportTicketAssignments)
          .where(
            and(
              eq(supportTicketAssignments.isPrimary, true),
              inArray(supportTicketAssignments.ticketId, ticketIds)
            )
          )
      : Promise.resolve([]),
    ticketIds.length
      ? db
          .select({
            ticketId: supportTicketLabels.ticketId,
            name: labels.name,
          })
          .from(supportTicketLabels)
          .innerJoin(labels, eq(supportTicketLabels.labelId, labels.id))
          .where(inArray(supportTicketLabels.ticketId, ticketIds))
      : Promise.resolve([]),
    ticketIds.length
      ? db
          .select({
            ticketId: supportTicketEvents.ticketId,
            lastAt: max(supportTicketEvents.createdAt),
          })
          .from(supportTicketEvents)
          .where(
            and(
              inArray(supportTicketEvents.ticketId, ticketIds),
              eq(supportTicketEvents.type, "message"),
              eq(supportTicketEvents.actorType, "customer")
            )
          )
          .groupBy(supportTicketEvents.ticketId)
      : Promise.resolve([]),
    ticketIds.length
      ? db
          .select({
            ticketId: supportTicketEvents.ticketId,
            lastAt: max(supportTicketEvents.createdAt),
          })
          .from(supportTicketEvents)
          .where(
            and(
              inArray(supportTicketEvents.ticketId, ticketIds),
              eq(supportTicketEvents.actorType, "user")
            )
          )
          .groupBy(supportTicketEvents.ticketId)
      : Promise.resolve([]),
    ticketIds.length
      ? db
          .select()
          .from(supportTicketSlaEvents)
          .where(inArray(supportTicketSlaEvents.ticketId, ticketIds))
      : Promise.resolve([]),
  ]);

  const customerById = new Map<string, SupportCustomer>(
    customers.map((c) => [c.id, c as unknown as SupportCustomer])
  );
  const primaryByTicket = new Map<string, string>();
  for (const a of primaryAssignees) {
    const row = a as unknown as { ticketId: string; userId: string | null };
    if (row.userId) {
      primaryByTicket.set(row.ticketId, row.userId);
    }
  }
  const labelsByTicket = new Map<string, string[]>();
  for (const l of ticketLabels) {
    const row = l as unknown as { ticketId: string; name: string };
    const list = labelsByTicket.get(row.ticketId) ?? [];
    list.push(row.name);
    labelsByTicket.set(row.ticketId, list);
  }
  const lastCustomerByTicket = new Map<string, string>();
  for (const row of lastCustomerMessages as unknown as {
    ticketId: string;
    lastAt: string | null;
  }[]) {
    if (row.lastAt) lastCustomerByTicket.set(row.ticketId, row.lastAt);
  }
  const lastAgentByTicket = new Map<string, string>();
  for (const row of lastAgentMessages as unknown as {
    ticketId: string;
    lastAt: string | null;
  }[]) {
    if (row.lastAt) lastAgentByTicket.set(row.ticketId, row.lastAt);
  }

  const slaByTicket = new Map<
    string,
    {
      firstResponse?: { targetAt: string; breached: boolean };
      resolution?: { targetAt: string; breached: boolean };
    }
  >();
  for (const e of slaEvents as unknown as (typeof supportTicketSlaEvents.$inferSelect)[]) {
    const existing = slaByTicket.get(e.ticketId) ?? {};
    if (e.type === "first_response_target") {
      existing.firstResponse = { targetAt: e.targetAt, breached: e.breached };
    } else if (e.type === "resolution_target") {
      existing.resolution = { targetAt: e.targetAt, breached: e.breached };
    }
    slaByTicket.set(e.ticketId, existing);
  }

  const rows: SupportInboxTicket[] = tickets.map((t) => {
    const customer = customerById.get(t.customerId);
    const slaData = slaByTicket.get(t.id);
    const sla =
      slaData?.firstResponse || slaData?.resolution
        ? {
            firstResponseTargetAt: slaData.firstResponse?.targetAt,
            firstResponseBreached: slaData.firstResponse?.breached ?? false,
            resolutionTargetAt: slaData.resolution?.targetAt,
            resolutionBreached: slaData.resolution?.breached ?? false,
          }
        : null;

    return {
      id: t.id,
      number: t.number,
      title: t.title,
      status: t.status,
      priority: t.priority,
      customer: customer as SupportCustomer,
      primaryAssignee: primaryByTicket.get(t.id),
      labels: labelsByTicket.get(t.id) ?? [],
      lastCustomerMessageAt: lastCustomerByTicket.get(t.id),
      lastAgentMessageAt: lastAgentByTicket.get(t.id),
      sla,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  });

  return { tickets: rows, nextCursor };
}

export async function getInboxTicketCounts(
  db: D1Client,
  organizationId: string,
  userId: string
): Promise<{
  todo: number;
  done: number;
  snoozed: number;
  mine: number;
  unassigned: number;
}> {
  const [todoRow, doneRow, snoozedRow, mineRows, assignedRows] =
    await Promise.all([
      db
        .select({ count: count(supportTickets.id) })
        .from(supportTickets)
        .where(
          and(
            eq(supportTickets.organizationId, organizationId),
            eq(supportTickets.status, "todo")
          )
        )
        .get(),
      db
        .select({ count: count(supportTickets.id) })
        .from(supportTickets)
        .where(
          and(
            eq(supportTickets.organizationId, organizationId),
            eq(supportTickets.status, "done")
          )
        )
        .get(),
      db
        .select({ count: count(supportTickets.id) })
        .from(supportTickets)
        .where(
          and(
            eq(supportTickets.organizationId, organizationId),
            eq(supportTickets.status, "snoozed")
          )
        )
        .get(),
      db
        .select({ ticketId: supportTicketAssignments.ticketId })
        .from(supportTicketAssignments)
        .innerJoin(
          supportTickets,
          eq(supportTicketAssignments.ticketId, supportTickets.id)
        )
        .where(
          and(
            eq(supportTickets.organizationId, organizationId),
            ne(supportTickets.status, "done"),
            eq(supportTicketAssignments.userId, userId),
            eq(supportTicketAssignments.isPrimary, true)
          )
        )
        .groupBy(supportTicketAssignments.ticketId)
        .all(),
      db
        .select({ ticketId: supportTicketAssignments.ticketId })
        .from(supportTicketAssignments)
        .innerJoin(
          supportTickets,
          eq(supportTicketAssignments.ticketId, supportTickets.id)
        )
        .where(
          and(
            eq(supportTickets.organizationId, organizationId),
            ne(supportTickets.status, "done"),
            eq(supportTicketAssignments.isPrimary, true)
          )
        )
        .groupBy(supportTicketAssignments.ticketId)
        .all(),
    ]);

  const todo =
    (todoRow as unknown as { count: number | null } | undefined)?.count ?? 0;
  const done =
    (doneRow as unknown as { count: number | null } | undefined)?.count ?? 0;
  const snoozed =
    (snoozedRow as unknown as { count: number | null } | undefined)?.count ?? 0;
  const mine = mineRows.length;
  const totalOpen = todo + snoozed;
  const assignedOpen = assignedRows.length;
  const unassigned = Math.max(0, totalOpen - assignedOpen);

  return { todo, done, snoozed, mine, unassigned };
}

export type SupportSavedViewInput = {
  name: string;
  filter: Record<string, unknown>;
  sort?: Record<string, unknown>;
};

export async function createSupportSavedView(
  db: D1Client,
  organizationId: string,
  userId: string,
  input: SupportSavedViewInput
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = {
    id,
    organizationId,
    userId,
    name: input.name,
    filter: JSON.stringify(input.filter),
    sort: JSON.stringify(input.sort ?? { by: "updated_at", direction: "desc" }),
    createdAt: now,
    updatedAt: now,
  };
  await db
    .insert(supportSavedViews)
    .values(row as unknown as typeof supportSavedViews.$inferInsert);
  return row;
}

export async function getSupportSavedView(
  db: D1Client,
  organizationId: string,
  viewId: string
): Promise<{
  id: string;
  organizationId: string;
  userId: string | null;
  name: string;
  filter: string;
  sort: string;
  createdAt: string;
  updatedAt: string;
} | null> {
  const row = await db
    .select()
    .from(supportSavedViews)
    .where(
      and(
        eq(supportSavedViews.id, viewId),
        eq(supportSavedViews.organizationId, organizationId)
      )
    )
    .get();
  return (row as unknown as typeof row) ?? null;
}

export async function listSupportSavedViews(
  db: D1Client,
  organizationId: string,
  userId: string
) {
  const rows = await db
    .select()
    .from(supportSavedViews)
    .where(
      and(
        eq(supportSavedViews.organizationId, organizationId),
        eq(supportSavedViews.userId, userId)
      )
    )
    .orderBy(supportSavedViews.createdAt);
  return rows as unknown as (typeof supportSavedViews.$inferSelect)[];
}

export async function getNextInboxTicket(
  db: D1Client,
  organizationId: string
): Promise<{ ticketId: string; userId: string } | null> {
  const assigned = await db
    .select({ ticketId: supportTicketAssignments.ticketId })
    .from(supportTicketAssignments)
    .innerJoin(
      supportTickets,
      eq(supportTicketAssignments.ticketId, supportTickets.id)
    )
    .where(
      and(
        eq(supportTickets.organizationId, organizationId),
        eq(supportTickets.status, "todo"),
        eq(supportTicketAssignments.isPrimary, true)
      )
    );
  const assignedIds = assigned.map((a) => a.ticketId);

  const conditions = [
    eq(supportTickets.organizationId, organizationId),
    eq(supportTickets.status, "todo"),
  ];
  if (assignedIds.length > 0) {
    conditions.push(notInArray(supportTickets.id, assignedIds));
  }

  const tickets = await db
    .select()
    .from(supportTickets)
    .where(and(...conditions))
    .orderBy(asc(supportTickets.createdAt))
    .limit(1);
  const ticket = tickets[0];
  if (!ticket) return null;

  const agents = (await listSupportAgents(db, organizationId)).filter(
    (a) => a.status === "active"
  );
  if (agents.length === 0) return null;

  agents.sort((a, b) => {
    if (a.openTickets !== b.openTickets) return a.openTickets - b.openTickets;
    return a.userId.localeCompare(b.userId);
  });

  const agent = agents[0];
  if (!agent) return null;
  return { ticketId: ticket.id, userId: agent.userId };
}
