import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { MockAgentProvider } from "./harness.js";
import { registerAgentProvider } from "./index.js";
import {
  buildReviewDiff,
  parseReviewVerdict,
  publishReviewVerdicts,
  REVIEW_CHECK_NAME,
  REVIEW_PURPOSE,
  renderReviewBody,
  requestPrReview,
  reviewableFiles,
  reviewCheckTitle,
  verdictConclusion,
} from "./review.js";

const workerEnv = env as unknown as WorkerEnv;
const REPO = "vortexnyc/pile";
const GENERATED = ["src/mcp/openapi.json", "src/mcp/mcp-tools.ts"];

describe("parseReviewVerdict", () => {
  it("reads the trailing json block", () => {
    const parsed = parseReviewVerdict(
      [
        "Looked at the diff.",
        "```json",
        JSON.stringify({
          verdict: "comment",
          summary: "Mostly fine.",
          findings: [
            { severity: "minor", title: "Rename x", file: "a.ts", line: 3 },
          ],
        }),
        "```",
      ].join("\n")
    );
    expect(parsed).toEqual({
      verdict: "comment",
      summary: "Mostly fine.",
      findings: [
        { severity: "minor", title: "Rename x", file: "a.ts", line: 3 },
      ],
      unstructured: false,
    });
  });

  it("escalates an approve that carries must-address findings", () => {
    const parsed = parseReviewVerdict(
      "```json\n" +
        JSON.stringify({
          verdict: "approve",
          findings: [{ severity: "important", title: "Missing null check" }],
        }) +
        "\n```"
    );
    expect(parsed.verdict).toBe("request-changes");
    expect(parsed.findings[0].severity).toBe("must");
  });

  it("never approves an unstructured report", () => {
    expect(parseReviewVerdict("VERDICT: approve, looks good").verdict).toBe(
      "comment"
    );
    expect(
      parseReviewVerdict("Verdict: request changes — breaks prod").verdict
    ).toBe("request-changes");
    const empty = parseReviewVerdict(null);
    expect(empty.verdict).toBe("comment");
    expect(empty.unstructured).toBe(true);
  });
});

describe("renderReviewBody", () => {
  it("renders the callout ladder in severity order", () => {
    const body = renderReviewBody(
      {
        verdict: "request-changes",
        summary: "Two blockers.",
        findings: [
          { severity: "minor", title: "Nit" },
          { severity: "must", title: "Add a test", file: "b.ts" },
          {
            severity: "breaking",
            title: "Crashes on null",
            file: "a.ts",
            line: 9,
            detail: "line one\nline two",
          },
        ],
        unstructured: false,
      },
      "0123456789abcdef"
    );
    const caution = body.indexOf("> [!CAUTION]");
    const important = body.indexOf("> [!IMPORTANT]");
    const minor = body.indexOf("ℹ️ **Minor**");
    expect(caution).toBeGreaterThan(-1);
    expect(important).toBeGreaterThan(caution);
    expect(minor).toBeGreaterThan(important);
    expect(body).toContain("> - **Crashes on null** — `a.ts:9`");
    expect(body).toContain(">   line two");
    expect(body).toContain("`0123456789ab`");
    expect(body).not.toContain("✅ **Clean**");
  });

  it("marks a finding-free review clean", () => {
    const review = {
      verdict: "approve" as const,
      summary: "",
      findings: [],
      unstructured: false,
    };
    expect(renderReviewBody(review, "abc")).toContain("✅ **Clean**");
    expect(reviewCheckTitle(review)).toBe("Approve");
    expect(verdictConclusion("approve")).toBe("success");
    expect(verdictConclusion("comment")).toBe("neutral");
    expect(verdictConclusion("request-changes")).toBe("failure");
  });
});

