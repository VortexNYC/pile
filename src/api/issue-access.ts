import { eq } from "drizzle-orm";
import type { Context } from "hono";

import { createD1 } from "../global/db.js";
import { teamMember } from "../global/schema.js";
import { canAccessTeam } from "../global/teams.js";
import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { AppContext } from "../platform/middleware.js";
import type { Issue, IssueViewer } from "../types/workspace.js";

type WorkspaceDb = ReturnType<typeof createD1>;

// Minimal stub surface — satisfied by the workspace DurableObjectStub.
interface IssueAccessStub {
  getIssue(ref: string): Promise<Issue | null | undefined>;
  issueVisibleTo(
    issueId: string,
    actorId: string,
    teamIds: string[]
  ): Promise<boolean>;
  hiddenIssueIdsFor(viewer?: IssueViewer): Promise<string[]>;
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

// Resolve an `issueId` input (uuid or ISS-N) on another resource to the
// canonical issue id. Both unresolvable and restricted refs 404 — a
// status-code difference would leak restricted-issue existence.
export async function resolveVisibleIssueRef(
  db: WorkspaceDb,
  stub: IssueAccessStub,
  ref: string,
  identity: WorkspaceIdentity
): Promise<string> {
  const issue = await stub.getIssue(ref);
  if (!issue) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Issue not found",
    });
  }
  await assertIssueAccess(db, stub, issue, identity);
  return issue.id;
}

// Restricted issue ids the identity cannot see — for scrubbing `issueId`
// fields out of responses on secondary resources (needs, automations, mcp
// servers, changelog links, support traces). Admins get an empty set.
export async function hiddenIssueIdsForIdentity(
  db: WorkspaceDb,
  stub: IssueAccessStub,
  identity: WorkspaceIdentity | undefined
): Promise<string[]> {
  const viewer = identity
    ? await issueViewer(db, identity)
    : { actorId: "", teamIds: [] };
  return stub.hiddenIssueIdsFor(viewer);
}

// Clone a websocket upgrade request with the caller's issue-grant viewer
// stamped on `x-pile-ws-viewer`, so the DO filters issue-bearing events per
// socket (issue_permissions). Every upgrade route must go through this — a
// missing header is treated by the DO as a non-admin nobody, never as
// unfiltered. issueViewer returns undefined only for admin identities.
export async function wsViewerStampedRequest(
  c: Context<AppContext>
): Promise<Request> {
  const identity = c.get("workspaceIdentity");
  const viewer = identity
    ? await issueViewer(createD1(c.env.D1), identity)
    : { actorId: "", teamIds: [] };
  const forwarded = new Request(c.req.raw);
  forwarded.headers.set(
    "x-pile-ws-viewer",
    JSON.stringify({
      actorId: viewer?.actorId ?? "",
      teamIds: viewer?.teamIds ?? [],
      admin: identity !== undefined && viewer === undefined,
    })
  );
  return forwarded;
}
