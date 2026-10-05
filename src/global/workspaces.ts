import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { createAuth } from "../platform/auth.js";
import type { AppEnv } from "../platform/env.js";
import { DEFAULT_AGENTS_MD } from "./agent-context.js";
import type { D1Client } from "./db.js";
import {
  account,
  member,
  organization,
  ssoProvider,
  workspaceAgentContext,
} from "./schema.js";
import { safeJSON } from "./team-metadata.js";
import { getDefaultTeam } from "./teams.js";
import { createState } from "./workspace-entities.js";

const workspaceMetadataSchema = z
  .object({
    key: z.string().nullable().optional(),
    defaultTeamId: z.string().nullable().optional(),
  })
  .passthrough();

function parseWorkspaceMetadata(metadata: string | null): {
  key: string | null;
  defaultTeamId: string | null;
} {
  if (!metadata) return { key: null, defaultTeamId: null };
  const parsed = workspaceMetadataSchema.safeParse(safeJSON(metadata));
  return parsed.success
    ? {
        key: parsed.data.key ?? null,
        defaultTeamId: parsed.data.defaultTeamId ?? null,
      }
    : { key: null, defaultTeamId: null };
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  key: string | null;
  ownerId: string;
  defaultTeamId: string | null;
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
    // The team's isDefault flag is authoritative; org metadata only mirrors
    // it and is missing on workspaces that predate setDefaultTeam.
    defaultTeamId: (await getDefaultTeam(db, row.id))?.id ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listWorkspacesForUser(db: D1Client, userId: string) {
  const memberships = await db
    .select()
    .from(member)
    .where(eq(member.userId, userId))
    .all();
  const workspaces = await Promise.all(
    memberships.map((row) => getWorkspaceById(db, row.organizationId))
  );
  return workspaces.filter(
    (workspace): workspace is WorkspaceRecord => workspace !== undefined
  );
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
  const auth = await createAuth(env);
  const orgResult = await auth.api.createOrganization({
    body: {
      name: values.name,
      slug: values.slug,
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

  await db
    .insert(workspaceAgentContext)
    .values({ organizationId: orgId, agentsMd: DEFAULT_AGENTS_MD });

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

const ssoEnforcedMetadataSchema = z
  .object({ ssoEnforced: z.boolean().optional() })
  .passthrough();

// Workspace owners may set metadata.ssoEnforced to require that
// session-authenticated members signed in through the workspace's SSO
// provider. Workspace API tokens are machine credentials and bypass it.
export async function isSSOEnforced(
  db: D1Client,
  organizationId: string
): Promise<boolean> {
  const row = await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .get();
  const parsed = ssoEnforcedMetadataSchema.safeParse(
    safeJSON(row?.metadata ?? null)
  );
  return parsed.success && parsed.data.ssoEnforced === true;
}

// SSO sign-ins link an account row keyed by the SSO provider's providerId,
// so membership in the enforced org plus a matching account proves the
// session holder authenticated through the workspace's IdP.
export async function hasSSOAccountForWorkspace(
  db: D1Client,
  organizationId: string,
  userId: string
): Promise<boolean> {
  const providers = await db
    .select({ providerId: ssoProvider.providerId })
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, organizationId));
  if (providers.length === 0) return false;
  const linked = await db
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        inArray(
          account.providerId,
          providers.map((p) => p.providerId)
        )
      )
    )
    .get();
  return !!linked;
}
