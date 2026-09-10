import { and, count, eq, inArray, isNull, ne } from "drizzle-orm";

import type { D1Client } from "./db.js";
import {
  member,
  supportSlas,
  supportTicketAssignments,
  supportTicketSlaEvents,
  supportTickets,
  supportTierMembers,
  supportTiers,
  supportUserStatus,
  user,
} from "./schema.js";
import type {
  SupportTicket,
  SupportTicketPriority,
} from "./support-tickets.js";

export type SupportUserStatus = {
  id: string;
  organizationId: string;
  userId: string;
  status: "active" | "away" | "snoozed" | "offline";
  until: string | null;
  updatedAt: string;
};

export type SupportTier = {
  id: string;
  organizationId: string;
  name: string;
  level: number;
  createdAt: string;
  updatedAt: string;
};

export type SupportTierMember = {
  id: string;
  tierId: string;
  userId: string;
  createdAt: string;
};

export type SupportSla = {
  id: string;
  organizationId: string;
  name: string;
  tierId: string | null;
  priority: SupportTicketPriority;
  firstResponseMinutes: number | null;
  nextResponseMinutes: number | null;
  resolutionMinutes: number | null;
  businessHoursOnly: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SupportSlaEvent = {
  id: string;
  ticketId: string;
  slaId: string;
  type: "first_response_target" | "next_response_target" | "resolution_target";
  targetAt: string;
  metAt: string | null;
  breached: boolean;
};

export type SupportAgent = {
  userId: string;
  name: string;
  email: string;
  status: "active" | "away" | "snoozed" | "offline";
  until: string | null;
  openTickets: number;
};

export type SupportUserStatusInput = {
  status: "active" | "away" | "snoozed" | "offline";
  until?: string | null;
};

export type SupportTierInput = {
  name: string;
  level: number;
};

export type SupportSlaInput = {
  name: string;
  tierId?: string | null;
  priority: SupportTicketPriority;
  firstResponseMinutes?: number | null;
  nextResponseMinutes?: number | null;
  resolutionMinutes?: number | null;
  businessHoursOnly?: boolean;
};

export async function setSupportUserStatus(
  db: D1Client,
  organizationId: string,
  userId: string,
  input: SupportUserStatusInput
): Promise<SupportUserStatus> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const until = input.until ?? null;

  await db
    .insert(supportUserStatus)
    .values({
      id,
      organizationId,
      userId,
      status: input.status,
      until,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [supportUserStatus.organizationId, supportUserStatus.userId],
      set: {
        status: input.status,
        until,
        updatedAt: now,
      },
    });

  const row = await db
    .select()
    .from(supportUserStatus)
    .where(
      and(
        eq(supportUserStatus.organizationId, organizationId),
        eq(supportUserStatus.userId, userId)
      )
    )
    .get();

  return row as unknown as SupportUserStatus;
}

export async function getSupportUserStatus(
  db: D1Client,
  organizationId: string,
  userId: string
): Promise<SupportUserStatus | null> {
  const row = await db
    .select()
    .from(supportUserStatus)
    .where(
      and(
        eq(supportUserStatus.organizationId, organizationId),
        eq(supportUserStatus.userId, userId)
      )
    )
    .get();
  return (row as unknown as SupportUserStatus | undefined) ?? null;
}

