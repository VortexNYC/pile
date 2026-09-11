import { and, count, eq, inArray, ne } from "drizzle-orm";

import type { D1Client } from "./db.js";
import {
  member,
  supportTicketAssignments,
  supportTickets,
  supportTierMembers,
  supportTiers,
  supportUserStatus,
  user,
} from "./schema.js";

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
