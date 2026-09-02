import { eq } from "drizzle-orm";
import { D1Client } from "./db.js";
import { projects, cycles, labels, states } from "./schema.js";

const now = () => new Date().toISOString();

// Projects

export function listProjects(db: D1Client, workspaceId: string) {
  return db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, workspaceId))
    .all();
}

export function getProject(db: D1Client, id: string) {
  return db.select().from(projects).where(eq(projects.id, id)).get();
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
    .where(eq(projects.id, id));
  return db.select().from(projects).where(eq(projects.id, id)).get();
}

export async function deleteProject(db: D1Client, id: string) {
  await db.delete(projects).where(eq(projects.id, id));
}

// Cycles

export function listCycles(db: D1Client, workspaceId: string) {
  return db
    .select()
    .from(cycles)
    .where(eq(cycles.workspaceId, workspaceId))
    .all();
}

export function getCycle(db: D1Client, id: string) {
  return db.select().from(cycles).where(eq(cycles.id, id)).get();
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
    .where(eq(cycles.id, id));
  return db.select().from(cycles).where(eq(cycles.id, id)).get();
}

export async function deleteCycle(db: D1Client, id: string) {
  await db.delete(cycles).where(eq(cycles.id, id));
}

// Labels

export function listLabels(db: D1Client, workspaceId: string) {
  return db
    .select()
    .from(labels)
    .where(eq(labels.workspaceId, workspaceId))
    .all();
}

export function getLabel(db: D1Client, id: string) {
  return db.select().from(labels).where(eq(labels.id, id)).get();
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
  id: string,
  values: Partial<{
    name: string;
    color: string | null;
  }>
) {
  await db.update(labels).set(values).where(eq(labels.id, id));
  return db.select().from(labels).where(eq(labels.id, id)).get();
}

export async function deleteLabel(db: D1Client, id: string) {
  await db.delete(labels).where(eq(labels.id, id));
}

// States

export function listStates(db: D1Client, workspaceId: string) {
  return db
    .select()
    .from(states)
    .where(eq(states.workspaceId, workspaceId))
    .all();
}

export function getState(db: D1Client, id: string) {
  return db.select().from(states).where(eq(states.id, id)).get();
}

export async function createState(
  db: D1Client,
  workspaceId: string,
  values: {
    id: string;
    name: string;
    type: string;
    color?: string | null;
    position?: string | null;
  }
) {
  const existing = await db
    .select()
    .from(states)
    .where(eq(states.id, values.id))
    .get();
  if (existing) {
    return existing;
  }
  const ts = now();
  await db.insert(states).values({
    id: values.id,
    workspaceId,
    name: values.name,
    type: values.type,
    color: values.color ?? null,
    position: values.position ?? null,
    createdAt: ts,
  });
  return db.select().from(states).where(eq(states.id, values.id)).get();
}

export async function updateState(
  db: D1Client,
  id: string,
  values: Partial<{
    name: string;
    type: string;
    color: string | null;
    position: string | null;
  }>
) {
  await db.update(states).set(values).where(eq(states.id, id));
  return db.select().from(states).where(eq(states.id, id)).get();
}

export async function deleteState(db: D1Client, id: string) {
  await db.delete(states).where(eq(states.id, id));
}
