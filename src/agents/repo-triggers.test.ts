import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import {
  type PileRepoConfig,
  parsePileRepoConfig,
} from "../global/pile-repo-config.js";
import { githubInstallations, user as userTable } from "../global/schema.js";
import { createDefaultTeam, createTeam } from "../global/teams.js";
import { createWorkspace } from "../global/workspaces.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { processGithubWebhookPayload } from "./github.js";
import { MockAgentProvider } from "./harness.js";
import { registerAgentProvider } from "./index.js";
import {
  automationEventTarget,
  fireRepoTriggers,
  isTriggerLane,
  matchRepoTriggers,
  mentionsHandle,
  repoTriggerEvent,
} from "./repo-triggers.js";
import { fireEventAutomations } from "./sweep.js";

const REPO = "VortexNYC/pile-triggers";
let ORG = "";

function stub() {
  return env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(ORG)
  );
}

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "trigger-user",
      name: "Trigger User",
      email: "trigger-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const headers = await createAdminHeaders(env, "trigger-user");
  const workspace = await createWorkspace(db, env, headers, {
    name: "Trigger Test",
    slug: `trigger-test-${crypto.randomUUID()}`,
    ownerId: "trigger-user",
  });
  ORG = workspace!.id;
  await createDefaultTeam(db, env, headers, ORG, "TRG", "trigger-user");
  await db
    .insert(githubInstallations)
    .values({
      id: crypto.randomUUID(),
      organizationId: ORG,
      installationId: "inst-triggers",
      repo: REPO,
    })
    .onConflictDoNothing();
  await stub().setOrganizationId(ORG);
}

const CONFIG: PileRepoConfig = {
  model: "repo-default-model",
  triggers: [
    { on: "pr.opened", agent: "trigger-mock", prompt: "Review this PR." },
    {
      on: "label.added",
      agent: "trigger-mock",
      prompt: "Plan it.",
      label: "needs-plan",
    },
    {
      on: "mention",
      agent: "trigger-mock",
      model: "mention-model",
      prompt: "Answer the mention.",
    },
  ],
};

describe("repo trigger config (PILE-275)", () => {
  it("parses triggers and rejects unknown events", () => {
    expect(
      parsePileRepoConfig({
        triggers: [{ on: "issue.created", agent: "devin", prompt: "Triage." }],
      })?.triggers
    ).toEqual([{ on: "issue.created", agent: "devin", prompt: "Triage." }]);
    expect(
      parsePileRepoConfig({
        triggers: [{ on: "issue.deleted", agent: "devin", prompt: "x" }],
      })
    ).toBeNull();
    expect(
      parsePileRepoConfig({ triggers: [{ on: "mention", prompt: "x" }] })
    ).toBeNull();
  });

  it("maps internal event names onto trigger events", () => {
    expect(repoTriggerEvent("pr.ci_failed")).toBe("ci.failed");
    expect(repoTriggerEvent("pr.synchronize")).toBe("pr.synchronize");
    expect(repoTriggerEvent("pr.review_changes")).toBe("pr.changes_requested");
    expect(repoTriggerEvent("pr.review")).toBe("pr.review");
    expect(repoTriggerEvent("pr.conflict")).toBe("pr.conflict");
    expect(repoTriggerEvent("pr.branch_update")).toBeNull();
  });

  it("flags lanes a trigger dispatched", () => {
    expect(isTriggerLane({ purpose: "trigger:pr.opened" })).toBe(true);
    expect(isTriggerLane({ purpose: "review" })).toBe(false);
    expect(isTriggerLane({ purpose: null })).toBe(false);
    expect(isTriggerLane({})).toBe(false);
  });

  it("filters label and mention triggers on event facts", () => {
    expect(matchRepoTriggers(CONFIG, "label.added", { label: "bug" })).toEqual(
      []
    );
    expect(
      matchRepoTriggers(CONFIG, "label.added", { label: "Needs-Plan" })
    ).toHaveLength(1);
    expect(
      matchRepoTriggers(CONFIG, "mention", { body: "hey @pile take a look" })
    ).toHaveLength(1);
    expect(
      matchRepoTriggers(CONFIG, "mention", { body: "ping @pilefrog" })
    ).toEqual([]);
    expect(matchRepoTriggers(null, "pr.opened")).toEqual([]);
    expect(mentionsHandle("cc @Pile-bot", "@pile-bot")).toBe(true);
    expect(mentionsHandle("mail me@pile", "@pile")).toBe(false);
  });
});

