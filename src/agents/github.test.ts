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
      head: { ref: BRANCH, sha: "abc123", repo: { full_name: REPO } },
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
    registerAgentProvider(
      "nudge-dead",
      () =>
        new MockAgentProvider("nudge-dead", {
          // Sandbox reaped — delivery is rejected.
          sendPrompt: () => false,
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
            head: {
              ref: `${BRANCH}-review`,
              sha: "def456",
              repo: { full_name: REPO },
            },
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

  it("records prompt.followup_failed when the kept sandbox is already gone", async () => {
    const s = stub();
    const issue = await s.createIssue({
      title: "Reaped lane",
      repo: REPO,
      branch: `${BRANCH}-reaped`,
    });
    const session = await s.createAgentSession({
      issueId: issue.id,
      agentId: "nudge-dead",
      provider: "nudge-dead",
      actorId: "review-user",
      actorType: "user",
      status: "completed",
      providerSessionId: "remote-dead-1",
    });

    const before = prompts.length;
    await processGithubWebhookPayload(
      createD1(env.D1),
      env as unknown as WorkerEnv,
      queuePayload(
        "pull_request_review",
        reviewPayload({
          pull_request: {
            number: 45,
            html_url: `https://github.com/${REPO}/pull/45`,
            head: {
              ref: `${BRANCH}-reaped`,
              sha: "aaa999",
              repo: { full_name: REPO },
            },
          },
        })
      )
    );

    expect(prompts.length).toBe(before);
    const events = await s.listAgentSessionEvents(session.id, {});
    const types = events.map((e) => e.type);
    // Detection and delivery-rejection are both on the record — never silence.
    expect(types).toContain("pr.review");
    expect(types).toContain("prompt.followup_failed");
  });

  it("records prompt.followup_skipped on a dead lane, once per review", async () => {
    const s = stub();
    const issue = await s.createIssue({
      title: "Failed lane",
      repo: REPO,
      branch: `${BRANCH}-failed`,
    });
    const session = await s.createAgentSession({
      issueId: issue.id,
      agentId: "nudge-mock",
      provider: "nudge-mock",
      actorId: "review-user",
      actorType: "user",
      status: "failed",
      providerSessionId: "remote-failed-1",
    });

    const payload = queuePayload(
      "pull_request_review",
      reviewPayload({
        pull_request: {
          number: 46,
          html_url: `https://github.com/${REPO}/pull/46`,
          head: {
            ref: `${BRANCH}-failed`,
            sha: "bbb111",
            repo: { full_name: REPO },
          },
        },
      })
    );
    await processGithubWebhookPayload(
      createD1(env.D1),
      env as unknown as WorkerEnv,
      payload
    );
    // A redelivery of the same review must not stack more skip records.
    await processGithubWebhookPayload(
      createD1(env.D1),
      env as unknown as WorkerEnv,
      payload
    );

    const events = await s.listAgentSessionEvents(session.id, {});
    const types = events.map((e) => e.type);
    expect(types).toContain("pr.review");
    expect(types.filter((t) => t === "prompt.followup_skipped")).toHaveLength(
      1
    );
  });

  it("resumes a completed kept-sandbox lane on a review comment", async () => {
    const s = stub();
    const issue = await s.createIssue({
      title: "Kept lane",
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
    // Completed lanes are resumable — the follow-up is the review→lane loop.
    expect(prompts.length).toBe(before + 1);
  });

  it("fires pr.review_changes automations once per non-approve review (PILE-274)", async () => {
    const s = stub();
    const dispatched: string[] = [];
    registerAgentProvider(
      "review-auto",
      () =>
        new MockAgentProvider("review-auto", {
          dispatch: (_org, issue) => {
            dispatched.push(issue.id);
            return { id: "auto-1", agentId: "review-auto", status: "created" };
          },
        })
    );
    const automation = await s.createAgentAutomation({
      name: "Fix review",
      prompt: "address the review",
      agentId: "review-auto",
      triggerKind: "event",
      triggerValue: "pr.review_changes",
    });
    const issue = await s.createIssue({
      title: "Changes requested",
      repo: REPO,
      branch: `${BRANCH}-changes`,
    });
    await s.createAgentSession({
      issueId: issue.id,
      agentId: "nudge-mock",
      provider: "nudge-mock",
      actorId: "review-user",
      actorType: "user",
      status: "completed",
      providerSessionId: "remote-changes-1",
    });
    const pr = {
      number: 47,
      html_url: `https://github.com/${REPO}/pull/47`,
      head: {
        ref: `${BRANCH}-changes`,
        sha: "ccc111",
        repo: { full_name: REPO },
      },
    };
    const changes = queuePayload(
      "pull_request_review",
      reviewPayload({
        review: {
          id: 7101,
          state: "changes_requested",
          body: "handle the empty case",
          user: { login: "reviewer-gh" },
          html_url: `${pr.html_url}#pullrequestreview-7101`,
        },
        pull_request: pr,
      })
    );
    await processGithubWebhookPayload(
      createD1(env.D1),
      env as unknown as WorkerEnv,
      changes
    );
    // Redelivery of the same review must not fire the automation again.
    await processGithubWebhookPayload(
      createD1(env.D1),
      env as unknown as WorkerEnv,
      changes
    );
    await processGithubWebhookPayload(
      createD1(env.D1),
      env as unknown as WorkerEnv,
      queuePayload(
        "pull_request_review",
        reviewPayload({
          review: {
            id: 7102,
            state: "approved",
            body: "looks good now",
            user: { login: "reviewer-gh" },
            html_url: `${pr.html_url}#pullrequestreview-7102`,
          },
          pull_request: pr,
        })
      )
    );
    await s.deleteAgentAutomation(automation!.id);

    expect(dispatched).toEqual([issue.id]);
  });
});
