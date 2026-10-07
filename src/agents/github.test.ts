import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { createRepoIssue } from "../global/repo-issues.js";
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

  it("carries prior verdicts + the range since the last-reviewed sha (PILE-286)", async () => {
    const s = stub();
    const branch = `${BRANCH}-incremental`;
    const issue = await s.createIssue({
      title: "Incremental review",
      repo: REPO,
      branch,
    });
    const session = await s.createAgentSession({
      issueId: issue.id,
      agentId: "nudge-mock",
      provider: "nudge-mock",
      actorId: "review-user",
      actorType: "user",
      status: "running",
      providerSessionId: "remote-nudge-incremental",
    });
    await s.recordLaneReview(session.id, {
      reviewId: 8001,
      reviewer: "reviewer-gh",
      state: "CHANGES_REQUESTED",
      sha: "aaa1111aaaa",
      excerpt: "needs a regression test",
    });

    await processGithubWebhookPayload(
      createD1(env.D1),
      env as unknown as WorkerEnv,
      queuePayload(
        "pull_request_review",
        reviewPayload({
          review: {
            id: 8002,
            state: "changes_requested",
            body: "test still misses the null branch",
            user: { login: "reviewer-gh" },
            html_url: `https://github.com/${REPO}/pull/46#pullrequestreview-8002`,
            commit_id: "bbb2222bbbb",
          },
          pull_request: {
            number: 46,
            html_url: `https://github.com/${REPO}/pull/46`,
            head: {
              ref: branch,
              sha: "bbb2222bbbb",
              repo: { full_name: REPO },
            },
          },
        })
      )
    );

    const prompt = prompts.at(-1) ?? "";
    expect(prompt).toContain("test still misses the null branch");
    expect(prompt).toContain(
      "- reviewer-gh changes_requested @aaa1111: needs a regression test"
    );
    expect(prompt).toContain("git log aaa1111aaaa..bbb2222bbbb");
    const after = await s.getAgentSession(session.id);
    expect(after?.lastReviewedSha).toBe("bbb2222bbbb");
  });
});