export async function listSupportAgents(
  db: D1Client,
  organizationId: string
): Promise<SupportAgent[]> {
  const members = await db
    .select({
      userId: member.userId,
      name: user.name,
      email: user.email,
      status: supportUserStatus.status,
      until: supportUserStatus.until,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .leftJoin(
      supportUserStatus,
      and(
        eq(supportUserStatus.organizationId, organizationId),
        eq(supportUserStatus.userId, member.userId)
      )
    )
    .where(eq(member.organizationId, organizationId));

  const userIds = members.map((m) => m.userId);
  const openCounts = new Map<string, number>();

  if (userIds.length > 0) {
    const counts = await db
      .select({
        userId: supportTicketAssignments.userId,
        openTickets: count(supportTicketAssignments.id),
      })
      .from(supportTicketAssignments)
      .innerJoin(
        supportTickets,
        eq(supportTicketAssignments.ticketId, supportTickets.id)
      )
      .where(
        and(
          eq(supportTickets.organizationId, organizationId),
          inArray(supportTicketAssignments.userId, userIds),
          ne(supportTickets.status, "done")
        )
      )
      .groupBy(supportTicketAssignments.userId);

    for (const row of counts) {
      if (row.userId) {
        openCounts.set(row.userId, row.openTickets);
      }
    }
  }

  return members.map((m) => ({
    userId: m.userId,
    name: m.name,
    email: m.email,
    status: (m.status as SupportAgent["status"] | null) ?? "active",
    until: m.until ?? null,
    openTickets: openCounts.get(m.userId) ?? 0,
  }));
}

export async function createSupportTier(
  db: D1Client,
  organizationId: string,
  input: SupportTierInput
): Promise<SupportTier> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = {
    id,
    organizationId,
    name: input.name,
    level: input.level,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(supportTiers).values(row);
  return row;
}

export async function getSupportTier(
  db: D1Client,
  organizationId: string,
  tierId: string
): Promise<SupportTier | null> {
  const row = await db
    .select()
    .from(supportTiers)
    .where(
      and(
        eq(supportTiers.id, tierId),
        eq(supportTiers.organizationId, organizationId)
      )
    )
    .get();
  return (row as unknown as SupportTier | undefined) ?? null;
}

export async function listSupportTiers(
  db: D1Client,
  organizationId: string
): Promise<SupportTier[]> {
  const rows = await db
    .select()
    .from(supportTiers)
    .where(eq(supportTiers.organizationId, organizationId))
    .orderBy(supportTiers.level, supportTiers.name);
  return rows as unknown as SupportTier[];
}

export async function updateSupportTier(
  db: D1Client,
  organizationId: string,
  tierId: string,
  input: Partial<Pick<SupportTierInput, "name" | "level">>
): Promise<SupportTier | null> {
  const existing = await getSupportTier(db, organizationId, tierId);
  if (!existing) return null;

  const updates: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };
  if (input.name !== undefined) updates.name = input.name;
  if (input.level !== undefined) updates.level = input.level;

  await db
    .update(supportTiers)
    .set(updates)
    .where(
      and(
        eq(supportTiers.id, tierId),
        eq(supportTiers.organizationId, organizationId)
      )
    );

  return getSupportTier(db, organizationId, tierId);
}

export async function deleteSupportTier(
  db: D1Client,
  organizationId: string,
  tierId: string
): Promise<boolean> {
  const existing = await getSupportTier(db, organizationId, tierId);
  if (!existing) return false;
  await db
    .delete(supportTiers)
    .where(
      and(
        eq(supportTiers.id, tierId),
        eq(supportTiers.organizationId, organizationId)
      )
    );
  return true;
}

export async function addSupportTierMember(
  db: D1Client,
  tierId: string,
  userId: string
): Promise<SupportTierMember> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = { id, tierId, userId, createdAt: now };
  await db
    .insert(supportTierMembers)
    .values(row)
    .onConflictDoNothing({
      target: [supportTierMembers.tierId, supportTierMembers.userId],
    });
  const existing = await db
    .select()
    .from(supportTierMembers)
    .where(
      and(
        eq(supportTierMembers.tierId, tierId),
        eq(supportTierMembers.userId, userId)
      )
    )
    .get();
  return (existing ?? row) as unknown as SupportTierMember;
}

export async function removeSupportTierMember(
  db: D1Client,
  tierId: string,
  userId: string
): Promise<boolean> {
  const existing = await db
    .select()
    .from(supportTierMembers)
    .where(
      and(
        eq(supportTierMembers.tierId, tierId),
        eq(supportTierMembers.userId, userId)
      )
    )
    .get();
  if (!existing) return false;
  await db
    .delete(supportTierMembers)
    .where(
      and(
        eq(supportTierMembers.tierId, tierId),
        eq(supportTierMembers.userId, userId)
      )
    );
  return true;
}

export async function listSupportTierMembers(
  db: D1Client,
  tierId: string
): Promise<{ userId: string; name: string; email: string }[]> {
  return db
    .select({
      userId: supportTierMembers.userId,
      name: user.name,
      email: user.email,
    })
    .from(supportTierMembers)
    .innerJoin(user, eq(supportTierMembers.userId, user.id))
    .where(eq(supportTierMembers.tierId, tierId));
}

export async function createSupportSla(
  db: D1Client,
  organizationId: string,
  input: SupportSlaInput
): Promise<SupportSla> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row: SupportSla = {
    id,
    organizationId,
    name: input.name,
    tierId: input.tierId ?? null,
    priority: input.priority,
    firstResponseMinutes: input.firstResponseMinutes ?? null,
    nextResponseMinutes: input.nextResponseMinutes ?? null,
    resolutionMinutes: input.resolutionMinutes ?? null,
    businessHoursOnly: input.businessHoursOnly ?? false,
    createdAt: now,
    updatedAt: now,
  };
  await db
    .insert(supportSlas)
    .values(row as unknown as typeof supportSlas.$inferInsert);
  return row;
}

