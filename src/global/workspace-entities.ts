import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { createAuth } from "../platform/auth.js";
import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import type { D1Client } from "./db.js";
import {
  cycles,
  initiatives,
  labels,
  member,
  projectMilestones,
  projectUpdateReminders,
  projectUpdates,
  projects,
  roadmaps,
  states,
  supportTicketLabels,
  team,
  teamMember,
} from "./schema.js";

const now = () => new Date().toISOString();

/** VTX-751 — text timestamp columns mix ISO-8601 application writes with
 * legacy SQLite `CURRENT_TIMESTAMP` defaults ("YYYY-MM-DD HH:MM:SS", no
 * timezone marker). Normalize everything the API returns to ISO-8601 UTC. */
function toIsoTimestamp(value: string): string {
  if (value.includes("T")) return value;
  const parsed = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

// Projects

export function listProjects(db: D1Client, organizationId: string) {
  return db
    .select()
    .from(projects)
    .where(eq(projects.organizationId, organizationId))
    .all();
}

export function getProject(db: D1Client, organizationId: string, id: string) {
  return db
    .select()
    .from(projects)
    .where(
      and(eq(projects.organizationId, organizationId), eq(projects.id, id))
    )
    .get();
}

export function findProjectByName(
  db: D1Client,
  organizationId: string,
  name: string,
  excludeId?: string
) {
  const conditions = [
    eq(projects.organizationId, organizationId),
    isNull(projects.archivedAt),
    sql`lower(trim(${projects.name})) = ${name.trim().toLowerCase()}`,
  ];
  if (excludeId) {
    conditions.push(sql`${projects.id} <> ${excludeId}`);
  }
  return db
    .select()
    .from(projects)
    .where(and(...conditions))
    .get();
}

export async function createProject(
  db: D1Client,
  organizationId: string,
  values: {
    name: string;
    description?: string | null;
    status?: string | null;
    health?: "on_track" | "at_risk" | "off_track" | "paused" | null;
    leadId?: string | null;
    archivedAt?: string | null;
    startDate?: string | null;
    endDate?: string | null;
  }
) {
  const id = crypto.randomUUID();
  const ts = now();
  await db.insert(projects).values({
    id,
    organizationId,
    name: values.name,
    description: values.description ?? null,
    status: values.status ?? "active",
    health: values.health ?? "on_track",
    leadId: values.leadId ?? null,
    archivedAt: values.archivedAt ?? null,
    startDate: values.startDate ?? null,
    endDate: values.endDate ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return db.select().from(projects).where(eq(projects.id, id)).get();
}

export async function updateProject(
  db: D1Client,
  organizationId: string,
  id: string,
  values: Partial<{
    name: string;
    description: string | null;
    status: string;
    health: "on_track" | "at_risk" | "off_track" | "paused";
    leadId: string | null;
    archivedAt: string | null;
    startDate: string | null;
    endDate: string | null;
  }>
) {
  await db
    .update(projects)
    .set({ ...values, updatedAt: now() })
    .where(
      and(eq(projects.organizationId, organizationId), eq(projects.id, id))
    );
  return db
    .select()
    .from(projects)
    .where(
      and(eq(projects.organizationId, organizationId), eq(projects.id, id))
    )
    .get();
}

export async function archiveProject(
  db: D1Client,
  organizationId: string,
  id: string
) {
  return updateProject(db, organizationId, id, { archivedAt: now() });
}

export async function unarchiveProject(
  db: D1Client,
  organizationId: string,
  id: string
) {
  return updateProject(db, organizationId, id, { archivedAt: null });
}

export async function deleteProject(
  db: D1Client,
  organizationId: string,
  id: string
) {
  await db
    .delete(projects)
    .where(
      and(eq(projects.organizationId, organizationId), eq(projects.id, id))
    );
}

// Cycles

export function listCycles(db: D1Client, organizationId: string) {
  return db
    .select()
    .from(cycles)
    .where(eq(cycles.organizationId, organizationId))
    .all();
}

export function getCycle(db: D1Client, organizationId: string, id: string) {
  return db
    .select()
    .from(cycles)
    .where(and(eq(cycles.organizationId, organizationId), eq(cycles.id, id)))
    .get();
}

export async function createCycle(
  db: D1Client,
  organizationId: string,
  values: {
    projectId?: string | null;
    name: string;
    number?: number | null;
    status?: "upcoming" | "active" | "completed";
    autoRollover?: boolean;
    startDate?: string | null;
    endDate?: string | null;
  }
) {
  const id = crypto.randomUUID();
  const ts = now();
  await db.insert(cycles).values({
    id,
    organizationId,
    projectId: values.projectId ?? null,
    name: values.name,
    number: values.number ?? null,
    status: values.status ?? "upcoming",
    autoRollover: values.autoRollover ?? true,
    startDate: values.startDate ?? null,
    endDate: values.endDate ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return db.select().from(cycles).where(eq(cycles.id, id)).get();
}

export async function updateCycle(
  db: D1Client,
  organizationId: string,
  id: string,
  values: Partial<{
    projectId: string | null;
    name: string;
    number: number | null;
    status: "upcoming" | "active" | "completed";
    autoRollover: boolean;
    archivedAt: string | null;
    startDate: string | null;
    endDate: string | null;
  }>
) {
  await db
    .update(cycles)
    .set({ ...values, updatedAt: now() })
    .where(and(eq(cycles.organizationId, organizationId), eq(cycles.id, id)));
  return db
    .select()
    .from(cycles)
    .where(and(eq(cycles.organizationId, organizationId), eq(cycles.id, id)))
    .get();
}

export async function archiveCycle(
  db: D1Client,
  organizationId: string,
  id: string
) {
  return updateCycle(db, organizationId, id, { archivedAt: now() });
}

export async function unarchiveCycle(
  db: D1Client,
  organizationId: string,
  id: string
) {
  return updateCycle(db, organizationId, id, { archivedAt: null });
}

export async function deleteCycle(
  db: D1Client,
  organizationId: string,
  id: string
) {
  await db
    .delete(cycles)
    .where(and(eq(cycles.organizationId, organizationId), eq(cycles.id, id)));
}

// Labels

type LabelRow = typeof labels.$inferSelect;
type StateRow = typeof states.$inferSelect;

function mapLabelRow(row: LabelRow): LabelRow {
  return {
    ...row,
    createdAt: toIsoTimestamp(row.createdAt),
    updatedAt: toIsoTimestamp(row.updatedAt),
  };
}

function mapStateRow(row: StateRow): StateRow {
  return { ...row, createdAt: toIsoTimestamp(row.createdAt) };
}

export async function listLabels(db: D1Client, organizationId: string) {
  const rows = await db
    .select()
    .from(labels)
    .where(eq(labels.organizationId, organizationId))
    .all();
  return rows.map(mapLabelRow);
}

export async function getLabel(
  db: D1Client,
  organizationId: string,
  id: string
) {
  const row = await db
    .select()
    .from(labels)
    .where(and(eq(labels.organizationId, organizationId), eq(labels.id, id)))
    .get();
  return row === undefined ? undefined : mapLabelRow(row);
}

export async function createLabel(
  db: D1Client,
  organizationId: string,
  values: {
    name: string;
    color?: string | null;
    kind?: "issue" | "support";
  }
) {
  // VTX-752 — labels are unique per (workspace, name, kind). A repeated
  // create returns the canonical row instead of minting the "daytona"-style
  // duplicates the ticket reported.
  const kind = values.kind ?? "issue";
  const existing = await db
    .select()
    .from(labels)
    .where(
      and(
        eq(labels.organizationId, organizationId),
        eq(labels.name, values.name),
        eq(labels.kind, kind)
      )
    )
    .get();
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID();
  const ts = now();
  await db.insert(labels).values({
    id,
    organizationId,
    name: values.name,
    color: values.color ?? null,
    kind,
    createdAt: ts,
  });
  const row = await db.select().from(labels).where(eq(labels.id, id)).get();
  return row === undefined ? undefined : mapLabelRow(row);
}

export async function updateLabel(
  db: D1Client,
  organizationId: string,
  id: string,
  values: Partial<{
    name: string;
    color: string | null;
  }>
) {
  if (values.name !== undefined) {
    // VTX-752 — a rename onto an existing (name, kind) pair would mint the
    // duplicate the unique index forbids; reject it instead.
    const current = await db
      .select()
      .from(labels)
      .where(and(eq(labels.organizationId, organizationId), eq(labels.id, id)))
      .get();
    if (!current) {
      return undefined;
    }
    const collision = await db
      .select({ id: labels.id })
      .from(labels)
      .where(
        and(
          eq(labels.organizationId, organizationId),
          eq(labels.name, values.name),
          eq(labels.kind, current.kind)
        )
      )
      .get();
    if (collision && collision.id !== id) {
      throw VortexError.fromCode(
        "CONFLICT",
        `A ${current.kind} label named "${values.name}" already exists`
      );
    }
  }
  await db
    .update(labels)
    .set(values)
    .where(and(eq(labels.organizationId, organizationId), eq(labels.id, id)));
  const row = await db
    .select()
    .from(labels)
    .where(and(eq(labels.organizationId, organizationId), eq(labels.id, id)))
    .get();
  return row === undefined ? undefined : mapLabelRow(row);
}

export async function deleteLabel(
  db: D1Client,
  organizationId: string,
  id: string
) {
  await db
    .delete(labels)
    .where(and(eq(labels.organizationId, organizationId), eq(labels.id, id)));
}

// States

export async function listStates(db: D1Client, organizationId: string) {
  const rows = await db
    .select()
    .from(states)
    .where(eq(states.organizationId, organizationId))
    .all();
  return rows.map(mapStateRow);
}

export async function getState(
  db: D1Client,
  organizationId: string,
  id: string
) {
  const row = await db
    .select()
    .from(states)
    .where(and(eq(states.organizationId, organizationId), eq(states.id, id)))
    .get();
  return row === undefined ? undefined : mapStateRow(row);
}

export async function createState(
  db: D1Client,
  organizationId: string,
  values: {
    linearId: string;
    name: string;
    type: string;
    color?: string | null;
    position?: string | null;
  }
) {
  const existing = await db
    .select()
    .from(states)
    .where(
      and(
        eq(states.organizationId, organizationId),
        eq(states.linearId, values.linearId)
      )
    )
    .get();
  if (existing) {
    return mapStateRow(existing);
  }
  // VTX-752 — states are unique per (workspace, name): a repeated create
  // with a fresh linearId but a name the workspace already has returns the
  // canonical row rather than minting the second "Backlog".
  const sameName = await db
    .select()
    .from(states)
    .where(
      and(
        eq(states.organizationId, organizationId),
        eq(states.name, values.name)
      )
    )
    .get();
  if (sameName) {
    return sameName;
  }
  const id = crypto.randomUUID();
  const ts = now();
  await db.insert(states).values({
    id,
    organizationId,
    linearId: values.linearId,
    name: values.name,
    type: values.type,
    color: values.color ?? null,
    position: values.position ?? null,
    createdAt: ts,
  });
  const row = await db.select().from(states).where(eq(states.id, id)).get();
  return row === undefined ? undefined : mapStateRow(row);
}

export async function updateState(
  db: D1Client,
  organizationId: string,
  id: string,
  values: Partial<{
    name: string;
    type: string;
    color: string | null;
    position: string | null;
  }>
) {
  if (values.name !== undefined) {
    // VTX-752 — a rename onto an existing state name would mint a dup.
    const collision = await db
      .select({ id: states.id })
      .from(states)
      .where(
        and(
          eq(states.organizationId, organizationId),
          eq(states.name, values.name)
        )
      )
      .get();
    if (collision && collision.id !== id) {
      throw VortexError.fromCode(
        "CONFLICT",
        `A state named "${values.name}" already exists`
      );
    }
  }
  await db
    .update(states)
    .set(values)
    .where(and(eq(states.organizationId, organizationId), eq(states.id, id)));
  const row = await db
    .select()
    .from(states)
    .where(and(eq(states.organizationId, organizationId), eq(states.id, id)))
    .get();
  return row === undefined ? undefined : mapStateRow(row);
}

export async function deleteState(
  db: D1Client,
  organizationId: string,
  id: string
) {
  await db
    .delete(states)
    .where(and(eq(states.organizationId, organizationId), eq(states.id, id)));
}

// ---- dedupe (VTX-752) ----
// Unguarded creates minted duplicate labels ("daytona" twice) and duplicate
// standard states. These merges collapse each (name[, kind]) group to the
// oldest row — the canonical pick the migration bakes in — repoint every
// D1-side reference, delete the dup rows, and return the dup→canonical map
// so the caller can repoint DO-side references (issue label_ids CSVs,
// git_automation_states.state_id) in the same pass.

type DedupeResult = {
  merged: number;
  idMap: Record<string, string>;
};

const pickCanonical = <T extends { id: string; createdAt: string }>(
  group: T[]
): T =>
  group.toSorted(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  )[0];

export async function mergeDuplicateLabels(
  db: D1Client,
  organizationId: string
): Promise<DedupeResult> {
  const rows = await db
    .select()
    .from(labels)
    .where(eq(labels.organizationId, organizationId))
    .all();
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.kind}${row.name}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const idMap: Record<string, string> = {};
  let merged = 0;
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    const canonical = pickCanonical(group);
    for (const dup of group) {
      if (dup.id === canonical.id) {
        continue;
      }
      idMap[dup.id] = canonical.id;
      // Repoint support-ticket joins; rows that would collide on
      // (ticketId, labelId) are deleted instead.
      const joins = await db
        .select()
        .from(supportTicketLabels)
        .where(eq(supportTicketLabels.labelId, dup.id))
        .all();
      for (const join of joins) {
        const already = await db
          .select({ id: supportTicketLabels.id })
          .from(supportTicketLabels)
          .where(
            and(
              eq(supportTicketLabels.ticketId, join.ticketId),
              eq(supportTicketLabels.labelId, canonical.id)
            )
          )
          .get();
        if (already) {
          await db
            .delete(supportTicketLabels)
            .where(eq(supportTicketLabels.id, join.id));
        } else {
          await db
            .update(supportTicketLabels)
            .set({ labelId: canonical.id })
            .where(eq(supportTicketLabels.id, join.id));
        }
      }
      await db.delete(labels).where(eq(labels.id, dup.id));
      merged += 1;
    }
  }
  return { merged, idMap };
}

export async function mergeDuplicateStates(
  db: D1Client,
  organizationId: string
): Promise<DedupeResult> {
  const rows = await db
    .select()
    .from(states)
    .where(eq(states.organizationId, organizationId))
    .all();
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    groups.set(row.name, [...(groups.get(row.name) ?? []), row]);
  }
  const idMap: Record<string, string> = {};
  let merged = 0;
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    const canonical = pickCanonical(group);
    for (const dup of group) {
      if (dup.id === canonical.id) {
        continue;
      }
      idMap[dup.id] = canonical.id;
      await db.delete(states).where(eq(states.id, dup.id));
      merged += 1;
    }
  }
  return { merged, idMap };
}

// Memberships

// Any BA role name is valid — builtins + dynamic organizationRole rows.
const membershipRoleSchema = z.string();

function mapMember(row: typeof member.$inferSelect) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    role: membershipRoleSchema.parse(row.role),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listMemberships(db: D1Client, organizationId: string) {
  const rows = await db
    .select()
    .from(member)
    .where(eq(member.organizationId, organizationId))
    .all();
  return rows.map(mapMember);
}

export async function createMembership(
  db: D1Client,
  env: AppEnv,
  organizationId: string,
  userId: string,
  role = "member"
) {
  const existing = await db
    .select()
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId))
    )
    .get();
  if (existing) {
    return mapMember(existing);
  }
  const auth = await createAuth(env);
  const result = await auth.api.addMember({
    body: {
      userId,
      role: role as "owner" | "admin" | "member" | "guest",
      organizationId,
    },
  });
  const row = z
    .object({
      id: z.string(),
      organizationId: z.string(),
      userId: z.string(),
      role: z.string(),
      createdAt: z.coerce.date(),
    })
    .parse(result);
  return mapMember({
    ...row,
    role: membershipRoleSchema.parse(row.role),
    createdAt: row.createdAt,
  });
}