describe("fireRepoTriggers (PILE-275)", () => {
  const dispatched: Array<{
    issueId: string;
    repo?: string | null;
    model?: string;
    instructions?: string;
  }> = [];

  beforeAll(async () => {
    await seedWorkspace();
    registerAgentProvider(
      "trigger-mock",
      () =>
        new MockAgentProvider("trigger-mock", {
          dispatch: (_org, issue, model, context) => {
            dispatched.push({
              issueId: issue.id,
              repo: issue.repo,
              model,
              instructions: context?.instructions,
            });
            return {
              id: `remote-${crypto.randomUUID()}`,
              agentId: "trigger-mock",
              issueId: issue.id,
              status: "created",
            };
          },
        })
    );
  });

  it("dispatches the matching trigger with its prompt and model", async () => {
    const issue = await stub().createIssue({ title: "Mentioned", repo: REPO });
    const before = dispatched.length;
    const fired = await fireRepoTriggers(
      env as unknown as WorkerEnv,
      stub(),
      ORG,
      "mention",
      automationEventTarget(async () => issue, REPO),
      {
        context: "octo mentioned you: @pile why?",
        facts: { body: "@pile why?" },
        loadConfig: async () => CONFIG,
      }
    );
    expect(fired).toBe(1);
    expect(dispatched.length).toBe(before + 1);
    const lane = dispatched.at(-1);
    expect(lane?.issueId).toBe(issue.id);
    expect(lane?.model).toBe("mention-model");
    expect(lane?.instructions).toContain("Answer the mention.");
    expect(lane?.instructions).toContain("octo mentioned you");
    const sessions = await stub().listAgentSessions({ issueId: issue.id });
    expect(sessions[0]?.purpose).toBe("trigger:mention");
  });

  it("falls back to the repo model and skips agents outside the allowlist", async () => {
    const issue = await stub().createIssue({ title: "New PR", repo: REPO });
    const before = dispatched.length;
    const fired = await fireRepoTriggers(
      env as unknown as WorkerEnv,
      stub(),
      ORG,
      "pr.opened",
      automationEventTarget(async () => issue, REPO),
      { loadConfig: async () => CONFIG }
    );
    expect(fired).toBe(1);
    expect(dispatched.at(-1)?.model).toBe("repo-default-model");
    expect(dispatched.at(-1)?.instructions).toBe("Review this PR.");

    const blocked = await fireRepoTriggers(
      env as unknown as WorkerEnv,
      stub(),
      ORG,
      "pr.opened",
      automationEventTarget(async () => {
        throw new Error("issue must not resolve");
      }, REPO),
      { loadConfig: async () => ({ ...CONFIG, agents: ["devin"] }) }
    );
    expect(blocked).toBe(0);
    expect(dispatched.length).toBe(before + 1);
  });

  // PILE-321 — a trigger fires because a repo's config matched, so a
  // repo-less issue adopts that repo (persisted) instead of producing a
  // spec-only lane.
  it("adopts the event repo on a repo-less issue", async () => {
    const issue = await stub().createIssue({ title: "Repo-less trigger" });
    const before = dispatched.length;
    const fired = await fireRepoTriggers(
      env as unknown as WorkerEnv,
      stub(),
      ORG,
      "pr.opened",
      automationEventTarget(async () => issue, REPO),
      { loadConfig: async () => CONFIG }
    );
    expect(fired).toBe(1);
    expect(dispatched.length).toBe(before + 1);
    expect(dispatched.at(-1)?.repo).toBe(REPO);
    expect((await stub().getIssue(issue.id))?.repo).toBe(REPO);
  });

  it("does not overwrite an issue repo that differs from the event repo", async () => {
    const issue = await stub().createIssue({
      title: "Own repo wins",
      repo: "VortexNYC/other-repo",
    });
    const fired = await fireRepoTriggers(
      env as unknown as WorkerEnv,
      stub(),
      ORG,
      "pr.opened",
      automationEventTarget(async () => issue, REPO),
      { loadConfig: async () => CONFIG }
    );
    expect(fired).toBe(1);
    expect(dispatched.at(-1)?.repo).toBe("VortexNYC/other-repo");
    expect((await stub().getIssue(issue.id))?.repo).toBe(
      "VortexNYC/other-repo"
    );
  });

  it("never resolves the issue when no trigger matches", async () => {
    let resolved = false;
    const fired = await fireRepoTriggers(
      env as unknown as WorkerEnv,
      stub(),
      ORG,
      "pr.synchronize",
      automationEventTarget(async () => {
        resolved = true;
        return null;
      }, REPO),
      { loadConfig: async () => CONFIG }
    );
    expect(fired).toBe(0);
    expect(resolved).toBe(false);
  });

  // PILE-321 — event automations without a bound issue create one with
  // only the automation's teamId; dispatch inherits that team's
  // defaultRepo so the lane doesn't come back spec-only.
  it("automation-created issues inherit the team's defaultRepo", async () => {
    const db = createD1(env.D1);
    const team = await createTeam(db, env, new Headers(), {
      organizationId: ORG,
      key: "ADT",
      name: "Automation default",
      ownerId: "trigger-user",
      defaultRepo: "VortexNYC/auto-default",
    });
    await stub().createAgentAutomation({
      name: "defaulted automation",
      prompt: "do the thing",
      agentId: "trigger-mock",
      teamId: team.id,
      triggerKind: "event",
      triggerValue: "pile.test.event",
    });
    const before = dispatched.length;
    await fireEventAutomations(
      env as unknown as WorkerEnv,
      stub(),
      ORG,
      "pile.test.event",
      automationEventTarget(async () => null, null),
      undefined,
      undefined,
      undefined,
      { skipRepoTriggers: true }
    );
    expect(dispatched.length).toBe(before + 1);
    const lane = dispatched.at(-1);
    expect(lane?.repo).toBe("VortexNYC/auto-default");
    const created = await stub().getIssue(lane!.issueId);
    expect(created?.repo).toBe("VortexNYC/auto-default");
  });

  it("does not materialize a per-PR issue when the repo declares no triggers", async () => {
    await processGithubWebhookPayload(
      createD1(env.D1),
      env as unknown as WorkerEnv,
      {
        event: "pull_request",
        deliveryId: crypto.randomUUID(),
        rawBody: JSON.stringify({
          action: "opened",
          pull_request: {
            number: 77,
            title: "Human PR",
            body: null,
            state: "open",
            html_url: `https://github.com/${REPO}/pull/77`,
            head: { ref: "feature/human", repo: { full_name: REPO } },
          },
        }),
      }
    );
    expect(
      await stub().getIssue("repo:github:VortexNYC:pile-triggers:pr:77")
    ).toBeUndefined();
  });
});

