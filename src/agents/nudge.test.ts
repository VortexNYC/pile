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
import { nudgeLane } from "./nudge.js";

// PILE-321 — a completed lane whose follow-up can't be delivered is
// cold-redispatched; that dispatch inherits the team's defaultRepo so the
// replacement lane clones a repo instead of producing a spec-only package.

const actor: WorkspaceIdentity = {
  id: "user-nudge",
  organizationId: "",
  type: "user",
  permissions: ["admin"],
};

let defaultedTeamId = "";
const teamRepo = "VortexNYC/nudge-default";

beforeAll(async () => {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: actor.id,
      name: "Nudge User",
      email: "nudge-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const headers = await createAdminHeaders(env, actor.id);
  const workspace = await createWorkspace(db, env, headers, {
    name: "Nudge tests",
    slug: `nudge-${crypto.randomUUID()}`,
    ownerId: actor.id,
  });
  actor.organizationId = workspace!.id;
  const defaulted = await createTeam(db, env, new Headers(), {
    organizationId: actor.organizationId,
    key: "NDG",
    name: "Nudge team",
    ownerId: actor.id,
    defaultRepo: teamRepo,
  });
  defaultedTeamId = defaulted.id;
});

const getStub = () =>
  env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
  );

function registerCapturingProvider(agentId: string) {
  const seen: { repo: string | null | undefined } = { repo: undefined };
  registerAgentProvider(
    agentId,
    () =>
      new MockAgentProvider(agentId, {
        // sendPrompt rejects (the kept sandbox is gone), so the nudge
        // falls through to a cold redispatch.
        sendPrompt: () => false,
        dispatch: (_org, dispatchedIssue) => {
          seen.repo = dispatchedIssue.repo;
          return {
            id: `nudge-${crypto.randomUUID()}`,
            agentId,
            issueId: dispatchedIssue.id,
            status: "created" as const,
          };
        },
      })
  );
  return seen;
}

describe("nudgeLane redispatch (PILE-321)", () => {
  it("inherits the team's defaultRepo when redispatching a repo-less issue", async () => {
    const stub = getStub();
    await stub.setOrganizationId(actor.organizationId);
    const agentId = `mock-nudge-${crypto.randomUUID().slice(0, 8)}`;
    const seen = registerCapturingProvider(agentId);

    const issue = await stub.createIssue({
      title: "Repo-less lane",
      teamId: defaultedTeamId,
    });
    expect(issue.repo).toBeNull();
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: actor.id,
      actorType: "user",
      status: "completed",
    });

    await nudgeLane(
      env,
      stub,
      actor.organizationId,
      session,
      issue,
      "https://github.com/VortexNYC/nudge-default/pull/1",
      { prompt: "CI is red", reason: "CI failed" }
    );

    expect(seen.repo).toBe(teamRepo);
    // Persisted — the lane token and later redispatches read issue.repo.
    expect((await stub.getIssue(issue.id))?.repo).toBe(teamRepo);
    const events = await stub.listAgentSessionEvents(session.id, {
      limit: 50,
      order: "desc",
    });
    expect(events.some((e) => e.type === "prompt.redispatch")).toBe(true);
  });

  it("keeps the issue's own repo on redispatch", async () => {
    const stub = getStub();
    await stub.setOrganizationId(actor.organizationId);
    const agentId = `mock-nudge-own-${crypto.randomUUID().slice(0, 8)}`;
    const seen = registerCapturingProvider(agentId);

    const issue = await stub.createIssue({
      title: "Own repo lane",
      teamId: defaultedTeamId,
      repo: "VortexNYC/own-repo",
    });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: actor.id,
      actorType: "user",
      status: "completed",
    });

    await nudgeLane(
      env,
      stub,
      actor.organizationId,
      session,
      issue,
      "https://github.com/VortexNYC/own-repo/pull/2",
      { prompt: "CI is red", reason: "CI failed" }
    );

    expect(seen.repo).toBe("VortexNYC/own-repo");
    expect((await stub.getIssue(issue.id))?.repo).toBe("VortexNYC/own-repo");
  });
});