describe("diff shaping", () => {
  it("drops generated paths and bounds the inlined diff", () => {
    const files = reviewableFiles(
      [
        { filename: "src/mcp/openapi.json", patch: "@@ gen" },
        { filename: "src/a.ts", patch: "@@ -1 +1 @@\n-a\n+b" },
        { filename: "src/big.ts", patch: "x".repeat(500) },
        { filename: "logo.png", status: "added" },
      ],
      {
        conflict: { generated: GENERATED as [string, ...string[]], regen: "x" },
      }
    );
    expect(files.map((f) => f.filename)).toEqual([
      "src/a.ts",
      "src/big.ts",
      "logo.png",
    ]);
    const diff = buildReviewDiff(files, 200);
    expect(diff).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(diff).toContain("src/big.ts (diff budget exceeded)");
    expect(diff).toContain("logo.png (added, no textual patch)");
  });
});

interface GhCall {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}

function fakeGithub(opts: {
  config?: Record<string, unknown> | null;
  files: Array<{ filename: string; patch?: string }>;
  existingCheck?: boolean;
  /** "reject" 422s the first review POST (own-PR shape), "fail" 422s both,
   *  "flaky" 500s the first — a non-4xx is never retried. */
  reviewPost?: "ok" | "reject" | "fail" | "flaky";
}) {
  const calls: GhCall[] = [];
  let nextCheckId = 500;
  let reviewAttempts = 0;
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    calls.push({ method, url, body });
    if (url.includes("/contents/.pile/config.json")) {
      if (!opts.config) return new Response("not found", { status: 404 });
      return json({
        content: btoa(JSON.stringify(opts.config)),
        encoding: "base64",
      });
    }
    if (url.includes("/check-runs?check_name=")) {
      return json({
        check_runs: opts.existingCheck ? [{ id: 1 }] : [],
      });
    }
    if (url.includes("/files?")) return json(opts.files);
    if (url.endsWith("/check-runs") && method === "POST") {
      return json({ id: nextCheckId++ }, 201);
    }
    if (url.includes("/check-runs/") && method === "PATCH") {
      return json({ id: 500 });
    }
    if (url.includes("/reviews") && method === "POST") {
      reviewAttempts += 1;
      if (opts.reviewPost === "fail") {
        return json({ message: "Can not comment" }, 422);
      }
      if (opts.reviewPost === "reject" && reviewAttempts === 1) {
        return json(
          { message: "Can not request changes on your own pull request" },
          422
        );
      }
      if (opts.reviewPost === "flaky" && reviewAttempts === 1) {
        return json({ message: "Internal Server Error" }, 500);
      }
      return json(
        { id: 42, html_url: "https://github.com/r/1#review-42" },
        201
      );
    }
    if (url.includes("/issues/") && method === "POST") {
      return json({ html_url: "https://github.com/c/1" }, 201);
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, fetch: fetchFn as typeof fetch };
}

const REVIEW_CONFIG = {
  conflict: { generated: GENERATED, regen: "pnpm regen" },
  review: { agent: "review-mock" },
};

