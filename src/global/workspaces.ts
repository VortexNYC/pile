import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { createAuth } from "../platform/auth.js";
import type { AppEnv } from "../platform/env.js";
import type { D1Client } from "./db.js";
import { member, organization } from "./schema.js";
import { createState } from "./workspace-entities.js";

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

export async function listWorkspaces(db: D1Client) {
  const rows = await db.select().from(organization).all();
  return Promise.all(rows.map((row) => buildWorkspace(db, row)));
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
  headers: Headers,
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
    headers,
  });
  const orgId = z.object({ id: z.string() }).parse(orgResult).id;

  const defaultStates = [
    { linearId: "backlog", name: "Backlog", type: "backlog" },
    { linearId: "todo", name: "Todo", type: "unstarted" },
    { linearId: "in-progress", name: "In Progress", type: "started" },
    { linearId: "in-review", name: "In Review", type: "started" },
    { linearId: "done", name: "Done", type: "completed" },
    { linearId: "canceled", name: "Canceled", type: "canceled" },
  ];
  await Promise.all(
    defaultStates.map((state) => createState(db, orgId, state))
  );

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
  organizationId: string,
  userId: string
) {
  return db
    .select()
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId))
    )
    .get();
}