// PILE-623 — change a member's role; demoting the last owner is refused so
// a workspace can never end up unowned.
export async function updateMembershipRole(
  db: D1Client,
  organizationId: string,
  membershipId: string,
  role: string
) {
  const existing = await db
    .select()
    .from(member)
    .where(
      and(
        eq(member.id, membershipId),
        eq(member.organizationId, organizationId)
      )
    )
    .get();
  if (!existing) return null;
  if (existing.role === "owner" && role !== "owner") {
    const otherOwners = await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.role, "owner"),
          sql`${member.id} != ${membershipId}`
        )
      )
      .all();
    if (otherOwners.length === 0) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Cannot downgrade the last workspace owner",
      });
    }
  }
  await db.update(member).set({ role }).where(eq(member.id, membershipId));
  return mapMember({ ...existing, role });
}

// PILE-623 — remove a member and cascade their team_member installs so no
// orphaned rows linger. Removing the last owner is refused.
export async function deleteMembership(
  db: D1Client,
  organizationId: string,
  membershipId: string
): Promise<{ deleted: boolean; userId: string | null }> {
  const existing = await db
    .select()
    .from(member)
    .where(
      and(
        eq(member.id, membershipId),
        eq(member.organizationId, organizationId)
      )
    )
    .get();
  if (!existing) return { deleted: false, userId: null };
  if (existing.role === "owner") {
    const otherOwners = await db
      .select({ id: member.id })
      .from(member)
      .where(
        and(
          eq(member.organizationId, organizationId),
          eq(member.role, "owner"),
          sql`${member.id} != ${membershipId}`
        )
      )
      .all();
    if (otherOwners.length === 0) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Cannot remove the last workspace owner",
      });
    }
  }
  const orgTeamIds = (
    await db
      .select({ id: team.id })
      .from(team)
      .where(eq(team.organizationId, organizationId))
      .all()
  ).map((t) => t.id);
  if (orgTeamIds.length > 0) {
    await db
      .delete(teamMember)
      .where(
        and(
          eq(teamMember.userId, existing.userId),
          inArray(teamMember.teamId, orgTeamIds)
        )
      );
  }
  await db.delete(member).where(eq(member.id, membershipId));
  return { deleted: true, userId: existing.userId };
}

