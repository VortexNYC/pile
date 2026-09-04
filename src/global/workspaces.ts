import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { createAuth } from "../platform/auth.js";
import type { AppEnv } from "../platform/env.js";
import type { D1Client } from "./db.js";
import {
  member,
  organization,
  team as teamTable,
  teamMember as teamMemberTable,
  workspaceMemberships,
  workspaces,
} from "./schema.js";
import { createDefaultTeam } from "./teams.js";

const workspaceMetadataSchema = z
  .object({
    key: z.string().nullable().optional(),
    defaultTeamId: z.string().nullable().optional(),
  })
  .passthrough();

function parseWorkspaceMetadata(metadata: string | null) {
  if (!metadata)
    return { key: null as string | null, defaultTeamId: null as string | null };
  const parsed = workspaceMetadataSchema.parse(JSON.parse(metadata));
  return {
    key: parsed.key ?? null,
    defaultTeamId: parsed.defaultTeamId ?? null,
  };
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  key: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

async function buildWorkspace(
  db: D1Client,
  row: typeof organization.$inferSelect
): Promise<WorkspaceRecord> {
  const owner = await db
    .select()
    .from(member)
    .where(and(eq(member.organizationId, row.id), eq(member.role, "owner")))
    .get();
  const meta = parseWorkspaceMetadata(row.metadata);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    key: meta.key,
    ownerId: owner?.userId ?? "",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function listWorkspaces(db: D1Client) {
  return db.select().from(workspaces).all() as unknown as WorkspaceRecord[];
}

export async function getWorkspaceBySlug(
  db: D1Client,
  slug: string
): Promise<WorkspaceRecord | undefined> {
  const row = await db
    .select()
    .from(organization)
    .where(eq(organization.slug, slug))
    .get();
  if (!row) return undefined;
  return buildWorkspace(db, row);
}

export async function getWorkspaceById(
  db: D1Client,
  id: string
): Promise<WorkspaceRecord | undefined> {
  const row = await db
    .select()
    .from(organization)
    .where(eq(organization.id, id))
    .get();
  if (!row) return undefined;
  return buildWorkspace(db, row);
}

export async function createWorkspace(
  db: D1Client,
  env: AppEnv,
  values: {
    name: string;
    slug: string;
    key?: string;
    ownerId: string;
  }
): Promise<WorkspaceRecord> {
  const auth = createAuth(env);
  const orgResult = await auth.api.createOrganization({
    body: {
      name: values.name,
      slug: values.slug,
      userId: values.ownerId,
      metadata: { key: values.key ?? null },
    },
  });
  const orgId = z.object({ id: z.string() }).parse(orgResult).id;
  const workspaceKey = values.key ?? null;
  const now = new Date();
  const iso = now.toISOString();

  await db.insert(workspaces).values({
    id: orgId,
    name: values.name,
    slug: values.slug,
    key: workspaceKey,
    ownerId: values.ownerId,
    createdAt: iso,
    updatedAt: iso,
  });
  await db.insert(workspaceMemberships).values({
    id: crypto.randomUUID(),
    workspaceId: orgId,
    userId: values.ownerId,
    role: "owner",
    createdAt: iso,
  });

  const oldTeam = await createDefaultTeam(
    db,
    orgId,
    workspaceKey,
    values.ownerId
  );
  const teamId = oldTeam.id;

  await db.insert(teamTable).values({
    id: teamId,
    name: "General",
    memberCount: 1,
    organizationId: orgId,
    metadata: JSON.stringify({ key: workspaceKey, isDefault: true }),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(teamMemberTable).values({
    id: crypto.randomUUID(),
    teamId,
    userId: values.ownerId,
    createdAt: now,
  });

  await db
    .update(organization)
    .set({
      metadata: JSON.stringify({ key: workspaceKey, defaultTeamId: teamId }),
      updatedAt: now,
    })
    .where(eq(organization.id, orgId));

  const row = await db
    .select()
    .from(organization)
    .where(eq(organization.id, orgId))
    .get();
  if (!row) throw new Error("Organization not found after creation");
  return buildWorkspace(db, row);
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