describe("review and conflict triggers (PILE-272)", () => {
  const REVIEW_CONFIG: PileRepoConfig = {
    triggers: [
      {
        on: "pr.changes_requested",
        agent: "trigger-mock",
        prompt: "Address the requested changes.",
      },
      { on: "pr.conflict", agent: "trigger-mock", prompt: "Resolve it." },
    ],
  };

  it("routes pr.review_changes onto pr.changes_requested triggers", async () => {
    const issue = await stub().createIssue({
      title: "Changes requested",
      repo: REPO,
    });
    await fireEventAutomations(
      env as unknown as WorkerEnv,
      stub(),
      ORG,
      "pr.review_changes",
      automationEventTarget(async () => issue, REPO),
      "reviewer requested changes",
      undefined,
      undefined,
      { loadConfig: async () => REVIEW_CONFIG }
    );
    const sessions = await stub().listAgentSessions({ issueId: issue.id });
    expect(sessions.map((s) => s.purpose)).toEqual([
      "trigger:pr.changes_requested",
    ]);
  });

  it("dispatches pr.conflict triggers unless the lane is trigger-spawned", async () => {
    const issue = await stub().createIssue({
      title: "Conflicting PR",
      repo: REPO,
    });
    const fire = (skipRepoTriggers: boolean) =>
      fireEventAutomations(
        env as unknown as WorkerEnv,
        stub(),
        ORG,
        "pr.conflict",
        automationEventTarget(async () => issue, REPO),
        "PR has merge conflicts",
        undefined,
        undefined,
        { skipRepoTriggers, loadConfig: async () => REVIEW_CONFIG }
      );
    await fire(isTriggerLane({ purpose: "trigger:pr.opened" }));
    expect(await stub().listAgentSessions({ issueId: issue.id })).toHaveLength(
      0
    );
    await fire(isTriggerLane({ purpose: null }));
    const sessions = await stub().listAgentSessions({ issueId: issue.id });
    expect(sessions.map((s) => s.purpose)).toEqual(["trigger:pr.conflict"]);
  });
});