function prCommentPayload(over: {
  number?: number;
  body?: string;
  id?: number;
  association?: string;
  userType?: string;
  title?: string;
}) {
  const number = over.number ?? 50;
  return {
    action: "created",
    issue: {
      number,
      title: over.title ?? "some PR",
      html_url: `https://github.com/${REPO}/pull/${number}`,
      pull_request: {
        url: `https://api.github.com/repos/${REPO}/pulls/${number}`,
      },
    },
    comment: {
      id: over.id ?? 50_000 + number,
      body: over.body ?? "@pile fix the typo in your PR",
      user: { login: "human-gh", type: over.userType ?? "User" },
      author_association: over.association ?? "MEMBER",
      html_url: `https://github.com/${REPO}/pull/${number}#issuecomment-1`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    repository: { full_name: REPO },
  };
}

async function laneWithPr(number: number, status: "running" | "failed") {
  const s = stub();
  const branch = `lane/mention-${number}`;
  const issue = await s.createIssue({
    title: `Mention lane ${number}`,
    repo: REPO,
    branch,
  });
  await s.updatePrState(
    REPO,
    branch,
    `https://github.com/${REPO}/pull/${number}`,
    "open",
    "github"
  );
  const session = await s.createAgentSession({
    issueId: issue.id,
    agentId: "mention-mock",
    provider: "mention-mock",
    actorId: "review-user",
    actorType: "user",
    status,
    providerSessionId: `remote-mention-${number}`,
  });
  return { issue, session };
}

function deliver(body: unknown) {
  return processGithubWebhookPayload(
    createD1(env.D1),
    env as unknown as WorkerEnv,
    queuePayload("issue_comment", body)
  );
}

describe("github @pile mention → lane (PILE-278)", () => {
  const prompts: string[] = [];
  const dispatched: Array<{
    issueId: string;
    repo?: string | null;
    instructions?: string;
  }> = [];

  beforeAll(async () => {
    if (!ORG) await seedWorkspace();
    registerAgentProvider(
      "mention-mock",
      () =>
        new MockAgentProvider("mention-mock", {
          sendPrompt: (_id, prompt) => {
            prompts.push(prompt);
            return true;
          },
          dispatch: (_org, issue, _model, ctx) => {
            dispatched.push({
              issueId: issue.id,
              repo: issue.repo,
              instructions: ctx?.instructions,
            });
            return {
              id: `mention-remote-${issue.id}`,
              agentId: "mention-mock",
              issueId: issue.id,
              status: "created",
            };
          },
        })
    );
  });

  it("resumes the PR's lane with the mention and mirrors it to the thread", async () => {
    const { issue } = await laneWithPr(50, "running");
    const before = prompts.length;
    await deliver(prCommentPayload({ number: 50 }));
    expect(prompts.length).toBe(before + 1);
    expect(prompts.at(-1)).toContain("fix the typo in your PR");
    expect(prompts.at(-1)).toContain("human-gh mentioned @pile");
    expect(prompts.at(-1)).toContain(`pull/50`);
    const comments = await stub().listComments(issue.id);
    expect(comments.some((c) => c.body.includes("fix the typo"))).toBe(true);
  });

  it("delivers a redelivered mention only once", async () => {
    await laneWithPr(51, "running");
    const before = prompts.length;
    const body = prCommentPayload({ number: 51 });
    await deliver(body);
    await deliver(body);
    expect(prompts.length).toBe(before + 1);
  });

  it("ignores PR comments without a mention, from bots, or from outsiders", async () => {
    await laneWithPr(52, "running");
    const before = prompts.length;
    await deliver(prCommentPayload({ number: 52, body: "lgtm", id: 1 }));
    await deliver(prCommentPayload({ number: 52, userType: "Bot", id: 2 }));
    await deliver(prCommentPayload({ number: 52, association: "NONE", id: 3 }));
    expect(prompts.length).toBe(before);
  });

  it("cold-dispatches a new lane when the PR's lane is dead", async () => {
    const { issue, session } = await laneWithPr(53, "failed");
    const before = dispatched.length;
    await deliver(
      prCommentPayload({ number: 53, body: "@pile retry with a smaller diff" })
    );
    expect(dispatched.length).toBe(before + 1);
    expect(dispatched.at(-1)?.issueId).toBe(issue.id);
    expect(dispatched.at(-1)?.instructions).toContain(
      "retry with a smaller diff"
    );
    const sessions = await stub().listAgentSessions({ issueId: issue.id });
    const fresh = sessions.find((s) => s.id !== session.id);
    expect(fresh?.retryOf).toBe(session.id);
  });

  it("dispatches on a mention in a synced GitHub issue with no lane yet", async () => {
    const db = createD1(env.D1);
    await db
      .update(githubInstallations)
      .set({ defaultAgentId: "mention-mock" })
      .where(eq(githubInstallations.repo, REPO));
    const issue = await stub().createIssue({
      title: "Synced GH issue",
      repo: REPO,
    });
    await createRepoIssue(db, ORG, REPO, 900, issue.id);
    const before = dispatched.length;
    await deliver({
      action: "created",
      issue: { number: 900, html_url: `https://github.com/${REPO}/issues/900` },
      comment: {
        id: 90_001,
        body: "@pile please take this one",
        user: { login: "human-gh", type: "User" },
        author_association: "OWNER",
        html_url: `https://github.com/${REPO}/issues/900#issuecomment-90001`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      repository: { full_name: REPO },
    });
    expect(dispatched.length).toBe(before + 1);
    expect(dispatched.at(-1)?.issueId).toBe(issue.id);
    expect(dispatched.at(-1)?.instructions).toContain("please take this one");
    expect(dispatched.at(-1)?.instructions).toContain("issues/900");
  });

  // PILE-321 — a synced GitHub issue whose Pile issue never got a repo
  // adopts the repo the mention was posted in, so the lane clones it
  // instead of returning a spec-only package.
  it("adopts the webhook repo for a repo-less synced issue", async () => {
    const db = createD1(env.D1);
    await db
      .update(githubInstallations)
      .set({ defaultAgentId: "mention-mock" })
      .where(eq(githubInstallations.repo, REPO));
    const issue = await stub().createIssue({
      title: "Repo-less synced issue",
    });
    await createRepoIssue(db, ORG, REPO, 901, issue.id);
    const before = dispatched.length;
    await deliver({
      action: "created",
      issue: { number: 901, html_url: `https://github.com/${REPO}/issues/901` },
      comment: {
        id: 90_101,
        body: "@pile repo should be inherited",
        user: { login: "human-gh", type: "User" },
        author_association: "OWNER",
        html_url: `https://github.com/${REPO}/issues/901#issuecomment-90101`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      repository: { full_name: REPO },
    });
    expect(dispatched.length).toBe(before + 1);
    expect(dispatched.at(-1)?.issueId).toBe(issue.id);
    expect(dispatched.at(-1)?.repo).toBe(REPO);
    expect((await stub().getIssue(issue.id))?.repo).toBe(REPO);
  });
});