describe("requestPrReview / publishReviewVerdicts", () => {
  const userId = "user-pile-review";
  let organizationId = "";
  let stub: ReturnType<typeof env.WORKSPACE_DURABLE_OBJECT.get>;
  const dispatched: Array<{ instructions?: string; repo: string | null }> = [];
  const followUpPrompts: string[] = [];
  let rejectFollowUps = false;
  let pr = 1000;

  beforeAll(async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: userId,
        name: "Pile Review",
        email: `${userId}@example.com`,
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, userId);
    const workspace = await createWorkspace(db, env, headers, {
      name: "Pile review",
      slug: `pile-review-${crypto.randomUUID()}`,
      key: `PR${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      ownerId: userId,
    });
    organizationId = workspace!.id;
    stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    registerAgentProvider(
      "review-mock",
      () =>
        new MockAgentProvider("review-mock", {
          dispatch: (_org, issue, _model, ctx) => {
            dispatched.push({
              instructions: ctx?.instructions,
              repo: issue.repo,
            });
            return {
              id: "review-remote",
              agentId: "review-mock",
              status: "running",
            };
          },
          sendPrompt: async (_id, prompt) => {
            if (rejectFollowUps) return false;
            followUpPrompts.push(prompt);
            return true;
          },
        })
    );
  });

  function target(headSha: string) {
    pr += 1;
    return {
      repoFull: REPO,
      pullNumber: pr,
      prUrl: `https://github.com/${REPO}/pull/${pr}`,
      headSha,
      baseRef: "main",
      title: "Add thing",
      body: "Implements the thing.",
    };
  }

  async function laneIssue() {
    const issue = await stub.createIssue({
      title: "Review target",
      repo: REPO,
      branch: `issue-${crypto.randomUUID().slice(0, 8)}`,
    });
    // The working lane is live — the review must run alongside it.
    await stub.createAgentSession({
      issueId: issue.id,
      agentId: "review-mock",
      provider: "review-mock",
      actorId: userId,
      actorType: "user",
      status: "running",
    });
    return issue;
  }

  it("is a no-op when the repo hasn't opted in", async () => {
    const issue = await laneIssue();
    const gh = fakeGithub({
      config: { conflict: REVIEW_CONFIG.conflict },
      files: [{ filename: "src/a.ts", patch: "@@" }],
    });
    const outcome = await requestPrReview(
      workerEnv,
      stub,
      organizationId,
      issue,
      target("sha-disabled"),
      "tok",
      { fetch: gh.fetch }
    );
    expect(outcome).toBe("disabled");
    expect(gh.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("skips generated-only diffs with a skipped check run", async () => {
    const issue = await laneIssue();
    const gh = fakeGithub({
      config: REVIEW_CONFIG,
      files: GENERATED.map((filename) => ({ filename, patch: "@@" })),
    });
    const before = dispatched.length;
    const outcome = await requestPrReview(
      workerEnv,
      stub,
      organizationId,
      issue,
      target("sha-generated"),
      "tok",
      { fetch: gh.fetch }
    );
    expect(outcome).toBe("skipped_generated");
    expect(dispatched.length).toBe(before);
    const post = gh.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/check-runs")
    );
    expect(post?.body).toMatchObject({
      name: REVIEW_CHECK_NAME,
      head_sha: "sha-generated",
      status: "completed",
      conclusion: "skipped",
    });
  });

  it("dispatches one repo-less review lane per headSha and publishes its verdict", async () => {
    const issue = await laneIssue();
    const gh = fakeGithub({
      config: REVIEW_CONFIG,
      files: [
        { filename: "src/a.ts", patch: "@@ -1 +1 @@\n-old\n+new" },
        { filename: GENERATED[0], patch: "@@ gen" },
      ],
    });
    const t = target("sha-review-1");
    const before = dispatched.length;
    const outcome = await requestPrReview(
      workerEnv,
      stub,
      organizationId,
      issue,
      t,
      "tok",
      { fetch: gh.fetch }
    );
    expect(outcome).toBe("dispatched");
    expect(dispatched.length).toBe(before + 1);
    const sent = dispatched.at(-1)!;
    expect(sent.repo).toBeNull();
    expect(sent.instructions).toContain("REVIEW-ONLY");
    expect(sent.instructions).toContain("+new");
    expect(sent.instructions).not.toContain("@@ gen");
    expect(sent.instructions).toContain(GENERATED[0]);
    const created = gh.calls.find(
      (c) => c.method === "POST" && c.url.endsWith("/check-runs")
    );
    expect(created?.body).toMatchObject({
      name: REVIEW_CHECK_NAME,
      head_sha: "sha-review-1",
      status: "in_progress",
    });

    // Same headSha again (webhook + sweep both fire) → deduped in Pile.
    const again = await requestPrReview(
      workerEnv,
      stub,
      organizationId,
      issue,
      t,
      "tok",
      { fetch: gh.fetch }
    );
    expect(again).toBe("deduped");
    expect(dispatched.length).toBe(before + 1);

    const sessions = await stub.listAgentSessions({ issueId: issue.id });
    const review = sessions.find((s) => s.purpose === REVIEW_PURPOSE)!;
    expect(review).toBeDefined();
    // The working lane still owns the issue.
    const active = await stub.getActiveAgentSessionForIssue(issue.id);
    expect(active?.session.purpose).not.toBe(REVIEW_PURPOSE);

    await stub.applyAgentSessionResult(review.id, {
      status: "completed",
      result:
        "Reviewed.\n```json\n" +
        JSON.stringify({
          verdict: "request-changes",
          summary: "Breaks the build.",
          findings: [
            { severity: "breaking", title: "Type error", file: "src/a.ts" },
          ],
        }) +
        "\n```",
    });

    const publishGh = fakeGithub({ config: REVIEW_CONFIG, files: [] });
    const deps = {
      env: workerEnv,
      organizationId,
      fetch: publishGh.fetch,
      tokenForRepo: async () => "tok",
    };
    expect(await publishReviewVerdicts(stub, deps)).toBeGreaterThanOrEqual(1);
    const patch = publishGh.calls.find(
      (c) => c.method === "PATCH" && c.url.endsWith("/check-runs/500")
    );
    expect(patch?.body).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: { title: "Request changes: 1 will break" },
    });
    // The verdict lands as a real pull_request_review — no plain comment.
    const prReview = publishGh.calls.find(
      (c) =>
        c.method === "POST" && c.url.includes(`/pulls/${t.pullNumber}/reviews`)
    );
    expect(prReview?.body).toMatchObject({
      commit_id: "sha-review-1",
      event: "REQUEST_CHANGES",
    });
    expect(String(prReview?.body?.body)).toContain("> [!CAUTION]");
    expect(String(prReview?.body?.body)).toContain(
      "<!-- pile-review sha=sha-review-1 -->"
    );
    expect(
      publishGh.calls.some((c) => c.url.includes(`/issues/${t.pullNumber}/`))
    ).toBe(false);

    // The work lane hears the verdict as a follow-up prompt, deduped under
    // the review-<id> key the webhook/sweep detection path also uses.
    expect(followUpPrompts.at(-1)).toContain("requested changes");
    expect(followUpPrompts.at(-1)).toContain("Type error");
    const workLane = sessions.find((s) => s.purpose !== REVIEW_PURPOSE)!;
    const workEvents = await stub.listAgentSessionEvents(workLane.id);
    const followup = workEvents.find((e) => e.type === "prompt.followup");
    expect(followup?.payload).toContain("review-42");

    const events = await stub.listAgentSessionEvents(review.id);
    const publishedEvent = events.find((e) => e.type === "review.published");
    expect(publishedEvent?.payload).toContain('"reviewId":42');

    // Idempotent: a second pass publishes nothing for this session.
    const replay = fakeGithub({ config: REVIEW_CONFIG, files: [] });
    await publishReviewVerdicts(stub, { ...deps, fetch: replay.fetch });
    expect(
      replay.calls.some((c) => c.url.includes(`/issues/${t.pullNumber}/`))
    ).toBe(false);
    expect(
      replay.calls.some((c) => c.url.includes(`/pulls/${t.pullNumber}/reviews`))
    ).toBe(false);
    expect(events.filter((e) => e.type === "review.published")).toHaveLength(1);
  });

  async function finishReviewLane(
    issue: Awaited<ReturnType<typeof laneIssue>>,
    headSha: string,
    result: string
  ) {
    const t = target(headSha);
    const gh = fakeGithub({
      config: REVIEW_CONFIG,
      files: [{ filename: "src/a.ts", patch: "@@" }],
    });
    const outcome = await requestPrReview(
      workerEnv,
      stub,
      organizationId,
      issue,
      t,
      "tok",
      { fetch: gh.fetch }
    );
    expect(outcome).toBe("dispatched");
    const review = (await stub.listAgentSessions({ issueId: issue.id })).find(
      (s) => s.purpose === REVIEW_PURPOSE
    )!;
    await stub.applyAgentSessionResult(review.id, {
      status: "completed",
      result,
    });
    return { t, review };
  }

  const publishDeps = (gh: ReturnType<typeof fakeGithub>) => ({
    env: workerEnv,
    organizationId,
    fetch: gh.fetch,
    tokenForRepo: async () => "tok",
  });

  it("downgrades to a COMMENT review when the app authored the PR", async () => {
    const issue = await laneIssue();
    const promptsBefore = followUpPrompts.length;
    const { t } = await finishReviewLane(
      issue,
      "sha-own-pr",
      "```json\n" +
        JSON.stringify({
          verdict: "request-changes",
          summary: "Needs work.",
          findings: [{ severity: "must", title: "Fix it" }],
        }) +
        "\n```"
    );
    const publishGh = fakeGithub({
      config: REVIEW_CONFIG,
      files: [],
      reviewPost: "reject",
    });
    await publishReviewVerdicts(stub, publishDeps(publishGh));
    const posts = publishGh.calls.filter(
      (c) =>
        c.method === "POST" && c.url.includes(`/pulls/${t.pullNumber}/reviews`)
    );
    expect(posts).toHaveLength(2);
    expect(posts[0].body?.event).toBe("REQUEST_CHANGES");
    expect(posts[1].body?.event).toBe("COMMENT");
    expect(posts[1].body).not.toHaveProperty("commit_id");
    expect(followUpPrompts.length).toBe(promptsBefore + 1);
  });

  it("falls back to a PR comment when no review can be posted", async () => {
    const issue = await laneIssue();
    const promptsBefore = followUpPrompts.length;
    const { t, review } = await finishReviewLane(
      issue,
      "sha-no-review",
      "```json\n" +
        JSON.stringify({
          verdict: "request-changes",
          summary: "Needs work.",
          findings: [{ severity: "must", title: "Fix it" }],
        }) +
        "\n```"
    );
    const publishGh = fakeGithub({
      config: REVIEW_CONFIG,
      files: [],
      reviewPost: "fail",
    });
    await publishReviewVerdicts(stub, publishDeps(publishGh));
    const comment = publishGh.calls.find(
      (c) =>
        c.method === "POST" &&
        c.url.includes(`/issues/${t.pullNumber}/comments`)
    );
    expect(String(comment?.body?.body)).toContain("⛔ Request changes");
    // The lane still gets the verdict; dedupe falls back to a sha key.
    expect(followUpPrompts.length).toBe(promptsBefore + 1);
    const reviewEvents = await stub.listAgentSessionEvents(review.id);
    expect(
      reviewEvents.find((e) => e.type === "review.published")?.payload
    ).toContain('"reviewId":null');
  });

  it("keeps an approve verdict to a comment — no review, no lane nudge", async () => {
    const issue = await laneIssue();
    const promptsBefore = followUpPrompts.length;
    const { t } = await finishReviewLane(
      issue,
      "sha-approve",
      "```json\n" +
        JSON.stringify({ verdict: "approve", summary: "Looks good." }) +
        "\n```"
    );
    const publishGh = fakeGithub({ config: REVIEW_CONFIG, files: [] });
    await publishReviewVerdicts(stub, publishDeps(publishGh));
    expect(
      publishGh.calls.some((c) =>
        c.url.includes(`/pulls/${t.pullNumber}/reviews`)
      )
    ).toBe(false);
    const comment = publishGh.calls.find(
      (c) =>
        c.method === "POST" &&
        c.url.includes(`/issues/${t.pullNumber}/comments`)
    );
    expect(String(comment?.body?.body)).toContain("✅ Approve");
    expect(followUpPrompts.length).toBe(promptsBefore);
  });

  // A 5xx (or a dropped response) is not a definitive rejection — the
  // review may exist server-side, so the POST isn't retried and the
  // verdict degrades straight to the issue comment.
  it("never retries the review POST on a non-4xx failure", async () => {
    const issue = await laneIssue();
    const promptsBefore = followUpPrompts.length;
    const { t, review } = await finishReviewLane(
      issue,
      "sha-flaky-review",
      "```json\n" +
        JSON.stringify({
          verdict: "request-changes",
          summary: "Needs work.",
          findings: [{ severity: "must", title: "Fix it" }],
        }) +
        "\n```"
    );
    const publishGh = fakeGithub({
      config: REVIEW_CONFIG,
      files: [],
      reviewPost: "flaky",
    });
    await publishReviewVerdicts(stub, publishDeps(publishGh));
    const posts = publishGh.calls.filter(
      (c) =>
        c.method === "POST" && c.url.includes(`/pulls/${t.pullNumber}/reviews`)
    );
    expect(posts).toHaveLength(1);
    const comment = publishGh.calls.find(
      (c) =>
        c.method === "POST" &&
        c.url.includes(`/issues/${t.pullNumber}/comments`)
    );
    expect(String(comment?.body?.body)).toContain("⛔ Request changes");
    expect(followUpPrompts.length).toBe(promptsBefore + 1);
    const reviewEvents = await stub.listAgentSessionEvents(review.id);
    expect(
      reviewEvents.find((e) => e.type === "review.published")?.payload
    ).toContain('"reviewId":null');
  });

  // PILE-315 — a rejected verdict nudge is not the end: every later sweep
  // re-attempts it until nudgeLane's delivery dedupe sees it, which is
  // also what carries the pile-review-<sha> fallback key no GitHub
  // detection pass can see.
  it("retries an undelivered verdict nudge until the lane takes it", async () => {
    const issue = await laneIssue();
    // No follow-up throttle here — a retry inside the 5m window would
    // legitimately wait it out.
    await stub.upsertAgentProviderConfig({
      agentId: "review-mock",
      config: { followupThrottleMinutes: 0 },
    });
    const { review } = await finishReviewLane(
      issue,
      "sha-nudge-retry",
      "```json\n" +
        JSON.stringify({
          verdict: "request-changes",
          summary: "Needs work.",
          findings: [{ severity: "must", title: "Fix it" }],
        }) +
        "\n```"
    );
    const workLane = (await stub.listAgentSessions({ issueId: issue.id })).find(
      (s) => s.purpose !== REVIEW_PURPOSE
    )!;
    const promptsBefore = followUpPrompts.length;
    rejectFollowUps = true;
    try {
      // Pass 1: no pull_request_review posts → plain comment fallback; the
      // provider rejects the prompt → prompt.followup_failed.
      const pass1 = fakeGithub({
        config: REVIEW_CONFIG,
        files: [],
        reviewPost: "fail",
      });
      await publishReviewVerdicts(stub, publishDeps(pass1));
      expect(followUpPrompts.length).toBe(promptsBefore);
      let workEvents = await stub.listAgentSessionEvents(workLane.id);
      const failed = workEvents.find(
        (e) => e.type === "prompt.followup_failed"
      );
      expect(failed?.payload).toContain("pile-review-sha-nudge-retry");
      expect(
        (await stub.listAgentSessionEvents(review.id)).some(
          (e) => e.type === "review.published"
        )
      ).toBe(true);

      // Pass 2: provider healthy again — the already-published session
      // re-attempts the nudge under the same key, no GitHub calls needed.
      rejectFollowUps = false;
      const pass2 = fakeGithub({ config: REVIEW_CONFIG, files: [] });
      await publishReviewVerdicts(stub, publishDeps(pass2));
      expect(pass2.calls).toHaveLength(0);
      expect(followUpPrompts.length).toBe(promptsBefore + 1);
      workEvents = await stub.listAgentSessionEvents(workLane.id);
      expect(
        workEvents.filter(
          (e) =>
            e.type === "prompt.followup" &&
            typeof e.payload === "string" &&
            e.payload.includes("pile-review-sha-nudge-retry")
        )
      ).toHaveLength(1);

      // Pass 3: delivered — the dedupe holds.
      const pass3 = fakeGithub({ config: REVIEW_CONFIG, files: [] });
      await publishReviewVerdicts(stub, publishDeps(pass3));
      expect(followUpPrompts.length).toBe(promptsBefore + 1);
      expect(pass3.calls).toHaveLength(0);
    } finally {
      rejectFollowUps = false;
    }
  });

  it("defers to an existing pile-review check run for the headSha", async () => {
    const issue = await laneIssue();
    const gh = fakeGithub({
      config: REVIEW_CONFIG,
      files: [{ filename: "src/a.ts", patch: "@@" }],
      existingCheck: true,
    });
    const before = dispatched.length;
    const outcome = await requestPrReview(
      workerEnv,
      stub,
      organizationId,
      issue,
      target("sha-existing"),
      "tok",
      { fetch: gh.fetch }
    );
    expect(outcome).toBe("deduped");
    expect(dispatched.length).toBe(before);
  });
});
