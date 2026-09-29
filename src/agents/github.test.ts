import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { githubInstallations, user as userTable } from "../global/schema.js";
import { createDefaultTeam } from "../global/teams.js";
import { createWorkspace } from "../global/workspaces.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { processGithubWebhookPayload } from "./github.js";
import { MockAgentProvider } from "./harness.js";
import { registerAgentProvider } from "./index.js";

const REPO = "VortexNYC/pile";
const BRANCH = "lane/pile-224";
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
      id: "review-user",
      name: "Reviewer",
      email: "review-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const headers = await createAdminHeaders(env, "review-user");
  const workspace = await createWorkspace(db, env, headers, {
    name: "Review Test",
    slug: `review-test-${crypto.randomUUID()}`,
    ownerId: "review-user",
  });
  ORG = workspace!.id;
  await createDefaultTeam(db, env, headers, ORG, "REV", "review-user");
  await db
    .insert(githubInstallations)
    .values({
      id: crypto.randomUUID(),
      organizationId: ORG,
      installationId: "inst-1",
      repo: REPO,
    })
    .onConflictDoNothing();
  await stub().setOrganizationId(ORG);
}

function reviewCommentPayload(over: Record<string, unknown> = {}) {
  return {
    action: "created",
    pull_request: {
      number: 42,
      html_url: `https://github.com/${REPO}/pull/42`,
      head: { ref: BRANCH, repo: { full_name: REPO } },
    },
    comment: {
      id: 9001,
      body: "please fix the null check",
      user: { login: "reviewer-gh" },
      html_url: "https://github.com/x",
      path: "src/api/agent-sessions.ts",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    repository: { full_name: REPO },
    ...over,
  };
}

function reviewPayload(over: Record<string, unknown> = {}) {
  return {
    action: "submitted",
    review: {
      id: 7001,
      state: "changes_requested",
      body: "needs a regression test",
      user: { login: "reviewer-gh" },
      html_url: `https://github.com/${REPO}/pull/42#pullrequestreview-7001`,
    },
    pull_request: {
      number: 42,
      html_url: `https://github.com/${REPO}/pull/42`,
      head: { ref: BRANCH, repo: { full_name: REPO } },
    },
    repository: { full_name: REPO },
    ...over,
  };
}

function queuePayload(event: string, body: unknown) {
  return {
    event,
    rawBody: JSON.stringify(body),
    deliveryId: crypto.randomUUID(),
  };
}

describe("github pr review → lane nudge (PILE-224)", () => {
  const prompts: string[] = [];

  beforeAll(async () => {
    await seedWorkspace();
    registerAgentProvider(
      "nudge-mock",
      () =>
        new MockAgentProvider("nudge-mock", {
          sendPrompt: (_id, prompt) => {
            prompts.push(prompt);
            return true;
          },
        })
    );
  });

  it("delivers a review comment to the lane's live session", async () => {
    const s = stub();
    const issue = await s.createIssue({
      title: "PR under review",
      repo: REPO,
      branch: BRANCH,
    });
    const session = await s.createAgentSession({
      issueId: issue.id,
      agentId: "nudge-mock",
      provider: "nudge-mock",
      actorId: "review-user",
      actorType: "user",
      status: "running",
      providerSessionId: "remote-nudge-1",
    });

    const before = prompts.length;
    await processGithubWebhookPayload(
      createD1(env.D1),
      env as unknown as WorkerEnv,
      queuePayload("pull_request_review_comment", reviewCommentPayload())
    );

    // The comment still lands on the issue thread...
    const comments = await s.listComments(issue.id);
    expect(
      comments.some((c) => c.body.includes("please fix the null check"))
    ).toBe(true);
    // ...and the lane got the steering prompt.
    expect(prompts.length).toBe(before + 1);
    expect(prompts.at(-1)).toContain("please fix the null check");
    expect(prompts.at(-1)).toContain("pull/42");
    void session;
  });

  it("delivers a submitted review (changes_requested) to the lane", async () => {
    const s = stub();
    const issue = await s.createIssue({
      title: "Review round trip",
      repo: REPO,
      branch: `${BRANCH}-review`,
    });
    await s.createAgentSession({
      issueId: issue.id,
      agentId: "nudge-mock",
      provider: "nudge-mock",
      actorId: "review-user",
      actorType: "user",
      status: "running",
      providerSessionId: "remote-nudge-2",
    });

    const before = prompts.length;
    await processGithubWebhookPayload(
      createD1(env.D1),
      env as unknown as WorkerEnv,
      queuePayload(
        "pull_request_review",
        reviewPayload({
          pull_request: {
            number: 44,
            html_url: `https://github.com/${REPO}/pull/44`,
            head: { ref: `${BRANCH}-review`, repo: { full_name: REPO } },
          },
        })
      )
    );

    expect(prompts.length).toBe(before + 1);
    expect(prompts.at(-1)).toContain("changes_requested");
    expect(prompts.at(-1)).toContain("needs a regression test");
    const comments = await s.listComments(issue.id);
    expect(
      comments.some((c) => c.body.includes("[review:changes_requested]"))
    ).toBe(true);
  });

  it("does not nudge when the lane session is terminal", async () => {
    const s = stub();
    const issue = await s.createIssue({
      title: "Dead lane",
      repo: REPO,
      branch: `${BRANCH}-dead`,
    });
    await s.createAgentSession({
      issueId: issue.id,
      agentId: "nudge-mock",
      provider: "nudge-mock",
      actorId: "review-user",
      actorType: "user",
      status: "completed",
      providerSessionId: "remote-nudge-3",
    });

    const before = prompts.length;
    await processGithubWebhookPayload(
      createD1(env.D1),
      env as unknown as WorkerEnv,
      queuePayload(
        "pull_request_review_comment",
        reviewCommentPayload({
          pull_request: {
            number: 43,
            html_url: `https://github.com/${REPO}/pull/43`,
            head: { ref: `${BRANCH}-dead`, repo: { full_name: REPO } },
          },
        })
      )
    );
    expect(prompts.length).toBe(before);
  });
});
