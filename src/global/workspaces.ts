import { eq } from "drizzle-orm";

import type { D1Client } from "./db.js";
import { workspaces } from "./schema.js";

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
    ownerId: string;
  }
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(workspaces).values({
    id,
    name: values.name,
    slug: values.slug,
    ownerId: values.ownerId,
    createdAt: ts,
    updatedAt: ts,
  });
  return db.select().from(workspaces).where(eq(workspaces.id, id)).get();
}