export async function getSupportSla(
  db: D1Client,
  organizationId: string,
  slaId: string
): Promise<SupportSla | null> {
  const row = await db
    .select()
    .from(supportSlas)
    .where(
      and(
        eq(supportSlas.id, slaId),
        eq(supportSlas.organizationId, organizationId)
      )
    )
    .get();
  return (row as unknown as SupportSla | undefined) ?? null;
}

export async function listSupportSlas(
  db: D1Client,
  organizationId: string
): Promise<SupportSla[]> {
  const rows = await db
    .select()
    .from(supportSlas)
    .where(eq(supportSlas.organizationId, organizationId))
    .orderBy(supportSlas.priority, supportSlas.name);
  return rows as unknown as SupportSla[];
}

export async function updateSupportSla(
  db: D1Client,
  organizationId: string,
  slaId: string,
  input: Partial<SupportSlaInput>
): Promise<SupportSla | null> {
  const existing = await getSupportSla(db, organizationId, slaId);
  if (!existing) return null;

  const updates: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };
  if (input.name !== undefined) updates.name = input.name;
  if (input.tierId !== undefined) updates.tierId = input.tierId ?? null;
  if (input.priority !== undefined) updates.priority = input.priority;
  if (input.firstResponseMinutes !== undefined)
    updates.firstResponseMinutes = input.firstResponseMinutes ?? null;
  if (input.nextResponseMinutes !== undefined)
    updates.nextResponseMinutes = input.nextResponseMinutes ?? null;
  if (input.resolutionMinutes !== undefined)
    updates.resolutionMinutes = input.resolutionMinutes ?? null;
  if (input.businessHoursOnly !== undefined)
    updates.businessHoursOnly = input.businessHoursOnly;

  await db
    .update(supportSlas)
    .set(updates)
    .where(
      and(
        eq(supportSlas.id, slaId),
        eq(supportSlas.organizationId, organizationId)
      )
    );

  return getSupportSla(db, organizationId, slaId);
}

export async function deleteSupportSla(
  db: D1Client,
  organizationId: string,
  slaId: string
): Promise<boolean> {
  const existing = await getSupportSla(db, organizationId, slaId);
  if (!existing) return false;
  await db
    .delete(supportSlas)
    .where(
      and(
        eq(supportSlas.id, slaId),
        eq(supportSlas.organizationId, organizationId)
      )
    );
  return true;
}

export async function createSlaEventsForTicket(
  db: D1Client,
  ticket: SupportTicket
): Promise<SupportSlaEvent[]> {
  const slas = await db
    .select()
    .from(supportSlas)
    .where(
      and(
        eq(supportSlas.organizationId, ticket.organizationId),
        eq(supportSlas.priority, ticket.priority),
        isNull(supportSlas.tierId)
      )
    );

  if (slas.length === 0) return [];

  const createdAt = new Date(ticket.createdAt);
  const events: SupportSlaEvent[] = [];

  for (const sla of slas) {
    const slaRow = sla as unknown as SupportSla;
    const types: {
      type: SupportSlaEvent["type"];
      minutes: number | null;
    }[] = [
      { type: "first_response_target", minutes: slaRow.firstResponseMinutes },
      { type: "next_response_target", minutes: slaRow.nextResponseMinutes },
      { type: "resolution_target", minutes: slaRow.resolutionMinutes },
    ];

    for (const { type, minutes } of types) {
      if (minutes === null || minutes === undefined) continue;
      const targetAt = new Date(
        createdAt.getTime() + minutes * 60 * 1000
      ).toISOString();
      const event: SupportSlaEvent = {
        id: crypto.randomUUID(),
        ticketId: ticket.id,
        slaId: slaRow.id,
        type,
        targetAt,
        metAt: null,
        breached: false,
      };
      events.push(event);
    }
  }

  if (events.length > 0) {
    await db
      .insert(supportTicketSlaEvents)
      .values(
        events as unknown as (typeof supportTicketSlaEvents.$inferInsert)[]
      );
  }

  return events;
}

export async function getSlaEventsForTicket(
  db: D1Client,
  ticketId: string
): Promise<SupportSlaEvent[]> {
  const rows = await db
    .select()
    .from(supportTicketSlaEvents)
    .where(eq(supportTicketSlaEvents.ticketId, ticketId))
    .orderBy(supportTicketSlaEvents.targetAt);
  return rows as unknown as SupportSlaEvent[];
}
