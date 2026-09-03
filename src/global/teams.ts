import { and, eq } from "drizzle-orm";

import type { WorkspaceIdentity } from "../platform/identity.js";
import type { D1Client } from "./db.js";
import { teams, teamMemberships } from "./schema.js";

export interface TeamInput {
  workspaceId: string;
  key: string;
  name: string;
  ownerId: string;
  isPublic?: boolean;
}

export interface TeamRecord {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  ownerId: string;
  isDefault: boolean;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TeamUpdate {
  key?: string;
  name?: string;
  isPublic?: boolean;
}

export async function createTeam(
  db: D1Client,
  input: TeamInput,
  options: { isDefault?: boolean } = {}
): Promise<TeamRecord> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(teams).values({
    id,
    workspaceId: input.workspaceId,
    key: input.key,
    name: input.name,
    ownerId: input.ownerId,
    isDefault: options.isDefault ?? false,
    isPublic: input.isPublic ?? false,
    createdAt: now,
    updatedAt: now,
  });
  const row = await db.select().from(teams).where(eq(teams.id, id)).get();
  return row as TeamRecord;
}

export async function createDefaultTeam(
  db: D1Client,
  workspaceId: string,
  workspaceKey: string | null,
  ownerId: string
): Promise<TeamRecord> {
  const existing = await db
    .select()
    .from(teams)
    .where(and(eq(teams.workspaceId, workspaceId), eq(teams.isDefault, true)))
    .get();
  if (existing) return existing as TeamRecord;

  const record = await createTeam(
    db,
    {
      workspaceId,
      key: workspaceKey ?? "general",
      name: "General",
      ownerId,
      isPublic: true,
    },
    { isDefault: true }
  );
  await addTeamMember(db, workspaceId, record.id, ownerId, "user");
  return record;
}

export async function getTeamById(
  db: D1Client,
  id: string,
  workspaceId: string
): Promise<TeamRecord | undefined> {
  const row = await db
    .select()
    .from(teams)
    .where(and(eq(teams.id, id), eq(teams.workspaceId, workspaceId)))
    .get();
  return row as TeamRecord | undefined;
}

export async function getDefaultTeam(
  db: D1Client,
  workspaceId: string
): Promise<TeamRecord | undefined> {
  const row = await db
    .select()
    .from(teams)
    .where(and(eq(teams.workspaceId, workspaceId), eq(teams.isDefault, true)))
    .get();
  return row as TeamRecord | undefined;
}

export async function listTeams(
  db: D1Client,
  workspaceId: string
): Promise<TeamRecord[]> {
  const rows = await db
    .select()
    .from(teams)
    .where(eq(teams.workspaceId, workspaceId))
    .all();
  return rows as TeamRecord[];
}

export async function updateTeam(
  db: D1Client,
  id: string,
  workspaceId: string,
  update: TeamUpdate
): Promise<TeamRecord | undefined> {
  const set: Partial<Record<string, string | boolean | null>> = {
    updatedAt: new Date().toISOString(),
  };
  if (update.key !== undefined) set.key = update.key;
  if (update.name !== undefined) set.name = update.name;
  if (update.isPublic !== undefined) set.isPublic = update.isPublic;
  const row = await db
    .update(teams)
    .set(set)
    .where(and(eq(teams.id, id), eq(teams.workspaceId, workspaceId)))
    .returning()
    .get();
  return row as TeamRecord | undefined;
}

export async function deleteTeam(
  db: D1Client,
  id: string,
  workspaceId: string
): Promise<TeamRecord | undefined> {
  const row = await db
    .delete(teams)
    .where(and(eq(teams.id, id), eq(teams.workspaceId, workspaceId)))
    .returning()
    .get();
  return row as TeamRecord | undefined;
}

export async function addTeamMember(
  db: D1Client,
  workspaceId: string,
  teamId: string,
  memberId: string,
  memberType: "user" | "agent",
  role: "member" | "guest" = "member"
): Promise<void> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db
    .insert(teamMemberships)
    .values({
      id,
      workspaceId,
      teamId,
      memberId,
      memberType,
      role,
      createdAt: now,
    })
    .onConflictDoNothing();
}

export async function removeTeamMember(
  db: D1Client,
  teamId: string,
  memberId: string,
  memberType: "user" | "agent"
): Promise<void> {
  await db
    .delete(teamMemberships)
    .where(
      and(
        eq(teamMemberships.teamId, teamId),
        eq(teamMemberships.memberId, memberId),
        eq(teamMemberships.memberType, memberType)
      )
    );
}

export async function listTeamMembers(
  db: D1Client,
  teamId: string
): Promise<{ memberId: string; memberType: "user" | "agent"; role: string }[]> {
  const rows = await db
    .select({
      memberId: teamMemberships.memberId,
      memberType: teamMemberships.memberType,
      role: teamMemberships.role,
    })
    .from(teamMemberships)
    .where(eq(teamMemberships.teamId, teamId))
    .all();
  return rows as {
    memberId: string;
    memberType: "user" | "agent";
    role: string;
  }[];
}

export async function getVisibleTeamIds(
  db: D1Client,
  workspaceId: string,
  identity: WorkspaceIdentity
): Promise<string[]> {
  const memberRows = await db
    .select({ teamId: teamMemberships.teamId })
    .from(teamMemberships)
    .where(
      and(
        eq(teamMemberships.workspaceId, workspaceId),
        eq(teamMemberships.memberId, identity.id),
        eq(teamMemberships.memberType, identity.type)
      )
    )
    .all();
  const memberTeamIds = new Set(memberRows.map((r) => r.teamId));

  if (identity.permissions.includes("admin")) {
    const allTeams = await db
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.workspaceId, workspaceId))
      .all();
    for (const t of allTeams) memberTeamIds.add(t.id);
    return [...memberTeamIds];
  }

  const publicRows = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.workspaceId, workspaceId), eq(teams.isPublic, true)))
    .all();
  for (const t of publicRows) memberTeamIds.add(t.id);
  return [...memberTeamIds];
}

export async function isTeamMember(
  db: D1Client,
  teamId: string,
  identity: WorkspaceIdentity
): Promise<boolean> {
  const row = await db
    .select({ id: teamMemberships.id })
    .from(teamMemberships)
    .where(
      and(
        eq(teamMemberships.teamId, teamId),
        eq(teamMemberships.memberId, identity.id),
        eq(teamMemberships.memberType, identity.type)
      )
    )
    .get();
  return !!row;
}

export async function canAccessTeam(
  db: D1Client,
  teamId: string,
  identity: WorkspaceIdentity
): Promise<boolean> {
  const team = await db
    .select({ isPublic: teams.isPublic, workspaceId: teams.workspaceId })
    .from(teams)
    .where(eq(teams.id, teamId))
    .get();
  if (!team) return false;
  if (identity.permissions.includes("admin")) return true;
  if (team.isPublic) return true;
  return isTeamMember(db, teamId, identity);
}
