import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { D1Client } from "./db.js";
import {
  apikey,
  member,
  team,
  teamMember,
  user as userTable,
} from "./schema.js";

const teamMetadataSchema = z.object({
  key: z.string(),
  ownerId: z.string(),
  isDefault: z.boolean(),
  isPublic: z.boolean(),
  parentAutoClose: z.boolean(),
  subIssueAutoClose: z.boolean(),
  triageAssigneeId: z.string().nullable().optional(),
  defaultTemplateId: z.string().nullable().optional(),
});

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
  defaultTemplateId: string | null;
  createdAt: string;
  updatedAt: string;
}

function parseTeamMetadata(raw: string | null | undefined) {
  if (!raw) {
    return null;
  }
  const parsed = teamMetadataSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
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
    defaultTemplateId: null,
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
    defaultTemplateId: metadata.defaultTemplateId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function teamMetadataString(values: {
  key: string;
  ownerId: string;
  isDefault: boolean;
  isPublic: boolean;
  parentAutoClose: boolean;
  subIssueAutoClose: boolean;
  triageAssigneeId?: string | null;
  defaultTemplateId?: string | null;
}) {
  return JSON.stringify(values);
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
  defaultTemplateId?: string | null;
}

export async function createTeam(
  db: D1Client,
  values: CreateTeamInput
): Promise<TeamRecord> {
  const id = crypto.randomUUID();
  const metadata = teamMetadataString({
    key: values.key,
    ownerId: values.ownerId,
    isDefault: values.isDefault ?? false,
    isPublic: values.isPublic ?? false,
    parentAutoClose: values.parentAutoClose ?? false,
    subIssueAutoClose: values.subIssueAutoClose ?? false,
    triageAssigneeId: values.triageAssigneeId,
    defaultTemplateId: values.defaultTemplateId,
  });
  await db.insert(team).values({
    id,
    name: values.name,
    organizationId: values.organizationId,
    memberCount: 0,
    metadata,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const row = await getTeamById(db, id, values.organizationId);
  if (!row) {
    throw new Error("Failed to create team");
  }
  return row;
}

export async function createDefaultTeam(
  db: D1Client,
  organizationId: string,
  workspaceKey: string,
  ownerId: string
): Promise<TeamRecord> {
  const record = await createTeam(db, {
    organizationId,
    key: workspaceKey,
    name: "General",
    ownerId,
    isDefault: true,
    isPublic: false,
  });
  await addTeamMember(db, organizationId, record.id, ownerId, "user");
  return record;
}

interface UpdateTeamInput {
  triageAssigneeId?: string | null;
  defaultTemplateId?: string | null;
  key?: string;
  name?: string;
  isPublic?: boolean;
  parentAutoClose?: boolean;
  subIssueAutoClose?: boolean;
}

export async function updateTeam(
  db: D1Client,
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
    triageAssigneeId: input.triageAssigneeId === undefined
      ? existing.triageAssigneeId
      : input.triageAssigneeId,
    defaultTemplateId: input.defaultTemplateId === undefined
      ? existing.defaultTemplateId
      : input.defaultTemplateId,
  });

  await db
    .update(team)
    .set({
      name: input.name ?? existing.name,
      metadata,
      updatedAt: new Date(),
    })
    .where(and(eq(team.id, id), eq(team.organizationId, organizationId)));

  return getTeamById(db, id, organizationId);
}

export async function deleteTeam(
  db: D1Client,
  id: string,
  organizationId: string
): Promise<void> {
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

async function resolveUserId(
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
  organizationId: string,
  teamId: string,
  memberId: string,
  memberType: "user" | "agent" = "user"
): Promise<void> {
  const userId = await resolveUserId(db, memberId, memberType);

  const existingMember = await db
    .select()
    .from(member)
    .where(
      and(eq(member.organizationId, organizationId), eq(member.userId, userId))
    )
    .get();
  if (!existingMember) {
    const user = await db
      .select()
      .from(userTable)
      .where(eq(userTable.id, userId))
      .get();
    if (!user) {
      throw new Error("User not found");
    }
    await db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: organizationId,
      userId,
      role: "member",
      createdAt: new Date(),
    });
  }

  const existingTeamMember = await db
    .select()
    .from(teamMember)
    .where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, userId)))
    .get();
  if (!existingTeamMember) {
    await db.insert(teamMember).values({
      id: crypto.randomUUID(),
      teamId,
      userId,
      createdAt: new Date(),
    });
  }
}

export async function removeTeamMember(
  db: D1Client,
  teamId: string,
  memberId: string,
  memberType: "user" | "agent" = "user"
): Promise<void> {
  const userId = await resolveUserId(db, memberId, memberType);
  await db
    .delete(teamMember)
    .where(and(eq(teamMember.teamId, teamId), eq(teamMember.userId, userId)));
}

export async function listTeamMembers(
  db: D1Client,
  teamId: string
): Promise<{ memberId: string; memberType: "user" | "agent"; role: string }[]> {
  const rows = await db
    .select({
      userId: teamMember.userId,
      userMetadata: userTable.metadata,
    })
    .from(teamMember)
    .where(eq(teamMember.teamId, teamId))
    .leftJoin(userTable, eq(teamMember.userId, userTable.id))
    .all();
  return rows.map((r) => ({
    memberId: r.userId,
    memberType: userTypeFromMetadata(r.userMetadata),
    role: "member",
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
