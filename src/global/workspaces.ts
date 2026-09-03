import { and, eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { workspaceMemberships, workspaces } from "./schema.js";
import { createDefaultTeam } from "./teams.js";

export function listWorkspaces(db: D1Client) {
  return db.select().from(workspaces).all();
}

export function getWorkspaceBySlug(db: D1Client, slug: string) {
  return db.select().from(workspaces).where(eq(workspaces.slug, slug)).get();
}

export function getWorkspaceById(db: D1Client, id: string) {
  return db.select().from(workspaces).where(eq(workspaces.id, id)).get();
}

export async function createWorkspace(
  db: D1Client,
  values: {
    name: string;
    slug: string;
    key?: string;
    ownerId: string;
  }
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(workspaces).values({
    id,
    name: values.name,
    slug: values.slug,
    key: values.key ?? null,
    ownerId: values.ownerId,
    createdAt: ts,
    updatedAt: ts,
  });
  await db.insert(workspaceMemberships).values({
    id: crypto.randomUUID(),
    workspaceId: id,
    userId: values.ownerId,
    role: "owner",
    createdAt: ts,
  });
  await createDefaultTeam(db, id, values.key ?? null, values.ownerId);
  return db.select().from(workspaces).where(eq(workspaces.id, id)).get();
}

export function getWorkspaceMembership(
  db: D1Client,
  workspaceId: string,
  userId: string
) {
  return db
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId)
      )
    )
    .get();
}
