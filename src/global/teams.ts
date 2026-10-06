import { and, count, eq, ne, sql } from "drizzle-orm";

import type { AppEnv } from "../platform/env.js";
import type { D1Client } from "./db.js";
import {
  apikey,
  organization,
  team,
  teamMember,
  user as userTable,
} from "./schema.js";
import { parseTeamMetadata, teamMetadataString } from "./team-metadata.js";

export interface TeamRecord {
  id: string;
  organizationId: string;
  key: string;
  name: string;
  ownerId: string;
  isDefault: boolean;
  isPublic: boolean;
  parentAutoClose: boolean;
  subIssueAutoClose: boolean;
  triageAssigneeId: string | null;
  /** Agent provider that runs the triage lane on every new issue (PILE-282). */
  triageAgentId: string | null;
  defaultTemplateId: string | null;
  defaultRepo: string | null;
  createdAt: string;
  updatedAt: string;
}

function teamRecordFromRow(row: typeof team.$inferSelect): TeamRecord {
  const metadata = parseTeamMetadata(row.metadata) ?? {
    key: "general",
    ownerId: "",
    isDefault: false,
    isPublic: false,
    parentAutoClose: false,
    subIssueAutoClose: false,
    triageAssigneeId: null,
    triageAgentId: null,
    defaultTemplateId: null,
    defaultRepo: null,
  };
  return {
    id: row.id,
    organizationId: row.organizationId,
    key: metadata.key,
    name: row.name,
    ownerId: metadata.ownerId,
    isDefault: metadata.isDefault,
    isPublic: metadata.isPublic,
    parentAutoClose: metadata.parentAutoClose,
    subIssueAutoClose: metadata.subIssueAutoClose,
    triageAssigneeId: metadata.triageAssigneeId ?? null,
    triageAgentId: metadata.triageAgentId ?? null,
    defaultTemplateId: metadata.defaultTemplateId ?? null,
    defaultRepo: metadata.defaultRepo ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getTeamById(
  db: D1Client,
  id: string,
  organizationId?: string
): Promise<TeamRecord | undefined> {
  const row = await db
    .select()
    .from(team)
    .where(
      organizationId
        ? and(eq(team.id, id), eq(team.organizationId, organizationId))
        : eq(team.id, id)
    )
    .get();
  if (!row) return undefined;
  return teamRecordFromRow(row);
}

export async function getDefaultTeam(
  db: D1Client,
  organizationId: string
): Promise<TeamRecord | undefined> {
  const rows = await db
    .select()
    .from(team)
    .where(eq(team.organizationId, organizationId))
    .all();
  for (const row of rows) {
    const metadata = parseTeamMetadata(row.metadata);
    if (metadata?.isDefault) {
      return teamRecordFromRow(row);
    }
  }
  return undefined;
}

// Flips `isDefault` across every team in the workspace and mirrors the
// choice into the organization's `defaultTeamId` metadata. Both writes run as
// one D1 batch and patch the JSON in place, so concurrent team edits to other
// metadata fields are not clobbered.
export async function setDefaultTeam(
  db: D1Client,
  organizationId: string,
  teamId: string
): Promise<TeamRecord | undefined> {
  const row = await db
    .select()
    .from(team)
    .where(and(eq(team.id, teamId), eq(team.organizationId, organizationId)))
    .get();
  if (!row) return undefined;
  const now = new Date();
  // A target with missing/invalid metadata would be skipped by the json_set
  // pass, so rewrite it whole from its parsed (defaulted) record instead.
  const targetMetadata = parseTeamMetadata(row.metadata)
    ? sql`json_set(${team.metadata}, '$.isDefault', json('true'))`
    : teamMetadataString({ ...teamRecordFromRow(row), isDefault: true });
  await db.batch([
    db
      .update(team)
      .set({ metadata: targetMetadata, updatedAt: now })
      .where(and(eq(team.id, teamId), eq(team.organizationId, organizationId))),
    db
      .update(team)
      .set({
        metadata: sql`json_set(${team.metadata}, '$.isDefault', json('false'))`,
        updatedAt: now,
      })
      .where(
        and(
          eq(team.organizationId, organizationId),
          ne(team.id, teamId),
          sql`json_valid(${team.metadata})`,
          sql`json_extract(${team.metadata}, '$.isDefault') = 1`
        )
      ),
    db
      .update(organization)
      .set({
        // The subquery keeps the mirror honest if the target is deleted in
        // the check-then-batch window: org metadata gets NULL, not a
        // dangling team id. getDefaultTeam remains the source of truth.
        metadata: sql`json_set(CASE WHEN json_valid(${organization.metadata}) THEN ${organization.metadata} ELSE '{}' END, '$.defaultTeamId', (SELECT id FROM team WHERE id = ${teamId} AND organization_id = ${organizationId}))`,
        updatedAt: now,
      })
      .where(eq(organization.id, organizationId)),
  ]);
  return getTeamById(db, teamId, organizationId);
}

export async function listTeams(
  db: D1Client,
  organizationId: string
): Promise<TeamRecord[]> {
  const rows = await db
    .select()
    .from(team)
    .where(eq(team.organizationId, organizationId))
    .all();
  return rows.map(teamRecordFromRow);
}

interface CreateTeamInput {
  organizationId: string;
  key: string;
  name: string;
  ownerId: string;
  isDefault?: boolean;
  isPublic?: boolean;
  parentAutoClose?: boolean;
  subIssueAutoClose?: boolean;
  triageAssigneeId?: string | null;
  triageAgentId?: string | null;
  defaultTemplateId?: string | null;
  defaultRepo?: string | null;
}

export async function createTeam(
  db: D1Client,
  _env: AppEnv,
  _headers: Headers,
  values: CreateTeamInput
): Promise<TeamRecord> {
  const metadata = teamMetadataString({
    key: values.key,
    ownerId: values.ownerId,
    isDefault: values.isDefault ?? false,
    isPublic: values.isPublic ?? false,
    parentAutoClose: values.parentAutoClose ?? false,
    subIssueAutoClose: values.subIssueAutoClose ?? false,
    triageAssigneeId: values.triageAssigneeId,
    triageAgentId: values.triageAgentId,
    defaultTemplateId: values.defaultTemplateId,
    defaultRepo: values.defaultRepo,
  });
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(team).values({
    id,
    name: values.name,
    organizationId: values.organizationId,
    memberCount: 0,
    metadata,
    createdAt: now,
    updatedAt: now,
  });
  const row = await getTeamById(db, id, values.organizationId);
  if (!row) {
    throw new Error("Failed to create team");
  }
  return row;
}

export async function createDefaultTeam(
  db: D1Client,
  env: AppEnv,
  headers: Headers,
  organizationId: string,
  workspaceKey: string,
  ownerId: string
): Promise<TeamRecord> {
  const record = await createTeam(db, env, headers, {
    organizationId,
    key: workspaceKey,
    name: "General",
    ownerId,
    isDefault: true,
    isPublic: false,
  });
  await addTeamMember(
    db,
    env,
    headers,
    organizationId,
    record.id,
    ownerId,
    "user"
  );
  return record;
}

interface UpdateTeamInput {
  triageAssigneeId?: string | null;
  triageAgentId?: string | null;
  defaultTemplateId?: string | null;
  defaultRepo?: string | null;
  key?: string;
  name?: string;
  isPublic?: boolean;
  parentAutoClose?: boolean;
  subIssueAutoClose?: boolean;
}

export async function updateTeam(
  db: D1Client,
  _env: AppEnv,
  _headers: Headers,
  id: string,
  organizationId: string,
  input: UpdateTeamInput
): Promise<TeamRecord | undefined> {
  const existing = await getTeamById(db, id, organizationId);
  if (!existing) return undefined;

  const metadata = teamMetadataString({
    key: input.key ?? existing.key,
    ownerId: existing.ownerId,
    isDefault: existing.isDefault,
    isPublic: input.isPublic ?? existing.isPublic,
    parentAutoClose: input.parentAutoClose ?? existing.parentAutoClose,
    subIssueAutoClose: input.subIssueAutoClose ?? existing.subIssueAutoClose,
    triageAssigneeId:
      input.triageAssigneeId === undefined
        ? existing.triageAssigneeId
        : input.triageAssigneeId,
    triageAgentId:
      input.triageAgentId === undefined
        ? existing.triageAgentId
        : input.triageAgentId,
    defaultTemplateId:
      input.defaultTemplateId === undefined
        ? existing.defaultTemplateId
        : input.defaultTemplateId,
    defaultRepo:
      input.defaultRepo === undefined
        ? existing.defaultRepo
        : input.defaultRepo,
  });

  await db
    .update(team)
    .set({
      name: input.name ?? existing.name,
      metadata,
    })
    .where(and(eq(team.id, id), eq(team.organizationId, organizationId)));

  return getTeamById(db, id, organizationId);
}

export async function deleteTeam(
  db: D1Client,
  _env: AppEnv,
  _headers: Headers,
  id: string,
  organizationId: string
): Promise<void> {
  await db.delete(teamMember).where(eq(teamMember.teamId, id));
  await db
    .delete(team)
    .where(and(eq(team.id, id), eq(team.organizationId, organizationId)));
}

function userTypeFromMetadata(
  raw: string | null | undefined
): "user" | "agent" {
  if (!raw) return "user";
  try {
    const parsed = JSON.parse(raw);
    return parsed?.type === "agent" ? "agent" : "user";
  } catch {
    return "user";
  }
}

export async function resolveUserId(
  db: D1Client,
  memberId: string,
  memberType: "user" | "agent"
): Promise<string> {
  if (memberType === "user") {
    return memberId;
  }
  const key = await db
    .select()
    .from(apikey)
    .where(eq(apikey.id, memberId))
    .get();
  if (!key) {
    throw new Error("Token not found");
  }
  return key.referenceId;
}

export async function addTeamMember(
  db: D1Client,
  _env: AppEnv,
  _headers: Headers,
  _organizationId: string,
  teamId: string,
  memberId: string,
  memberType: "user" | "agent" = "user",
  role = "member"
): Promise<void> {
  const userId = await resolveUserId(db, memberId, memberType);
  await db.insert(teamMember).values({
    id: crypto.randomUUID(),
    teamId,
    userId,
    role,
    createdAt: new Date(),
  });
  const countResult = await db
    .select({ count: count() })
    .from(teamMember)
    .where(eq(teamMember.teamId, teamId))
    .get();
  await db
    .update(team)
    .set({ memberCount: Number(countResult?.count ?? 0) })
    .where(eq(team.id, teamId));
}

export async function removeTeamMember(
  db: D1Client,
  _env: AppEnv,
  _headers: Headers,
  _organizationId: string,
  teamId: string,
  memberId: string,
  memberType: "user" | "agent" = "user"
): Promise<void> {
  const userId = await resolveUserId(db, memberId, memberType);
  await db
    .delete(teamMember)
    .where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, userId)));
  const countResult = await db
    .select({ count: count() })
    .from(teamMember)
    .where(eq(teamMember.teamId, teamId))
    .get();
  await db
    .update(team)
    .set({ memberCount: Number(countResult?.count ?? 0) })
    .where(eq(team.id, teamId));
}

