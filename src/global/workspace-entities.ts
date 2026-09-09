import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

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
} from "./schema.js";

const now = () => new Date().toISOString();

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

export async function createProject(
  db: D1Client,
  organizationId: string,
  values: {
    name: string;
    description?: string | null;
    status?: string | null;
    health?: "on_track" | "at_risk" | "off_track" | "paused" | null;
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

export function listLabels(db: D1Client, organizationId: string) {
  return db
    .select()
    .from(labels)
    .where(eq(labels.organizationId, organizationId))
    .all();
}

export function getLabel(db: D1Client, organizationId: string, id: string) {
  return db
    .select()
    .from(labels)
    .where(and(eq(labels.organizationId, organizationId), eq(labels.id, id)))
    .get();
}

export async function createLabel(
  db: D1Client,
  organizationId: string,
  values: {
    name: string;
    color?: string | null;
  }
) {
  const id = crypto.randomUUID();
  const ts = now();
  await db.insert(labels).values({
    id,
    organizationId,
    name: values.name,
    color: values.color ?? null,
    createdAt: ts,
  });
  return db.select().from(labels).where(eq(labels.id, id)).get();
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
  await db
    .update(labels)
    .set(values)
    .where(and(eq(labels.organizationId, organizationId), eq(labels.id, id)));
  return db
    .select()
    .from(labels)
    .where(and(eq(labels.organizationId, organizationId), eq(labels.id, id)))
    .get();
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

export function listStates(db: D1Client, organizationId: string) {
  return db
    .select()
    .from(states)
    .where(eq(states.organizationId, organizationId))
    .all();
}

export function getState(db: D1Client, organizationId: string, id: string) {
  return db
    .select()
    .from(states)
    .where(and(eq(states.organizationId, organizationId), eq(states.id, id)))
    .get();
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
    return existing;
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
  return db.select().from(states).where(eq(states.id, id)).get();
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
  await db
    .update(states)
    .set(values)
    .where(and(eq(states.organizationId, organizationId), eq(states.id, id)));
  return db
    .select()
    .from(states)
    .where(and(eq(states.organizationId, organizationId), eq(states.id, id)))
    .get();
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

// Memberships

const membershipRoleSchema = z.enum(["owner", "admin", "member"]);

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
  organizationId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "member"
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
  const id = crypto.randomUUID();
  await db.insert(member).values({
    id,
    organizationId: organizationId,
    userId,
    role,
    createdAt: new Date(),
  });
  const row = await db.select().from(member).where(eq(member.id, id)).get();
  return mapMember(row!);
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

export function listProjectUpdates(db: D1Client, organizationId: string, projectId: string) {
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

export function getProjectUpdate(db: D1Client, organizationId: string, id: string) {
  return db
    .select()
    .from(projectUpdates)
    .where(
      and(eq(projectUpdates.organizationId, organizationId), eq(projectUpdates.id, id))
    )
    .get();
}

export function getLatestProjectUpdate(db: D1Client, organizationId: string, projectId: string) {
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
      and(eq(projects.organizationId, organizationId), eq(projects.id, values.projectId))
    );
  return db.select().from(projectUpdates).where(eq(projectUpdates.id, id)).get();
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
      and(eq(projectUpdates.organizationId, organizationId), eq(projectUpdates.id, id))
    );
  return db
    .select()
    .from(projectUpdates)
    .where(
      and(eq(projectUpdates.organizationId, organizationId), eq(projectUpdates.id, id))
    )
    .get();
}

export async function deleteProjectUpdate(db: D1Client, organizationId: string, id: string) {
  await db
    .delete(projectUpdates)
    .where(and(eq(projectUpdates.organizationId, organizationId), eq(projectUpdates.id, id)));
}

// Project milestones

export function listProjectMilestones(db: D1Client, organizationId: string, projectId: string) {
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

export function getProjectMilestone(db: D1Client, organizationId: string, id: string) {
  return db
    .select()
    .from(projectMilestones)
    .where(
      and(eq(projectMilestones.organizationId, organizationId), eq(projectMilestones.id, id))
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
  return db.select().from(projectMilestones).where(eq(projectMilestones.id, id)).get();
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
      and(eq(projectMilestones.organizationId, organizationId), eq(projectMilestones.id, id))
    );
  return db
    .select()
    .from(projectMilestones)
    .where(
      and(eq(projectMilestones.organizationId, organizationId), eq(projectMilestones.id, id))
    )
    .get();
}

export async function deleteProjectMilestone(db: D1Client, organizationId: string, id: string) {
  await db
    .delete(projectMilestones)
    .where(
      and(eq(projectMilestones.organizationId, organizationId), eq(projectMilestones.id, id))
    );
}

// Project update reminders

export function getProjectUpdateReminder(db: D1Client, organizationId: string, projectId: string) {
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
  const existing = await getProjectUpdateReminder(db, organizationId, values.projectId);
  if (existing) {
    await db
      .update(projectUpdateReminders)
      .set({
        cadence: values.cadence ?? existing.cadence,
        nextDueAt: values.nextDueAt !== undefined ? values.nextDueAt : existing.nextDueAt,
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
  return db.select().from(projectUpdateReminders).where(eq(projectUpdateReminders.id, id)).get();
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
