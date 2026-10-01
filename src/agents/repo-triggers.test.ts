import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import {
  type PileRepoConfig,
  parsePileRepoConfig,
} from "../global/pile-repo-config.js";
import { githubInstallations, user as userTable } from "../global/schema.js";
import { createDefaultTeam } from "../global/teams.js";
import { createWorkspace } from "../global/workspaces.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { processGithubWebhookPayload } from "./github.js";
import { MockAgentProvider } from "./harness.js";
import { registerAgentProvider } from "./index.js";
import {
  automationEventTarget,
  fireRepoTriggers,
  matchRepoTriggers,
  mentionsHandle,
  repoTriggerEvent,
} from "./repo-triggers.js";

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
    expect(repoTriggerEvent("pr.conflict")).toBeNull();
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
