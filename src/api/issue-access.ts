import { eq } from "drizzle-orm";

import type { createD1 } from "../global/db.js";
import { teamMember } from "../global/schema.js";
import { canAccessTeam } from "../global/teams.js";
import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { Issue, IssueViewer } from "../types/workspace.js";

type WorkspaceDb = ReturnType<typeof createD1>;

// Minimal stub surface — satisfied by the workspace DurableObjectStub.
interface IssueAccessStub {
  issueVisibleTo(
    issueId: string,
    actorId: string,
    teamIds: string[]
  ): Promise<boolean>;
}

// Team memberships covering the identity. `team_member.user_id` holds user
// ids and agent API-key referenceIds alike (see addTeamMember), matching how
// canAccessTeam resolves membership — team grants cover both.
async function grantTeamIds(
  db: WorkspaceDb,
  identity: WorkspaceIdentity
): Promise<string[]> {
  const rows = await db
    .select({ teamId: teamMember.teamId })
    .from(teamMember)
    .where(eq(teamMember.userId, identity.id))
    .all();
  return rows.map((row) => row.teamId);
}

// The list/search viewer for this identity: undefined for admins (they see
// every issue); otherwise the actor plus their Better Auth teams, used to
// exclude restricted issues (issue_permissions) from list, search, and feed
// queries.
export async function issueViewer(
  db: WorkspaceDb,
  identity: WorkspaceIdentity
): Promise<IssueViewer | undefined> {
  if (identity.permissions.includes("admin")) return undefined;
  return { actorId: identity.id, teamIds: await grantTeamIds(db, identity) };
}

// Team access first (existing model), then per-issue grants: when an issue
// has any grant rows it is restricted to listed actors + workspace admins.
// Restricted issues 404 like missing ones — existence must not leak.
export async function assertIssueAccess(
  db: WorkspaceDb,
  stub: IssueAccessStub,
  issue: Issue,
  identity: WorkspaceIdentity
): Promise<void> {
  const allowed = await canAccessTeam(db, issue.teamId, identity);
  const visible =
    allowed &&
    (identity.permissions.includes("admin") ||
      (await stub.issueVisibleTo(
        issue.id,
        identity.id,
        await grantTeamIds(db, identity)
      )));
  if (!visible) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Issue not found",
    });
  }
}
