import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { D1Client } from "./db.js";
import { cycles, labels, member, projects, states } from "./schema.js";

const now = () => new Date().toISOString();

// Projects

export function listProjects(db: D1Client, workspaceId: string) {
  return db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId))
    .all();
}

export function getProject(db: D1Client, workspaceId: string, id: string) {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)))
    .get();
}

export async function createProject(
  db: D1Client,
  workspaceId: string,
  values: {
    name: string;
    description?: string | null;
    status?: string | null;
    startDate?: string | null;
    endDate?: string | null;
  }
) {
  const id = crypto.randomUUID();
  const ts = now();
  await db.insert(projects).values({
    id,
    workspaceId,
    name: values.name,
    description: values.description ?? null,
    status: values.status ?? "active",
    startDate: values.startDate ?? null,
    endDate: values.endDate ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return db.select().from(projects).where(eq(projects.id, id)).get();
}

export async function updateProject(
  db: D1Client,
  workspaceId: string,
  id: string,
  values: Partial<{
    name: string;
    description: string | null;
    status: string;
    startDate: string | null;
    endDate: string | null;
  }>
) {
  await db
    .update(projects)
    .set({ ...values, updatedAt: now() })
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)));
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)))
    .get();
}

export async function deleteProject(
  db: D1Client,
  workspaceId: string,
  id: string
) {
  await db
    .delete(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id)));
}

// Cycles

export function listCycles(db: D1Client, workspaceId: string) {
  return db
    .select()
    .from(cycles)
    .where(eq(cycles.workspaceId, workspaceId))
    .all();
}

export function getCycle(db: D1Client, workspaceId: string, id: string) {
  return db
    .select()
    .from(cycles)
    .where(and(eq(cycles.workspaceId, workspaceId), eq(cycles.id, id)))
    .get();
}

export async function createCycle(
  db: D1Client,
  workspaceId: string,
  values: {
    projectId?: string | null;
    name: string;
    startDate?: string | null;
    endDate?: string | null;
  }
) {
  const id = crypto.randomUUID();
  const ts = now();
  await db.insert(cycles).values({
    id,
    workspaceId,
    projectId: values.projectId ?? null,
    name: values.name,
    startDate: values.startDate ?? null,
    endDate: values.endDate ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return db.select().from(cycles).where(eq(cycles.id, id)).get();
}

export async function updateCycle(
  db: D1Client,
  workspaceId: string,
  id: string,
  values: Partial<{
    projectId: string | null;
    name: string;
    startDate: string | null;
    endDate: string | null;
  }>
) {
  await db
    .update(cycles)
    .set({ ...values, updatedAt: now() })
    .where(and(eq(cycles.workspaceId, workspaceId), eq(cycles.id, id)));
  return db
    .select()
    .from(cycles)
    .where(and(eq(cycles.workspaceId, workspaceId), eq(cycles.id, id)))
    .get();
}

export async function deleteCycle(
  db: D1Client,
  workspaceId: string,
  id: string
) {
  await db
    .delete(cycles)
    .where(and(eq(cycles.workspaceId, workspaceId), eq(cycles.id, id)));
}

// Labels

export function listLabels(db: D1Client, workspaceId: string) {
  return db
    .select()
    .from(labels)
    .where(eq(labels.workspaceId, workspaceId))
    .all();
}

export function getLabel(db: D1Client, workspaceId: string, id: string) {
  return db
    .select()
    .from(labels)
    .where(and(eq(labels.workspaceId, workspaceId), eq(labels.id, id)))
    .get();
}

export async function createLabel(
  db: D1Client,
  workspaceId: string,
  values: {
    name: string;
    color?: string | null;
  }
) {
  const id = crypto.randomUUID();
  const ts = now();
  await db.insert(labels).values({
    id,
    workspaceId,
    name: values.name,
    color: values.color ?? null,
    createdAt: ts,
  });
  return db.select().from(labels).where(eq(labels.id, id)).get();
}

export async function updateLabel(
  db: D1Client,
  workspaceId: string,
  id: string,
  values: Partial<{
    name: string;
    color: string | null;
  }>
) {
  await db
    .update(labels)
    .set(values)
    .where(and(eq(labels.workspaceId, workspaceId), eq(labels.id, id)));
  return db
    .select()
    .from(labels)
    .where(and(eq(labels.workspaceId, workspaceId), eq(labels.id, id)))
    .get();
}

export async function deleteLabel(
  db: D1Client,
  workspaceId: string,
  id: string
) {
  await db
    .delete(labels)
    .where(and(eq(labels.workspaceId, workspaceId), eq(labels.id, id)));
}

// States

export function listStates(db: D1Client, workspaceId: string) {
  return db
    .select()
    .from(states)
    .where(eq(states.workspaceId, workspaceId))
    .all();
}

export function getState(db: D1Client, workspaceId: string, id: string) {
  return db
    .select()
    .from(states)
    .where(and(eq(states.workspaceId, workspaceId), eq(states.id, id)))
    .get();
}

export async function createState(
  db: D1Client,
  workspaceId: string,
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
        eq(states.workspaceId, workspaceId),
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
    workspaceId,
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
  workspaceId: string,
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
    .where(and(eq(states.workspaceId, workspaceId), eq(states.id, id)));
  return db
    .select()
    .from(states)
    .where(and(eq(states.workspaceId, workspaceId), eq(states.id, id)))
    .get();
}

export async function deleteState(
  db: D1Client,
  workspaceId: string,
  id: string
) {
  await db
    .delete(states)
    .where(and(eq(states.workspaceId, workspaceId), eq(states.id, id)));
}

// Memberships

const membershipRoleSchema = z.enum(["owner", "admin", "member"]);

function mapMember(row: typeof member.$inferSelect) {
  return {
    id: row.id,
    workspaceId: row.organizationId,
    userId: row.userId,
    role: membershipRoleSchema.parse(row.role),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listMemberships(db: D1Client, workspaceId: string) {
  const rows = await db
    .select()
    .from(member)
    .where(eq(member.organizationId, workspaceId))
    .all();
  return rows.map(mapMember);
}

export async function createMembership(
  db: D1Client,
  workspaceId: string,
  userId: string,
  role: "owner" | "admin" | "member" = "member"
) {
  const existing = await db
    .select()
    .from(member)
    .where(
      and(eq(member.organizationId, workspaceId), eq(member.userId, userId))
    )
    .get();
  if (existing) {
    return mapMember(existing);
  }
  const id = crypto.randomUUID();
  await db.insert(member).values({
    id,
    organizationId: workspaceId,
    userId,
    role,
    createdAt: new Date(),
  });
  const row = await db.select().from(member).where(eq(member.id, id)).get();
  return mapMember(row!);
}
