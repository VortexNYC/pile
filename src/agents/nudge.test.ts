import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createTeam } from "../global/teams.js";
import { createWorkspace } from "../global/workspaces.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { ComputeError } from "./compute.js";
import { MockAgentProvider } from "./harness.js";
import { registerAgentProvider } from "./index.js";
import {
  MAX_LANE_REDISPATCHES,
  nudgeLane,
  redispatchBackoffMs,
} from "./nudge.js";

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

function registerFailingProvider(agentId: string, error: Error) {
  let calls = 0;
  registerAgentProvider(
    agentId,
    () =>
      new MockAgentProvider(agentId, {
        sendPrompt: () => false,
        dispatch: () => {
          calls += 1;
          throw error;
        },
      })
  );
  return () => calls;
}

async function completedLane(
  stub: ReturnType<typeof getStub>,
  agentId: string,
  issueId: string
) {
  return stub.createAgentSession({
    issueId,
    agentId,
    provider: agentId,
    actorId: actor.id,
    actorType: "user",
    status: "completed",
  });
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

  // PILE-423 — a cold redispatch keeps the dead lane's stepKey so the same
  // step-scoped guidance packs resolve on the replacement lane.
  it("carries the dead lane's stepKey onto the redispatch", async () => {
    const stub = getStub();
    await stub.setOrganizationId(actor.organizationId);
    const agentId = `mock-nudge-step-${crypto.randomUUID().slice(0, 8)}`;
    registerCapturingProvider(agentId);

    const issue = await stub.createIssue({
      title: "Step-scoped lane",
      teamId: defaultedTeamId,
    });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: actor.id,
      actorType: "user",
      status: "completed",
      stepKey: "contacted",
    });

    await nudgeLane(
      env,
      stub,
      actor.organizationId,
      session,
      issue,
      "https://github.com/VortexNYC/nudge-default/pull/3",
      { prompt: "CI is red", reason: "CI failed" }
    );

    const sessions = await stub.listAgentSessions({ issueId: issue.id });
    const redispatch = sessions.find((s) => s.id !== session.id);
    expect(redispatch?.stepKey).toBe("contacted");
  });

  it("a delivered follow-up revives a completed lane to running", async () => {
    const stub = getStub();
    await stub.setOrganizationId(actor.organizationId);
    const agentId = `mock-live-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(
      agentId,
      () => new MockAgentProvider(agentId, { sendPrompt: () => true })
    );

    const issue = await stub.createIssue({
      title: "Completed lane follow-up",
      teamId: defaultedTeamId,
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
      "https://github.com/VortexNYC/nudge-default/pull/4",
      { prompt: "CI is red", reason: "CI failed" }
    );

    expect((await stub.getAgentSession(session.id))?.status).toBe("running");
    const events = await stub.listAgentSessionEvents(session.id, {
      limit: 50,
      order: "desc",
    });
    expect(events.some((e) => e.type === "prompt.followup")).toBe(true);
  });
});

// PILE-452 — the redispatch loop that burned the fleet: Daytona start
// failures were invisible (no parent link, infraFailure=0) and the sweep
// re-failed every pass with no cap, no backoff, and no pause/fleet gate.
describe("nudgeLane redispatch gating (PILE-452)", () => {
  const prUrl = "https://github.com/VortexNYC/nudge-default/pull/452";

  it("links the failed child and records the attempt when dispatch dies on the substrate", async () => {
    const stub = getStub();
    const agentId = `mock-rd-fail-${crypto.randomUUID().slice(0, 8)}`;
    registerFailingProvider(
      agentId,
      new ComputeError({
        code: "AGENT_ERROR",
        status: 502,
        message:
          "Daytona sandbox create failed: 400 sandbox exited with code 1 before becoming ready",
      })
    );
    const issue = await stub.createIssue({ title: "Daytona dead" });
    const session = await completedLane(stub, agentId, issue.id);

    await nudgeLane(env, stub, actor.organizationId, session, issue, prUrl, {
      prompt: "CI is red",
      reason: "CI failed",
    });

    const sessions = await stub.listAgentSessions({ issueId: issue.id });
    const child = sessions.find((s) => s.id !== session.id);
    expect(child?.status).toBe("failed");
    expect(child?.infraFailure).toBe(1);
    expect(child?.retryOf).toBe(session.id);
    const events = await stub.listAgentSessionEvents(session.id, {
      limit: 50,
      order: "desc",
    });
    const redispatch = events.find((e) => e.type === "prompt.redispatch");
    expect(redispatch).toBeDefined();
    expect(redispatch?.payload).toContain(child?.id);
    expect(redispatch?.payload).toContain("dispatchFailed");
  });

  it("skips the nudge entirely when the issue is done or canceled", async () => {
    const stub = getStub();
    const agentId = `mock-rd-done-${crypto.randomUUID().slice(0, 8)}`;
    const calls = registerFailingProvider(
      agentId,
      new ComputeError({
        code: "AGENT_ERROR",
        status: 502,
        message: "Daytona sandbox create failed: 400 boom",
      })
    );
    const issue = await stub.createIssue({
      title: "Settled work",
      status: "done",
    });
    const session = await completedLane(stub, agentId, issue.id);

    await nudgeLane(env, stub, actor.organizationId, session, issue, prUrl, {
      prompt: "review feedback",
      reason: "review",
      dedupeKey: "review-1",
    });

    expect(calls()).toBe(0);
    const sessions = await stub.listAgentSessions({ issueId: issue.id });
    expect(sessions).toHaveLength(1);
    const events = await stub.listAgentSessionEvents(session.id, {
      limit: 50,
      order: "desc",
    });
    expect(
      events.some(
        (e) =>
          e.type === "prompt.followup_skipped" &&
          e.message.includes("issue is done")
      )
    ).toBe(true);
  });

  it("creates no session while the agent type is paused", async () => {
    const stub = getStub();
    const agentId = `mock-rd-pause-${crypto.randomUUID().slice(0, 8)}`;
    const calls = registerFailingProvider(
      agentId,
      new ComputeError({
        code: "AGENT_ERROR",
        status: 502,
        message: "Daytona sandbox create failed: 400 boom",
      })
    );
    const issue = await stub.createIssue({ title: "Paused lane" });
    const session = await completedLane(stub, agentId, issue.id);
    await stub.pauseAgentType(agentId, {
      reason: "provider outage",
      actorId: actor.id,
      actorType: "user",
    });
    try {
      await nudgeLane(env, stub, actor.organizationId, session, issue, prUrl, {
        prompt: "CI is red",
        reason: "CI failed",
        dedupeKey: "ci-pause",
      });
      expect(calls()).toBe(0);
      // No held `waiting` row — the pause is a wall, not a queue.
      const sessions = await stub.listAgentSessions({ issueId: issue.id });
      expect(sessions).toHaveLength(1);
      const events = await stub.listAgentSessionEvents(session.id, {
        limit: 50,
        order: "desc",
      });
      expect(
        events.some(
          (e) =>
            e.type === "prompt.followup_skipped" && e.message.includes("paused")
        )
      ).toBe(true);
    } finally {
      await stub.resumeAgentType(agentId, {
        actorId: actor.id,
        actorType: "user",
      });
    }
  });

  it("stands down when the fleet breaker is open", async () => {
    const stub = getStub();
    const agentId = `mock-rd-fleet-${crypto.randomUUID().slice(0, 8)}`;
    const calls = registerFailingProvider(
      agentId,
      new ComputeError({
        code: "AGENT_ERROR",
        status: 502,
        message: "Daytona sandbox create failed: 400 boom",
      })
    );
    const issue = await stub.createIssue({ title: "Fleet is red" });
    const session = await completedLane(stub, agentId, issue.id);

    // FLEET_UNHEALTHY_STREAK consecutive infra deaths, newest first.
    for (let i = 0; i < 4; i++) {
      const deadIssue = await stub.createIssue({ title: `Infra ${i}` });
      const dead = await stub.createAgentSession({
        issueId: deadIssue.id,
        agentId,
        provider: agentId,
        actorId: actor.id,
        actorType: "user",
        status: "created",
      });
      await stub.applyAgentSessionResult(dead.id, {
        status: "failed",
        result: "provision timed out",
        infraFailure: true,
      });
    }

    await nudgeLane(env, stub, actor.organizationId, session, issue, prUrl, {
      prompt: "CI is red",
      reason: "CI failed",
      dedupeKey: "ci-fleet",
    });

    expect(calls()).toBe(0);
    const events = await stub.listAgentSessionEvents(session.id, {
      limit: 50,
      order: "desc",
    });
    expect(
      events.some(
        (e) =>
          e.type === "prompt.followup_skipped" &&
          e.message.includes("fleet unhealthy")
      )
    ).toBe(true);
  });

  it("backs off a second attempt and caps the lane at MAX_LANE_REDISPATCHES", async () => {
    const stub = getStub();
    const agentId = `mock-rd-cap-${crypto.randomUUID().slice(0, 8)}`;
    let calls = 0;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          sendPrompt: () => false,
          dispatch: (_org, dispatchedIssue) => {
            calls += 1;
            return {
              id: `cap-${calls}`,
              agentId,
              issueId: dispatchedIssue.id,
              status: "created" as const,
            };
          },
        })
    );
    const issue = await stub.createIssue({ title: "Capped lane" });
    const session = await completedLane(stub, agentId, issue.id);
    // The sendPrompt rejection writes prompt.followup_failed, which the
    // default 5m follow-up throttle would gate on — zero it so the cap and
    // backoff are what actually decide.
    await stub.upsertAgentProviderConfig({
      agentId,
      config: { followupThrottleMinutes: 0 },
    });

    // Attempt 1 dispatches.
    await nudgeLane(env, stub, actor.organizationId, session, issue, prUrl, {
      prompt: "CI is red",
      reason: "CI failed",
      dedupeKey: "cap-1",
    });
    expect(calls).toBe(1);

    // Attempt 2 is inside the backoff window — silently deferred, no record.
    await nudgeLane(env, stub, actor.organizationId, session, issue, prUrl, {
      prompt: "CI is red",
      reason: "CI failed",
      dedupeKey: "cap-2",
    });
    expect(calls).toBe(1);

    // With MAX_LANE_REDISPATCHES attempts already on the chain the next
    // detection is a recorded skip, not a dispatch.
    for (let i = 0; i < MAX_LANE_REDISPATCHES; i++) {
      await stub.addAgentSessionEvent({
        sessionId: session.id,
        type: "prompt.redispatch",
        message: `seeded attempt ${i}`,
        payload: { issueId: issue.id, prUrl, redispatchedAs: `seed-${i}` },
      });
    }
    await nudgeLane(env, stub, actor.organizationId, session, issue, prUrl, {
      prompt: "CI is red",
      reason: "CI failed",
      dedupeKey: "cap-3",
    });
    expect(calls).toBe(1);
    const events = await stub.listAgentSessionEvents(session.id, {
      limit: 50,
      order: "desc",
    });
    expect(
      events.some(
        (e) => e.type === "prompt.followup_skipped" && e.message.includes("cap")
      )
    ).toBe(true);
  });

  it("schedules exponential backoff between attempts", () => {
    expect(redispatchBackoffMs(0)).toBe(0);
    expect(redispatchBackoffMs(1)).toBe(5 * 60 * 1000);
    expect(redispatchBackoffMs(2)).toBe(10 * 60 * 1000);
    expect(redispatchBackoffMs(3)).toBe(20 * 60 * 1000);
  });
});
