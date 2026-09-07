import { and, eq, or } from "drizzle-orm";

import type { FilterCondition } from "../workspace/filter.js";
import type { D1Client } from "./db.js";
import { savedViews, userWorkspacePreferences, viewFavorites } from "./schema.js";

export interface SavedViewInput {
  organizationId: string;
  ownerId: string;
  name: string;
  shared?: boolean;
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
  organizationId: string;
  ownerId: string;
  name: string;
  shared: boolean;
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
    organizationId: input.organizationId,
    ownerId: input.ownerId,
    name: input.name,
    shared: input.shared ?? false,
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
  organizationId: string,
  userId?: string
): Promise<SavedViewRecord[]> {
  const condition = userId
    ? and(
        eq(savedViews.organizationId, organizationId),
        or(eq(savedViews.ownerId, userId), eq(savedViews.shared, true))
      )
    : eq(savedViews.organizationId, organizationId);
  return db.select().from(savedViews).where(condition).all();
}

export function getSavedView(
  db: D1Client,
  id: string,
  organizationId: string
): Promise<SavedViewRecord | undefined> {
  return db
    .select()
    .from(savedViews)
    .where(
      and(eq(savedViews.id, id), eq(savedViews.organizationId, organizationId))
    )
    .get();
}

export interface SavedViewUpdate {
  name?: string;
  shared?: boolean;
  filter?: FilterCondition;
  search?: string | null;
  sort?: SavedViewSort | null;
  columns?: string[] | null;
}

export function updateSavedView(
  db: D1Client,
  id: string,
  organizationId: string,
  update: SavedViewUpdate
): Promise<SavedViewRecord | undefined> {
  const set: Partial<Record<string, string | boolean | null>> = {
    updatedAt: new Date().toISOString(),
  };
  if (update.name !== undefined) set.name = update.name;
  if (update.shared !== undefined) set.shared = update.shared;
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
    .where(
      and(eq(savedViews.id, id), eq(savedViews.organizationId, organizationId))
    )
    .returning()
    .get();
}

export function deleteSavedView(
  db: D1Client,
  id: string,
  organizationId: string
): Promise<SavedViewRecord | undefined> {
  return db
    .delete(savedViews)
    .where(
      and(eq(savedViews.id, id), eq(savedViews.organizationId, organizationId))
    )
    .returning()
    .get();
}

export function favoriteView(
  db: D1Client,
  organizationId: string,
  viewId: string,
  userId: string
) {
  return db
    .insert(viewFavorites)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      viewId,
      userId,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: [viewFavorites.viewId, viewFavorites.userId] });
}

export function unfavoriteView(
  db: D1Client,
  viewId: string,
  userId: string
) {
  return db
    .delete(viewFavorites)
    .where(and(eq(viewFavorites.viewId, viewId), eq(viewFavorites.userId, userId)))
    .run();
}

export function listFavoriteViewIds(
  db: D1Client,
  organizationId: string,
  userId: string
): Promise<{ viewId: string }[]> {
  return db
    .select({ viewId: viewFavorites.viewId })
    .from(viewFavorites)
    .where(
      and(
        eq(viewFavorites.organizationId, organizationId),
        eq(viewFavorites.userId, userId)
      )
    )
    .all();
}

export function getUserViewPreferences(
  db: D1Client,
  organizationId: string,
  userId: string
) {
  return db
    .select()
    .from(userWorkspacePreferences)
    .where(
      and(
        eq(userWorkspacePreferences.organizationId, organizationId),
        eq(userWorkspacePreferences.userId, userId)
      )
    )
    .get();
}

export async function setDefaultView(
  db: D1Client,
  organizationId: string,
  userId: string,
  defaultViewId: string | null
) {
  const existing = await getUserViewPreferences(db, organizationId, userId);
  if (existing) {
    await db
      .update(userWorkspacePreferences)
      .set({ defaultViewId, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(userWorkspacePreferences.organizationId, organizationId),
          eq(userWorkspacePreferences.userId, userId)
        )
      );
  } else {
    await db.insert(userWorkspacePreferences).values({
      organizationId,
      userId,
      defaultViewId,
      updatedAt: new Date().toISOString(),
    });
  }
  return getUserViewPreferences(db, organizationId, userId);
}