export async function listTeamMembers(
  db: D1Client,
  teamId: string
): Promise<{ memberId: string; memberType: "user" | "agent"; role: string }[]> {
  const rows = await db
    .select({
      userId: teamMember.userId,
      role: teamMember.role,
      userMetadata: userTable.metadata,
    })
    .from(teamMember)
    .where(eq(teamMember.teamId, teamId))
    .leftJoin(userTable, eq(teamMember.userId, userTable.id))
    .all();
  return rows.map((r) => ({
    memberId: r.userId,
    memberType: userTypeFromMetadata(r.userMetadata),
    role: r.role,
  }));
}

export async function isTeamMember(
  db: D1Client,
  teamId: string,
  userId: string
): Promise<boolean> {
  const row = await db
    .select()
    .from(teamMember)
    .where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, userId)))
    .get();
  return !!row;
}

export async function canAccessTeam(
  db: D1Client,
  teamId: string,
  identity: { id: string; permissions: string[] }
): Promise<boolean> {
  const record = await getTeamById(db, teamId);
  if (!record) return false;
  if (record.isPublic) return true;
  if (identity.permissions.includes("admin")) return true;
  return isTeamMember(db, record.id, identity.id);
}

export async function getVisibleTeamIds(
  db: D1Client,
  organizationId: string,
  identity: { id: string; permissions: string[] }
): Promise<string[]> {
  const teamRows = await db
    .select()
    .from(team)
    .where(eq(team.organizationId, organizationId))
    .all();

  const memberTeamIds = new Set(
    (
      await db
        .select({ teamId: teamMember.teamId })
        .from(teamMember)
        .where(eq(teamMember.userId, identity.id))
        .all()
    ).map((r) => r.teamId)
  );

  const isAdmin = identity.permissions.includes("admin");
  const visible: string[] = [];
  for (const row of teamRows) {
    const metadata = parseTeamMetadata(row.metadata);
    if (isAdmin || metadata?.isPublic || memberTeamIds.has(row.id)) {
      visible.push(row.id);
    }
  }
  return visible;
}

// Better Auth's organization plugin does not expose a team-member role update
// endpoint, so this is the only remaining direct write to `teamMember` and is
// only called after `addTeamMember` when the requested role is not "member".
export async function updateTeamMemberRole(
  db: D1Client,
  teamId: string,
  userId: string,
  role: string
) {
  await db
    .update(teamMember)
    .set({ role })
    .where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, userId)));
}

export async function listUserTeams(
  db: D1Client,
  organizationId: string,
  userId: string
): Promise<TeamRecord[]> {
  const rows = await db
    .select({
      team: team,
    })
    .from(team)
    .where(eq(team.organizationId, organizationId))
    .innerJoin(
      teamMember,
      and(eq(team.id, teamMember.teamId), eq(teamMember.userId, userId))
    )
    .all();
  return rows.map((r) => teamRecordFromRow(r.team));
}
