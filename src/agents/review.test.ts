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
}) {
  const calls: GhCall[] = [];
  let nextCheckId = 500;
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
    const comment = publishGh.calls.find(
      (c) => c.method === "POST" && c.url.includes(`/issues/${t.pullNumber}/`)
    );
    expect(String(comment?.body?.body)).toContain("> [!CAUTION]");
    expect(String(comment?.body?.body)).toContain(
      "<!-- pile-review sha=sha-review-1 -->"
    );

    // Idempotent: a second pass publishes nothing for this session.
    const replay = fakeGithub({ config: REVIEW_CONFIG, files: [] });
    await publishReviewVerdicts(stub, { ...deps, fetch: replay.fetch });
    expect(
      replay.calls.some((c) => c.url.includes(`/issues/${t.pullNumber}/`))
    ).toBe(false);
    const events = await stub.listAgentSessionEvents(review.id);
    expect(events.filter((e) => e.type === "review.published")).toHaveLength(1);
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