// Roadmaps

export function listRoadmaps(db: D1Client, organizationId: string) {
  return db
    .select()
    .from(roadmaps)
    .where(eq(roadmaps.organizationId, organizationId))
    .all();
}

export function getRoadmap(db: D1Client, organizationId: string, id: string) {
  return db
    .select()
    .from(roadmaps)
    .where(
      and(eq(roadmaps.organizationId, organizationId), eq(roadmaps.id, id))
    )
    .get();
}

export async function createRoadmap(
  db: D1Client,
  organizationId: string,
  values: {
    name: string;
    description?: string | null;
  }
) {
  const id = crypto.randomUUID();
  const ts = now();
  await db.insert(roadmaps).values({
    id,
    organizationId,
    name: values.name,
    description: values.description ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return db.select().from(roadmaps).where(eq(roadmaps.id, id)).get();
}

export async function updateRoadmap(
  db: D1Client,
  organizationId: string,
  id: string,
  values: Partial<{
    name: string;
    description: string | null;
  }>
) {
  await db
    .update(roadmaps)
    .set({ ...values, updatedAt: now() })
    .where(
      and(eq(roadmaps.organizationId, organizationId), eq(roadmaps.id, id))
    );
  return db
    .select()
    .from(roadmaps)
    .where(
      and(eq(roadmaps.organizationId, organizationId), eq(roadmaps.id, id))
    )
    .get();
}

export async function deleteRoadmap(
  db: D1Client,
  organizationId: string,
  id: string
) {
  await db
    .delete(roadmaps)
    .where(
      and(eq(roadmaps.organizationId, organizationId), eq(roadmaps.id, id))
    );
}

// Initiatives

export function listInitiatives(
  db: D1Client,
  organizationId: string,
  roadmapId?: string
) {
  const conditions = [eq(initiatives.organizationId, organizationId)];
  if (roadmapId) {
    conditions.push(eq(initiatives.roadmapId, roadmapId));
  }
  return db
    .select()
    .from(initiatives)
    .where(and(...conditions))
    .all();
}

export function getInitiative(
  db: D1Client,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(initiatives)
    .where(
      and(
        eq(initiatives.organizationId, organizationId),
        eq(initiatives.id, id)
      )
    )
    .get();
}

export async function createInitiative(
  db: D1Client,
  organizationId: string,
  values: {
    roadmapId?: string | null;
    name: string;
    description?: string | null;
    status?: string | null;
    startDate?: string | null;
    targetDate?: string | null;
  }
) {
  const id = crypto.randomUUID();
  const ts = now();
  await db.insert(initiatives).values({
    id,
    organizationId,
    roadmapId: values.roadmapId ?? null,
    name: values.name,
    description: values.description ?? null,
    status: values.status ?? "active",
    startDate: values.startDate ?? null,
    targetDate: values.targetDate ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return db.select().from(initiatives).where(eq(initiatives.id, id)).get();
}

export async function updateInitiative(
  db: D1Client,
  organizationId: string,
  id: string,
  values: Partial<{
    roadmapId: string | null;
    name: string;
    description: string | null;
    status: string;
    startDate: string | null;
    targetDate: string | null;
  }>
) {
  await db
    .update(initiatives)
    .set({ ...values, updatedAt: now() })
    .where(
      and(
        eq(initiatives.organizationId, organizationId),
        eq(initiatives.id, id)
      )
    );
  return db
    .select()
    .from(initiatives)
    .where(
      and(
        eq(initiatives.organizationId, organizationId),
        eq(initiatives.id, id)
      )
    )
    .get();
}

export async function deleteInitiative(
  db: D1Client,
  organizationId: string,
  id: string
) {
  await db
    .delete(initiatives)
    .where(
      and(
        eq(initiatives.organizationId, organizationId),
        eq(initiatives.id, id)
      )
    );
}

// Project updates

export function listProjectUpdates(
  db: D1Client,
  organizationId: string,
  projectId: string
) {
  return db
    .select()
    .from(projectUpdates)
    .where(
      and(
        eq(projectUpdates.organizationId, organizationId),
        eq(projectUpdates.projectId, projectId)
      )
    )
    .orderBy(desc(projectUpdates.createdAt))
    .all();
}

export function getProjectUpdate(
  db: D1Client,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(projectUpdates)
    .where(
      and(
        eq(projectUpdates.organizationId, organizationId),
        eq(projectUpdates.id, id)
      )
    )
    .get();
}

export function getLatestProjectUpdate(
  db: D1Client,
  organizationId: string,
  projectId: string
) {
  return db
    .select()
    .from(projectUpdates)
    .where(
      and(
        eq(projectUpdates.organizationId, organizationId),
        eq(projectUpdates.projectId, projectId)
      )
    )
    .orderBy(desc(projectUpdates.createdAt))
    .limit(1)
    .get();
}

export async function createProjectUpdate(
  db: D1Client,
  organizationId: string,
  values: {
    projectId: string;
    content: string;
    contentFormat?: "text" | "markdown" | "blocks";
    health?: "on_track" | "at_risk" | "off_track" | "paused";
    createdById?: string;
  }
) {
  const id = crypto.randomUUID();
  const ts = now();
  await db.insert(projectUpdates).values({
    id,
    organizationId,
    projectId: values.projectId,
    content: values.content,
    contentFormat: values.contentFormat ?? "text",
    health: values.health ?? "on_track",
    createdById: values.createdById ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  await db
    .update(projects)
    .set({ health: values.health ?? "on_track", updatedAt: ts })
    .where(
      and(
        eq(projects.organizationId, organizationId),
        eq(projects.id, values.projectId)
      )
    );
  return db
    .select()
    .from(projectUpdates)
    .where(eq(projectUpdates.id, id))
    .get();
}

export async function updateProjectUpdate(
  db: D1Client,
  organizationId: string,
  id: string,
  values: Partial<{
    content: string;
    contentFormat: "text" | "markdown" | "blocks";
    health: "on_track" | "at_risk" | "off_track" | "paused";
  }>
) {
  await db
    .update(projectUpdates)
    .set({ ...values, updatedAt: now() })
    .where(
      and(
        eq(projectUpdates.organizationId, organizationId),
        eq(projectUpdates.id, id)
      )
    );
  return db
    .select()
    .from(projectUpdates)
    .where(
      and(
        eq(projectUpdates.organizationId, organizationId),
        eq(projectUpdates.id, id)
      )
    )
    .get();
}

export async function deleteProjectUpdate(
  db: D1Client,
  organizationId: string,
  id: string
) {
  await db
    .delete(projectUpdates)
    .where(
      and(
        eq(projectUpdates.organizationId, organizationId),
        eq(projectUpdates.id, id)
      )
    );
}

// Project milestones

export function listProjectMilestones(
  db: D1Client,
  organizationId: string,
  projectId: string
) {
  return db
    .select()
    .from(projectMilestones)
    .where(
      and(
        eq(projectMilestones.organizationId, organizationId),
        eq(projectMilestones.projectId, projectId)
      )
    )
    .orderBy(asc(projectMilestones.targetDate))
    .all();
}

export function getProjectMilestone(
  db: D1Client,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(projectMilestones)
    .where(
      and(
        eq(projectMilestones.organizationId, organizationId),
        eq(projectMilestones.id, id)
      )
    )
    .get();
}

export async function createProjectMilestone(
  db: D1Client,
  organizationId: string,
  values: {
    projectId: string;
    name: string;
    description?: string | null;
    targetDate?: string | null;
    completedAt?: string | null;
  }
) {
  const id = crypto.randomUUID();
  const ts = now();
  await db.insert(projectMilestones).values({
    id,
    organizationId,
    projectId: values.projectId,
    name: values.name,
    description: values.description ?? null,
    targetDate: values.targetDate ?? null,
    completedAt: values.completedAt ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return db
    .select()
    .from(projectMilestones)
    .where(eq(projectMilestones.id, id))
    .get();
}

export async function updateProjectMilestone(
  db: D1Client,
  organizationId: string,
  id: string,
  values: Partial<{
    name: string;
    description: string | null;
    targetDate: string | null;
    completedAt: string | null;
  }>
) {
  await db
    .update(projectMilestones)
    .set({ ...values, updatedAt: now() })
    .where(
      and(
        eq(projectMilestones.organizationId, organizationId),
        eq(projectMilestones.id, id)
      )
    );
  return db
    .select()
    .from(projectMilestones)
    .where(
      and(
        eq(projectMilestones.organizationId, organizationId),
        eq(projectMilestones.id, id)
      )
    )
    .get();
}

export async function deleteProjectMilestone(
  db: D1Client,
  organizationId: string,
  id: string
) {
  await db
    .delete(projectMilestones)
    .where(
      and(
        eq(projectMilestones.organizationId, organizationId),
        eq(projectMilestones.id, id)
      )
    );
}

// Project update reminders

export function getProjectUpdateReminder(
  db: D1Client,
  organizationId: string,
  projectId: string
) {
  return db
    .select()
    .from(projectUpdateReminders)
    .where(
      and(
        eq(projectUpdateReminders.organizationId, organizationId),
        eq(projectUpdateReminders.projectId, projectId)
      )
    )
    .get();
}

export async function upsertProjectUpdateReminder(
  db: D1Client,
  organizationId: string,
  values: {
    projectId: string;
    cadence?: "daily" | "weekly" | "biweekly" | "monthly";
    nextDueAt?: string | null;
  }
) {
  const existing = await getProjectUpdateReminder(
    db,
    organizationId,
    values.projectId
  );
  if (existing) {
    await db
      .update(projectUpdateReminders)
      .set({
        cadence: values.cadence ?? existing.cadence,
        nextDueAt:
          values.nextDueAt !== undefined
            ? values.nextDueAt
            : existing.nextDueAt,
        updatedAt: now(),
      })
      .where(
        and(
          eq(projectUpdateReminders.organizationId, organizationId),
          eq(projectUpdateReminders.projectId, values.projectId)
        )
      );
    return getProjectUpdateReminder(db, organizationId, values.projectId);
  }

  const id = crypto.randomUUID();
  const ts = now();
  await db.insert(projectUpdateReminders).values({
    id,
    organizationId,
    projectId: values.projectId,
    cadence: values.cadence ?? "weekly",
    nextDueAt: values.nextDueAt ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return db
    .select()
    .from(projectUpdateReminders)
    .where(eq(projectUpdateReminders.id, id))
    .get();
}

export async function deleteProjectUpdateReminder(
  db: D1Client,
  organizationId: string,
  projectId: string
) {
  await db
    .delete(projectUpdateReminders)
    .where(
      and(
        eq(projectUpdateReminders.organizationId, organizationId),
        eq(projectUpdateReminders.projectId, projectId)
      )
    );
}

function advanceCadence(date: Date, cadence: string) {
  const next = new Date(date.getTime());
  if (cadence === "daily") {
    next.setDate(next.getDate() + 1);
  } else if (cadence === "weekly") {
    next.setDate(next.getDate() + 7);
  } else if (cadence === "biweekly") {
    next.setDate(next.getDate() + 14);
  } else if (cadence === "monthly") {
    next.setMonth(next.getMonth() + 1);
  }
  return next.toISOString();
}

export async function fireDueProjectUpdateReminders(
  db: D1Client,
  organizationId: string,
  actorId: string
) {
  const ts = now();
  const due = await db
    .select()
    .from(projectUpdateReminders)
    .where(
      and(
        eq(projectUpdateReminders.organizationId, organizationId),
        lte(projectUpdateReminders.nextDueAt, ts)
      )
    )
    .all();

  await Promise.all(
    due.map(async (reminder) => {
      if (!reminder.nextDueAt) return;
      const latest = await getLatestProjectUpdate(
        db,
        organizationId,
        reminder.projectId
      );
      const health = latest?.health ?? "on_track";
      await createProjectUpdate(db, organizationId, {
        projectId: reminder.projectId,
        content: `Project update due for ${reminder.cadence} cadence.`,
        contentFormat: "text",
        health,
        createdById: actorId,
      });
      let next = new Date(reminder.nextDueAt);
      while (next.toISOString() <= ts) {
        next = new Date(advanceCadence(next, reminder.cadence));
      }
      await db
        .update(projectUpdateReminders)
        .set({ nextDueAt: next.toISOString(), updatedAt: ts })
        .where(eq(projectUpdateReminders.id, reminder.id));
    })
  );

  return due.length;
}
