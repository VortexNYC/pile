import { and, eq } from "drizzle-orm";

import type { FilterCondition } from "../workspace/filter.js";
import type { D1Client } from "./db.js";
import { savedViews } from "./schema.js";

export interface SavedViewInput {
  workspaceId: string;
  ownerId: string;
  name: string;
  filter: FilterCondition;
  search?: string | null;
  sort?: SavedViewSort | null;
  columns?: string[] | null;
}

export interface SavedViewSort {
  field: string;
  direction?: "asc" | "desc";
}

export interface SavedViewRecord {
  id: string;
  workspaceId: string;
  ownerId: string;
  name: string;
  filter: string;
  search: string | null;
  sort: string | null;
  columns: string | null;
  createdAt: string;
  updatedAt: string;
}

export function createSavedView(
  db: D1Client,
  input: SavedViewInput
): Promise<SavedViewRecord> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = {
    id,
    workspaceId: input.workspaceId,
    ownerId: input.ownerId,
    name: input.name,
    filter: JSON.stringify(input.filter),
    search: input.search ?? null,
    sort: input.sort ? JSON.stringify(input.sort) : null,
    columns: input.columns ? JSON.stringify(input.columns) : null,
    createdAt: now,
    updatedAt: now,
  };
  return db.insert(savedViews).values(row).returning().get();
}

export function listSavedViews(
  db: D1Client,
  workspaceId: string
): Promise<SavedViewRecord[]> {
  return db
    .select()
    .from(savedViews)
    .where(eq(savedViews.workspaceId, workspaceId))
    .all();
}

export function getSavedView(
  db: D1Client,
  id: string,
  workspaceId: string
): Promise<SavedViewRecord | undefined> {
  return db
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.id, id), eq(savedViews.workspaceId, workspaceId)))
    .get();
}

export interface SavedViewUpdate {
  name?: string;
  filter?: FilterCondition;
  search?: string | null;
  sort?: SavedViewSort | null;
  columns?: string[] | null;
}

export function updateSavedView(
  db: D1Client,
  id: string,
  workspaceId: string,
  update: SavedViewUpdate
): Promise<SavedViewRecord | undefined> {
  const set: Partial<Record<string, string | null>> = {
    updatedAt: new Date().toISOString(),
  };
  if (update.name !== undefined) set.name = update.name;
  if (update.filter !== undefined) set.filter = JSON.stringify(update.filter);
  if (update.search !== undefined) set.search = update.search ?? null;
  if (update.sort !== undefined) {
    set.sort = update.sort ? JSON.stringify(update.sort) : null;
  }
  if (update.columns !== undefined) {
    set.columns = update.columns ? JSON.stringify(update.columns) : null;
  }
  return db
    .update(savedViews)
    .set(set)
    .where(and(eq(savedViews.id, id), eq(savedViews.workspaceId, workspaceId)))
    .returning()
    .get();
}

export function deleteSavedView(
  db: D1Client,
  id: string,
  workspaceId: string
): Promise<SavedViewRecord | undefined> {
  return db
    .delete(savedViews)
    .where(and(eq(savedViews.id, id), eq(savedViews.workspaceId, workspaceId)))
    .returning()
    .get();
}