async function issueWithLane(purpose: string | null) {
  const issue = await stub().createIssue({ title: "Lane PR", repo: REPO });
  await stub().createAgentSession({
    issueId: issue.id,
    agentId: "trigger-mock",
    provider: "trigger-mock",
    actorId: "automation",
    actorType: "user",
    status: "completed",
    purpose,
  });
  return issue;
}

const purposes = async (issueId: string) =>
  (await stub().listAgentSessions({ issueId })).map((s) => s.purpose);

describe("structural self-feed guard (PILE-272)", () => {
  const SELF_FEED_CONFIG: PileRepoConfig = {
    triggers: [
      { on: "pr.synchronize", agent: "trigger-mock", prompt: "Re-check it." },
      { on: "pr.conflict", agent: "trigger-mock", prompt: "Resolve it." },
    ],
  };

  function fire(
    issue: Awaited<ReturnType<typeof issueWithLane>>,
    event: string,
    facts?: { pushedByBot?: boolean }
  ) {
    return fireEventAutomations(
      env as unknown as WorkerEnv,
      stub(),
      ORG,
      event,
      automationEventTarget(async () => issue, REPO),
      undefined,
      undefined,
      facts,
      { loadConfig: async () => SELF_FEED_CONFIG }
    );
  }

  it("skips a trigger lane's own conflict and bot pushes without a call-site flag", async () => {
    const issue = await issueWithLane("trigger:pr.synchronize");
    await fire(issue, "pr.conflict");
    await fire(issue, "pr.synchronize", { pushedByBot: true });
    expect(await purposes(issue.id)).toEqual(["trigger:pr.synchronize"]);
  });

  it("still fires on a human push to a trigger lane's PR", async () => {
    const issue = await issueWithLane("trigger:pr.synchronize");
    await fire(issue, "pr.synchronize", { pushedByBot: false });
    expect(await purposes(issue.id)).toEqual([
      "trigger:pr.synchronize",
      "trigger:pr.synchronize",
    ]);
  });

  it("fires for lanes no trigger dispatched", async () => {
    const issue = await issueWithLane(null);
    await fire(issue, "pr.synchronize", { pushedByBot: true });
    expect(await purposes(issue.id)).toContain("trigger:pr.synchronize");
  });
});

describe("ci.failed self-feed guard (PILE-304)", () => {
  it("skipRepoTriggers stands repo triggers down while automations still run", async () => {
    const issue = await stub().createIssue({
      title: "CI red on trigger lane",
      repo: REPO,
    });
    await fireEventAutomations(
      env as unknown as WorkerEnv,
      stub(),
      ORG,
      "pr.opened",
      automationEventTarget(async () => issue, REPO),
      undefined,
      undefined,
      undefined,
      { skipRepoTriggers: true, loadConfig: async () => CONFIG }
    );
    expect(await stub().listAgentSessions({ issueId: issue.id })).toHaveLength(
      0
    );

    // Without the guard the same event dispatches normally.
    await fireEventAutomations(
      env as unknown as WorkerEnv,
      stub(),
      ORG,
      "pr.opened",
      automationEventTarget(async () => issue, REPO),
      undefined,
      undefined,
      undefined,
      { loadConfig: async () => CONFIG }
    );
    const sessions = await stub().listAgentSessions({ issueId: issue.id });
    expect(sessions.at(-1)?.purpose).toBe("trigger:pr.opened");
  });
});
