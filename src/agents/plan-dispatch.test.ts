import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createTeam } from "../global/teams.js";
import { createWorkspace } from "../global/workspaces.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { MockAgentProvider } from "./harness.js";
import { registerAgentProvider } from "./index.js";
import { triggerPlanMode } from "./plan-dispatch.js";

// PILE-321 — a repo-less issue inherits its team's defaultRepo when a
// comment/label trigger dispatches a plan lane, so the lane works the repo
// instead of producing a spec-only package.

const actor: WorkspaceIdentity = {
  id: "user-plan-dispatch",
  organizationId: "",
  type: "user",
  permissions: ["admin"],
};

let organizationId = "";
let defaultedTeamId = "";
let plainTeamId = "";
const teamRepo = "VortexNYC/plan-default";

beforeAll(async () => {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: actor.id,
      name: "Plan Dispatch User",
      email: "plan-dispatch@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const headers = await createAdminHeaders(env, actor.id);
  const workspace = await createWorkspace(db, env, headers, {
    name: "Plan dispatch tests",
    slug: `plan-dispatch-${crypto.randomUUID()}`,
    ownerId: actor.id,
  });
  organizationId = workspace!.id;
  actor.organizationId = organizationId;
  const defaulted = await createTeam(db, env, new Headers(), {
    organizationId,
    key: "PLN",
    name: "Plan team",
    ownerId: actor.id,
    defaultRepo: teamRepo,
  });
  defaultedTeamId = defaulted.id;
  const plain = await createTeam(db, env, new Headers(), {
    organizationId,
    key: "PLNP",
    name: "Plan team (no repo)",
    ownerId: actor.id,
  });
  plainTeamId = plain.id;
});

const getStub = () =>
  env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );

function registerCapturingProvider(agentId: string) {
  const seen: { repo: string | null | undefined } = { repo: undefined };
  registerAgentProvider(
    agentId,
    () =>
      new MockAgentProvider(agentId, {
        dispatch: (_org, dispatchedIssue) => {
          seen.repo = dispatchedIssue.repo;
          return {
            id: `plan-${crypto.randomUUID()}`,
            agentId,
            issueId: dispatchedIssue.id,
            status: "created" as const,
          };
        },
      })
  );
  return seen;
}

describe("triggerPlanMode", () => {
  it("inherits the team's defaultRepo for a repo-less issue", async () => {
    const db = createD1(env.D1);
    const stub = getStub();
    await stub.setOrganizationId(organizationId);
    const agentId = `mock-plan-${crypto.randomUUID().slice(0, 8)}`;
    const seen = registerCapturingProvider(agentId);

    const issue = await stub.createIssue({
      title: "Plan on a repo-less issue",
      teamId: defaultedTeamId,
    });
    expect(issue.repo).toBeNull();
    // Triggers reuse the issue's latest lane agent — a terminal session
    // pins the mock instead of falling through to the "devin" default.
    await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: actor.id,
      actorType: "user",
      status: "completed",
    });

    const session = await triggerPlanMode(
      env,
      db,
      stub,
      organizationId,
      issue,
      actor,
      { kind: "plan", feedback: null }
    );

    expect(session).not.toBeNull();
    expect(session?.agentId).toBe(agentId);
    expect(seen.repo).toBe(teamRepo);
    // The inherited repo is persisted on the issue.
    expect((await stub.getIssue(issue.id))?.repo).toBe(teamRepo);
  });

  it("stays repo-less when the team has no defaultRepo", async () => {
    const db = createD1(env.D1);
    const stub = getStub();
    await stub.setOrganizationId(organizationId);
    const agentId = `mock-plan-norepo-${crypto.randomUUID().slice(0, 8)}`;
    const seen = registerCapturingProvider(agentId);

    const issue = await stub.createIssue({
      title: "Plan on a deliberately repo-less issue",
      teamId: plainTeamId,
    });
    await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: actor.id,
      actorType: "user",
      status: "completed",
    });

    const session = await triggerPlanMode(
      env,
      db,
      stub,
      organizationId,
      issue,
      actor,
      { kind: "plan", feedback: null }
    );

    expect(session).not.toBeNull();
    expect(seen.repo).toBeNull();
    expect((await stub.getIssue(issue.id))?.repo).toBeNull();
  });
});
