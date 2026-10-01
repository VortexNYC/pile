import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { supportTickets, user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { MockAgentProvider } from "./harness.js";
import { registerAgentProvider } from "./index.js";
import { MAX_NUDGES_PER_HEAD_SHA, MAX_NUDGES_PER_LANE } from "./nudge.js";
import {
  addressedReviewThreads,
  DEFAULT_INACTIVITY_MINUTES,
  DEFAULT_PROVISION_TIMEOUT_MINUTES,
  DEFAULT_TIMEOUT_MINUTES,
  hashAgentState,
  ingestFailedAgentSession,
  parseAgentTimeouts,
  progressIsStale,
  prStateFromPull,
  reviewRequestsChanges,
  shouldUpdatePrBranch,
  summarizeCheckRuns,
  sweepAgentSessions,
  syncOpenPrSessions,
} from "./sweep.js";

describe("parseAgentTimeouts", () => {
  it("returns defaults for missing or invalid config", () => {
    expect(parseAgentTimeouts(null)).toEqual({
      timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
      inactivityMinutes: DEFAULT_INACTIVITY_MINUTES,
      provisionTimeoutMinutes: DEFAULT_PROVISION_TIMEOUT_MINUTES,
    });
    expect(parseAgentTimeouts("not-json")).toEqual({
      timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
      inactivityMinutes: DEFAULT_INACTIVITY_MINUTES,
      provisionTimeoutMinutes: DEFAULT_PROVISION_TIMEOUT_MINUTES,
    });
  });

  it("reads timeout, inactivityTimeout, and provisionTimeout", () => {
    expect(
      parseAgentTimeouts(
        JSON.stringify({
          timeout: 90,
          inactivityTimeout: 10,
          provisionTimeout: 5,
        })
      )
    ).toEqual({
      timeoutMinutes: 90,
      inactivityMinutes: 10,
      provisionTimeoutMinutes: 5,
    });
  });
});

describe("progressIsStale", () => {
  const now = Date.parse("2026-09-16T16:00:00.000Z");

  it("uses createdAt when lastProgressAt is missing", () => {
    expect(
      progressIsStale({
        now,
        createdAt: "2026-09-16T15:30:00.000Z",
        lastProgressAt: null,
        inactivityMinutes: 20,
      })
    ).toBe(true);
    expect(
      progressIsStale({
        now,
        createdAt: "2026-09-16T15:50:00.000Z",
        lastProgressAt: null,
        inactivityMinutes: 20,
      })
    ).toBe(false);
  });

  it("prefers lastProgressAt", () => {
    expect(
      progressIsStale({
        now,
        createdAt: "2026-09-16T12:00:00.000Z",
        lastProgressAt: "2026-09-16T15:50:00.000Z",
        inactivityMinutes: 20,
      })
    ).toBe(false);
  });
});

describe("hashAgentState", () => {
  it("changes when provider payload changes", () => {
    expect(hashAgentState({ a: 1 })).not.toBe(hashAgentState({ a: 2 }));
  });
});

describe("ingestFailedAgentSession", () => {
  it("files a deduped support ticket for a failed provider session", async () => {
    const db = createD1(env.D1);
    const userId = "user-sweep-ingest";
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: userId,
        name: "Sweep User",
        email: `${userId}@example.com`,
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, userId);
    const workspace = await createWorkspace(db, env, headers, {
      name: "Sweep ingest",
      slug: `sweep-${crypto.randomUUID()}`,
      key: `S${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      ownerId: userId,
    });
    const organizationId = workspace!.id;

    const session = {
      id: "sess-fail-1",
      organizationId,
      issueId: "issue-1",
      agentId: "cursor-cli",
      provider: "cursor-cli",
      actorId: userId,
      actorType: "user" as const,
      status: "failed" as const,
      result: null,
      url: null,
      providerSessionId: "prov-1",
      prUrl: null,
      prState: null,
      branch: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastProgressAt: null,
      lastStateHash: null,
      retryOf: null,
      retryCount: 0,
      infraFailure: 0,
      startedAt: null,
      queuedAfter: null,
      parentSessionId: null,
      spawnDepth: 0,
      laneDbRef: null,
      purpose: null,
      endedAt: null,
      maxDurationMinutes: null,
      effort: null,
      label: null,
      resultSchema: null,
      structuredResult: null,
      resultSchemaErrors: null,
      lastReviewedSha: null,
      reviewSummary: null,
    };
    const polled = {
      id: "prov-1",
      agentId: "cursor-cli",
      status: "failed" as const,
      result:
        "Agent exited: Bearer abc123 secret leaked Authorization: Bearer tok",
      providerSessionId: "prov-1",
    };

    await ingestFailedAgentSession(env, organizationId, session, polled);
    const tickets = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.organizationId, organizationId));
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.externalId).toBe("agent-session-sess-fail-1");
    expect(tickets[0]!.title).toContain("cursor-cli");

    // Idempotent: same session failure must not open a second ticket.
    await ingestFailedAgentSession(env, organizationId, session, polled);
    const after = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.organizationId, organizationId));
    expect(after).toHaveLength(1);
  });
});

describe("reviewRequestsChanges", () => {
  it("treats changes requested and substantive comment reviews as non-approving", () => {
    expect(reviewRequestsChanges("CHANGES_REQUESTED", "")).toBe(true);
    expect(reviewRequestsChanges("COMMENTED", "nit: rename")).toBe(true);
    expect(reviewRequestsChanges("COMMENTED", "")).toBe(false);
    expect(reviewRequestsChanges("APPROVED", "lgtm, one nit")).toBe(false);
    expect(reviewRequestsChanges("DISMISSED", "")).toBe(false);
  });
});

function reviewThreadFixture(
  id: string,
  over: {
    reviewId?: number | null;
    commentId?: number | null;
    commit?: string;
    isResolved?: boolean;
  } = {}
) {
  return {
    id,
    isResolved: over.isResolved ?? false,
    comments: {
      nodes: [
        {
          databaseId: over.commentId ?? null,
          originalCommit: { oid: over.commit ?? "old" },
          pullRequestReview:
            over.reviewId === null ? null : { databaseId: over.reviewId ?? 1 },
        },
      ],
    },
  };
}

describe("addressedReviewThreads", () => {
  const base = {
    deliveries: new Map([
      ["review-1", 1_000],
      ["comment-77", 1_000],
    ]),
    headSha: "new",
    headCommittedAt: 2_000,
    alreadyResolved: new Set<string>(),
  };

  it("resolves delivered threads the head commit has moved past", () => {
    expect(
      addressedReviewThreads({
        ...base,
        threads: [
          reviewThreadFixture("by-review"),
          reviewThreadFixture("by-comment", { reviewId: 9, commentId: 77 }),
          reviewThreadFixture("undelivered", { reviewId: 2 }),
          reviewThreadFixture("open-on-head", { commit: "new" }),
          reviewThreadFixture("resolved", { isResolved: true }),
        ],
      })
    ).toEqual(["by-review", "by-comment"]);
  });

  it("waits for a push after delivery and never re-resolves a thread", () => {
    expect(
      addressedReviewThreads({
        ...base,
        headCommittedAt: 500,
        threads: [reviewThreadFixture("early")],
      })
    ).toEqual([]);
    expect(
      addressedReviewThreads({
        ...base,
        alreadyResolved: new Set(["reopened"]),
        threads: [reviewThreadFixture("reopened")],
      })
    ).toEqual([]);
  });
});

describe("prStateFromPull", () => {
  it("maps GitHub pull fields to PR state", () => {
    expect(prStateFromPull({ merged_at: "2026-09-28T18:00:00Z" })).toBe(
      "merged"
    );
    expect(prStateFromPull({ state: "closed", merged_at: null })).toBe(
      "closed"
    );
    expect(prStateFromPull({ state: "open", draft: true })).toBe("draft");
    expect(prStateFromPull({ state: "open", draft: false })).toBe("open");
  });
});

describe("summarizeCheckRuns", () => {
  it("maps check-run sets to an aggregate state", () => {
    expect(summarizeCheckRuns(undefined)).toBeNull();
    expect(summarizeCheckRuns([])).toBeNull();
    expect(
      summarizeCheckRuns([{ status: "completed", conclusion: "success" }])
    ).toBe("passing");
    expect(
      summarizeCheckRuns([
        { status: "completed", conclusion: "success" },
        { status: "in_progress", conclusion: null },
      ])
    ).toBe("pending");
    expect(
      summarizeCheckRuns([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
      ])
    ).toBe("failing");
  });
});

describe("shouldUpdatePrBranch", () => {
  const base = {
    state: "open",
    mergeable: true,
    mergeableState: "behind",
    checkState: "passing" as string | null,
    headRef: "issue-abc",
    managedRefs: ["issue-abc", null] as (string | null)[],
  };

  it("updates a managed lane branch that is behind with no conflicts", () => {
    expect(shouldUpdatePrBranch(base)).toBe(true);
    expect(shouldUpdatePrBranch({ ...base, checkState: "pending" })).toBe(true);
    expect(shouldUpdatePrBranch({ ...base, checkState: null })).toBe(true);
    // mergeable null = GitHub still computing; expected_head_sha guards.
    expect(shouldUpdatePrBranch({ ...base, mergeable: null })).toBe(true);
    expect(shouldUpdatePrBranch({ ...base, headRef: "lane-x" })).toBe(false);
    expect(
      shouldUpdatePrBranch({
        ...base,
        headRef: "lane-x",
        managedRefs: ["issue-abc", "lane-x"],
      })
    ).toBe(true);
  });

  it("skips conflicts, failing checks, non-open states, and unmanaged refs", () => {
    expect(shouldUpdatePrBranch({ ...base, mergeable: false })).toBe(false);
    expect(shouldUpdatePrBranch({ ...base, mergeableState: "dirty" })).toBe(
      false
    );
    expect(shouldUpdatePrBranch({ ...base, mergeableState: "clean" })).toBe(
      false
    );
    expect(shouldUpdatePrBranch({ ...base, checkState: "failing" })).toBe(
      false
    );
    expect(shouldUpdatePrBranch({ ...base, state: "draft" })).toBe(false);
    expect(shouldUpdatePrBranch({ ...base, state: "merged" })).toBe(false);
    expect(shouldUpdatePrBranch({ ...base, headRef: null })).toBe(false);
    expect(shouldUpdatePrBranch({ ...base, headRef: "fork/feature" })).toBe(
      false
    );
  });
});

function registerMock(
  agentId: string,
  options: ConstructorParameters<typeof MockAgentProvider>[1]
) {
  registerAgentProvider(agentId, () => new MockAgentProvider(agentId, options));
}

async function ghFetchStub(input: RequestInfo | URL) {
  const url = String(input);
  if (url.endsWith("/pulls/210")) {
    return new Response(
      JSON.stringify({
        state: "closed",
        merged_at: "2026-09-28T18:17:22Z",
        head: { sha: "abc123" },
      }),
      { status: 200 }
    );
  }
  if (url.includes("/commits/abc123/check-runs")) {
    return new Response(
      JSON.stringify({
        check_runs: [{ status: "completed", conclusion: "success" }],
      }),
      { status: 200 }
    );
  }
  return new Response("not found", { status: 404 });
}

async function ghFetchFailing(input: RequestInfo | URL) {
  const url = String(input);
  if (url.endsWith("/pulls/777")) {
    return new Response(
      JSON.stringify({
        state: "open",
        merged_at: null,
        head: { sha: "def456" },
      }),
      { status: 200 }
    );
  }
  if (url.includes("/commits/def456/check-runs")) {
    return new Response(
      JSON.stringify({
        check_runs: [
          {
            name: "typecheck",
            status: "completed",
            conclusion: "failure",
            details_url: "https://github.com/x/runs/1",
          },
          { name: "lint", status: "completed", conclusion: "success" },
        ],
      }),
      { status: 200 }
    );
  }
  return new Response("not found", { status: 404 });
}

function ghFetchFailingPr(num: number, sha: string) {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(`/pulls/${num}`)) {
      return new Response(
        JSON.stringify({ state: "open", merged_at: null, head: { sha } }),
        { status: 200 }
      );
    }
    if (url.includes(`/commits/${sha}/check-runs`)) {
      return new Response(
        JSON.stringify({
          check_runs: [
            { name: "typecheck", status: "completed", conclusion: "failure" },
          ],
        }),
        { status: 200 }
      );
    }
    return new Response("not found", { status: 404 });
  };
}

async function ghFetchConflict(input: RequestInfo | URL) {
  const url = String(input);
  if (url.endsWith("/pulls/888")) {
    return new Response(
      JSON.stringify({
        state: "open",
        merged_at: null,
        mergeable: false,
        head: { sha: "fff999" },
      }),
      { status: 200 }
    );
  }
  if (url.includes("/commits/fff999/check-runs")) {
    return new Response(
      JSON.stringify({
        check_runs: [{ status: "completed", conclusion: "success" }],
      }),
      { status: 200 }
    );
  }
  return new Response("not found", { status: 404 });
}

// PILE-251 fixtures: PR 890 conflicts only on files the repo declares as
// generated; PR 891 conflicts on a real source file too.
const GENERATED_CONFLICT_FILES = [
  "src/mcp/openapi.json",
  "src/mcp/mcp-tools.ts",
];
const PILE_CONFIG_B64 = btoa(
  JSON.stringify({
    conflict: {
      generated: GENERATED_CONFLICT_FILES,
      regen: "pnpm regen",
    },
  })
);

function ghFetchDeterministicConflict(
  pullNumber: number,
  headSha: string,
  headSideFiles: string[],
  baseSideFiles: string[]
) {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(`/pulls/${pullNumber}`)) {
      return new Response(
        JSON.stringify({
          state: "open",
          merged_at: null,
          mergeable: false,
          head: {
            sha: headSha,
            ref: "issue-x",
            repo: { full_name: "vortexnyc/pile" },
          },
          base: { ref: "main", sha: "mainold" },
        }),
        { status: 200 }
      );
    }
    if (url.includes(`/commits/${headSha}/check-runs`)) {
      return new Response(
        JSON.stringify({
          check_runs: [{ status: "completed", conclusion: "success" }],
        }),
        { status: 200 }
      );
    }
    if (url.includes("/contents/.pile/config.json")) {
      return new Response(
        JSON.stringify({ content: PILE_CONFIG_B64, encoding: "base64" }),
        { status: 200 }
      );
    }
    if (url.includes("/branches/")) {
      return new Response(JSON.stringify({ commit: { sha: "basetip" } }), {
        status: 200,
      });
    }
    if (url.includes(`/compare/basetip...${headSha}`)) {
      return new Response(
        JSON.stringify({
          merge_base_commit: { sha: "mb" },
          files: headSideFiles.map((filename) => ({ filename })),
        }),
        { status: 200 }
      );
    }
    if (url.includes(`/compare/${headSha}...basetip`)) {
      return new Response(
        JSON.stringify({
          merge_base_commit: { sha: "mb" },
          files: baseSideFiles.map((filename) => ({ filename })),
        }),
        { status: 200 }
      );
    }
    return new Response("not found", { status: 404 });
  };
}

function fakeComputeBackend(opts: {
  state?: "pending" | "running" | { exitCode: number };
  resultFile?: string | null;
  gone?: boolean;
  started?: string[];
}) {
  const started = opts.started ?? [];
  return {
    kind: "cloudflare" as const,
    createSandbox: async (o: { name: string }) => ({
      id: o.name,
      name: o.name,
      state: "started",
    }),
    findSandbox: async (sessionId: string, name: string) =>
      opts.gone ? null : { id: name, name, state: "started" },
    startRunner: async (
      _sandbox: unknown,
      processId: string,
      command: string
    ) => {
      started.push(`${processId}:${command.slice(0, 40)}`);
    },
    runnerState: async () => opts.state ?? "running",
    readFile: async () => opts.resultFile ?? null,
    writeFile: async () => {},
    deleteSandbox: async () => {},
    health: async () => ({ ok: true }),
  };
}

describe("sweepAgentSessions", () => {
  const userId = "user-sweep-loop";
  let organizationId = "";
  let stub: ReturnType<typeof env.WORKSPACE_DURABLE_OBJECT.get>;

  beforeAll(async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: userId,
        name: "Sweep Loop",
        email: `${userId}@example.com`,
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, userId);
    const workspace = await createWorkspace(db, env, headers, {
      name: "Sweep loop",
      slug: `sweep-loop-${crypto.randomUUID()}`,
      key: `SL${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      ownerId: userId,
    });
    organizationId = workspace!.id;
    stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
  });

  it("stamps startedAt when a session first reports running", async () => {
    const agentId = `mock-run-${crypto.randomUUID().slice(0, 8)}`;
    registerMock(agentId, {
      poll: (id) => ({ id, agentId, status: "running" }),
    });
    const issue = await stub.createIssue({ title: "startedAt stamp" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "created",
    });

    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    const after = await stub.getAgentSession(session.id);
    expect(after?.status).toBe("running");
    expect(after?.startedAt).not.toBeNull();
  });

  it("fails a session stuck in created past the provision cap and retries once", async () => {
    const agentId = `mock-prov-${crypto.randomUUID().slice(0, 8)}`;
    registerMock(agentId, {
      dispatch: () => ({ id: "retried", agentId, status: "created" }),
      poll: (id) => ({ id, agentId, status: "created" }),
    });
    await stub.upsertAgentProviderConfig({
      agentId,
      config: { provisionTimeout: 0 },
    });
    const issue = await stub.createIssue({ title: "Provision stall" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "created",
    });

    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    const after = await stub.getAgentSession(session.id);
    expect(after?.status).toBe("failed");
    expect(after?.result).toContain("provision timed out");

    const siblings = await stub.listAgentSessions({ issueId: issue.id });
    const retried = siblings.find((s) => s.retryOf === session.id);
    expect(retried).toBeDefined();
    expect(retried?.retryCount).toBe(1);
  });

  it("redispatches once when the runner reports an infra (transport) failure", async () => {
    const agentId = `mock-infra-${crypto.randomUUID().slice(0, 8)}`;
    let dispatches = 0;
    registerMock(agentId, {
      dispatch: () => {
        dispatches += 1;
        return { id: `retried-${dispatches}`, agentId, status: "created" };
      },
      // git push exit 128 — the lane's work was fine, the transport died.
      poll: (id) => ({
        id,
        agentId,
        status: "failed" as const,
        result: "Command failed: git push returned 128",
        infraFailure: true,
      }),
    });
    const issue = await stub.createIssue({ title: "Transport flake" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
    });

    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    const after = await stub.getAgentSession(session.id);
    expect(after?.status).toBe("failed");
    expect(after?.infraFailure).toBe(1);
    expect(dispatches).toBe(1);
    const retried = (await stub.listAgentSessions({ issueId: issue.id })).find(
      (s) => s.retryOf === session.id
    );
    expect(retried).toBeDefined();
    expect(retried?.retryCount).toBe(1);

    // The retried lane hits the same transport failure — retryCount caps the
    // churn at one redispatch, no third session is created.
    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });
    expect(dispatches).toBe(1);
    const retriedAfter = await stub.getAgentSession(retried!.id);
    expect(retriedAfter?.status).toBe("failed");
    expect(retriedAfter?.infraFailure).toBe(1);
  });

  it("does not retry a provider-reported task failure", async () => {
    const agentId = `mock-task-${crypto.randomUUID().slice(0, 8)}`;
    let dispatches = 0;
    registerMock(agentId, {
      dispatch: () => {
        dispatches += 1;
        return { id: "never", agentId, status: "created" };
      },
      poll: (id) => ({
        id,
        agentId,
        status: "failed" as const,
        result: "agent reported the change could not be made",
      }),
    });
    const issue = await stub.createIssue({ title: "Real task failure" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
    });

    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    const after = await stub.getAgentSession(session.id);
    expect(after?.status).toBe("failed");
    expect(after?.infraFailure).toBe(0);
    expect(dispatches).toBe(0);
    const siblings = await stub.listAgentSessions({ issueId: issue.id });
    expect(siblings.find((s) => s.retryOf === session.id)).toBeUndefined();

    // Task failures still annotate the issue — no auto-retry, but no
    // silence either (PILE-268).
    const comments = await stub.listComments(issue.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("failed");
    expect(comments[0]?.body).toContain("could not be made");
  });

  it("annotates the issue and redispatches once when a lane stalls out", async () => {
    const agentId = `mock-stall-${crypto.randomUUID().slice(0, 8)}`;
    let dispatches = 0;
    const issue = await stub.createIssue({ title: "Stalled lane" });
    // 40m of dead air on a 20m inactivity window — the PILE-267 freeze.
    const stale = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
      url: "https://provider.example/run/1",
      createdAt: stale,
      startedAt: stale,
    });
    registerMock(agentId, {
      dispatch: () => {
        dispatches += 1;
        return { id: `retried-${dispatches}`, agentId, status: "created" };
      },
      // A frozen lane reports nothing new — the poll echoes the row's
      // stored state exactly so only the inactivity verdict can kill it.
      poll: (id) => ({
        id,
        agentId,
        status: "running" as const,
        result: null,
        url: id === session.id ? session.url : null,
        prUrl: null,
      }),
      // MockAgentProvider always exposes getState (null by default); a
      // null state hashes to "null", so seed that hash — otherwise the
      // first stale probe counts as fresh progress and survival.
      getState: () => null,
    });
    // Recording an activity bumps lastProgressAt, so seed it before
    // backdating the progress clock.
    await stub.addAgentActivity({
      sessionId: session.id,
      type: "thought",
      message: "cloning repo",
    });
    await stub.updateAgentSession(session.id, {
      lastProgressAt: stale,
      lastStateHash: "null",
    });

    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    const after = await stub.getAgentSession(session.id);
    expect(after?.status).toBe("canceled");
    expect(after?.infraFailure).toBe(1);

    // The death lands on the issue: outcome + reason + session pointer.
    const comments = await stub.listComments(issue.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("canceled");
    expect(comments[0]?.body).toContain("inactive");
    expect(comments[0]?.body).toContain(session.id);
    expect(comments[0]?.body).toContain("https://provider.example/run/1");
    // PILE-291 — the annotation carries where the lane died, not just
    // "stalled": phase timings + the last activity before the dead air.
    expect(comments[0]?.body).toContain("Hang report (inactive)");
    expect(comments[0]?.body).toContain(
      "last activity: [thought] cloning repo"
    );
    const hangEvents = (
      await stub.listAgentSessionEvents(session.id, { limit: 100 })
    ).filter((e) => e.type === "session.hang_report");
    expect(hangEvents).toHaveLength(1);
    const hangPayload: unknown = JSON.parse(hangEvents[0]?.payload ?? "null");
    expect(hangPayload).toMatchObject({
      report: {
        reason: "inactive",
        lastActivity: { type: "thought", message: "cloning repo" },
        phases: { silentMs: expect.any(Number), runningMs: expect.any(Number) },
      },
    });

    // Stall-class deaths get exactly one redispatch.
    const siblings = await stub.listAgentSessions({ issueId: issue.id });
    const retried = siblings.find((s) => s.retryOf === session.id);
    expect(retried).toBeDefined();
    expect(retried?.retryCount).toBe(1);
    expect(dispatches).toBe(1);

    // The retried lane stalls too — the guard caps churn at one redispatch.
    await stub.updateAgentSession(retried!.id, {
      status: "running",
      startedAt: stale,
      lastProgressAt: stale,
      lastStateHash: "null",
    });
    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    expect((await stub.getAgentSession(retried!.id))?.status).toBe("canceled");
    expect(dispatches).toBe(1);
    const all = await stub.listAgentSessions({ issueId: issue.id });
    expect(all.find((s) => s.retryOf === retried!.id)).toBeUndefined();
    // Two lanes died, each annotated.
    expect(await stub.listComments(issue.id)).toHaveLength(2);
  });

  it("annotates and retries a lane the provider reported canceled", async () => {
    const agentId = `mock-pc-${crypto.randomUUID().slice(0, 8)}`;
    registerMock(agentId, {
      dispatch: () => ({ id: "retry-1", agentId, status: "created" }),
      poll: (id) => ({
        id,
        agentId,
        status: "canceled" as const,
        result: "runner terminated",
      }),
    });
    const issue = await stub.createIssue({ title: "Provider canceled" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
    });

    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    const after = await stub.getAgentSession(session.id);
    expect(after?.status).toBe("canceled");
    expect(after?.infraFailure).toBe(1);
    const comments = await stub.listComments(issue.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("canceled");
    expect(comments[0]?.body).toContain("runner terminated");
    const retried = (await stub.listAgentSessions({ issueId: issue.id })).find(
      (s) => s.retryOf === session.id
    );
    expect(retried).toBeDefined();
    expect(retried?.retryCount).toBe(1);
  });

  it("emits an elicitation when a running lane transitions to waiting", async () => {
    const agentId = `mock-block-${crypto.randomUUID().slice(0, 8)}`;
    registerMock(agentId, {
      poll: (id) => ({
        id,
        agentId,
        status: "waiting",
        result: "waiting_for_user",
      }),
    });
    const issue = await stub.createIssue({ title: "Blocked lane" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
    });

    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    const events = await stub.listAgentSessionEvents(session.id, {
      limit: 100,
    });
    expect(events.some((e) => e.type === "session.needs_input")).toBe(true);

    // Deduped: a second sweep still waiting must not re-elicit.
    await stub.applyAgentSessionResult(session.id, { status: "waiting" });
    const count = (
      await stub.listAgentSessionEvents(session.id, { limit: 100 })
    ).filter((e) => e.type === "session.needs_input").length;
    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });
    expect(
      (await stub.listAgentSessionEvents(session.id, { limit: 100 })).filter(
        (e) => e.type === "session.needs_input"
      ).length
    ).toBe(count);
  });

  it("carries the provider's question text into the elicitation", async () => {
    const agentId = `mock-elicit-${crypto.randomUUID().slice(0, 8)}`;
    registerMock(agentId, {
      poll: (id) => ({
        id,
        agentId,
        status: "waiting",
        result: "waiting_for_user",
      }),
      latestElicitation: () =>
        "Which environment should I deploy to — staging or prod?",
    });
    const issue = await stub.createIssue({ title: "Question lane" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
    });

    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    const events = await stub.listAgentSessionEvents(session.id, {
      limit: 100,
    });
    const needsInput = events.find((e) => e.type === "session.needs_input");
    expect(needsInput?.message).toBe(
      "Which environment should I deploy to — staging or prod?"
    );
  });

  it("measures the run clock from startedAt, not createdAt", async () => {
    const agentId = `mock-clock-${crypto.randomUUID().slice(0, 8)}`;
    registerMock(agentId, {
      poll: (id) => ({ id, agentId, status: "running" }),
    });
    const issue = await stub.createIssue({ title: "Run clock" });
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

    // Queued for 2h but only running for seconds — under the 60m cap.
    const queuedThenStarted = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
      createdAt: twoHoursAgo,
      startedAt: new Date().toISOString(),
    });
    // Running since creation 2h ago — over the 60m default cap.
    const longRunning = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
      createdAt: twoHoursAgo,
      startedAt: twoHoursAgo,
    });

    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    expect((await stub.getAgentSession(queuedThenStarted.id))?.status).toBe(
      "running"
    );
    expect((await stub.getAgentSession(longRunning.id))?.status).toBe(
      "canceled"
    );
  });

  it("a hung provider poll does not stall the sweep for other sessions", async () => {
    const hungAgent = `mock-hung-${crypto.randomUUID().slice(0, 8)}`;
    const okAgent = `mock-ok-${crypto.randomUUID().slice(0, 8)}`;
    registerMock(hungAgent, {
      poll: () => new Promise<never>(() => {}),
    });
    registerMock(okAgent, {
      poll: (id) => ({ id, agentId: okAgent, status: "running" }),
    });
    const issue = await stub.createIssue({ title: "Hung probe" });
    // Newer createdAt sorts first — the hung session is probed first.
    const hung = await stub.createAgentSession({
      issueId: issue.id,
      agentId: hungAgent,
      provider: hungAgent,
      actorId: userId,
      actorType: "user",
      status: "created",
      createdAt: new Date().toISOString(),
    });
    const healthy = await stub.createAgentSession({
      issueId: issue.id,
      agentId: okAgent,
      provider: okAgent,
      actorId: userId,
      actorType: "user",
      status: "created",
      createdAt: new Date(Date.now() - 1000).toISOString(),
    });

    // 10ms probe cap: the hung poll times out almost immediately.
    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    // The hung lane is untouched — no verdict without data.
    expect((await stub.getAgentSession(hung.id))?.status).toBe("created");
    // And the lane behind it still got polled this sweep.
    const healthyAfter = await stub.getAgentSession(healthy.id);
    expect(healthyAfter?.status).toBe("running");
    expect(healthyAfter?.startedAt).not.toBeNull();
  });

  it("captures telemetry via getState once progress goes stale", async () => {
    const agentId = `mock-state-${crypto.randomUUID().slice(0, 8)}`;
    registerMock(agentId, {
      poll: (id) => ({ id, agentId, status: "running" }),
      getState: () => ({
        provider: { state: "running", logs: "grinding" },
        compute: { lastSeen: new Date().toISOString() },
      }),
    });
    await stub.upsertAgentProviderConfig({
      agentId,
      config: { inactivityTimeout: 30 },
    });
    const issue = await stub.createIssue({ title: "Telemetry" });
    const staleCreated = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
      createdAt: staleCreated,
      startedAt: staleCreated,
    });

    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    const after = await stub.getAgentSession(session.id);
    expect(after?.status).toBe("running");
    expect(after?.lastStateHash).not.toBeNull();
    expect(after?.lastProgressAt).not.toBeNull();
  });

  it("self-heals terminal sessions missing endedAt — including reaped rows", async () => {
    const issue = await stub.createIssue({ title: "endedAt heal" });
    // PILE-238 population: a terminal row whose write path skipped endedAt.
    const unhealed = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock-endedat",
      provider: "mock-endedat",
      actorId: userId,
      actorType: "user",
      status: "completed",
    });
    // PILE-254 population: the reaped marker written while endedAt was
    // still null. The old check order skipped the heal for these rows, so
    // fleet-health's missingEndedAt never drained.
    const reaped = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock-endedat",
      provider: "mock-endedat",
      actorId: userId,
      actorType: "user",
      status: "failed",
    });
    await stub.updateAgentSession(reaped.id, { lastStateHash: "reaped" });

    expect((await stub.getAgentSession(unhealed.id))?.endedAt).toBeNull();
    expect((await stub.getAgentSession(reaped.id))?.endedAt).toBeNull();

    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    expect((await stub.getAgentSession(unhealed.id))?.endedAt).not.toBeNull();
    const reapedAfter = await stub.getAgentSession(reaped.id);
    expect(reapedAfter?.endedAt).not.toBeNull();
    // The heal backfills the anchor without clearing the marker — a reaped
    // row must not re-enter the teardown/reap path on later passes.
    expect(reapedAfter?.lastStateHash).toBe("reaped");
  });

  it("reaps the oldest kept sandboxes beyond the per-provider cap", async () => {
    const agentId = `mock-keep-${crypto.randomUUID().slice(0, 8)}`;
    const canceled: string[] = [];
    registerMock(agentId, {
      keepsTerminalSandbox: true,
      cancel: (id) => {
        canceled.push(id);
      },
    });
    const issue = await stub.createIssue({ title: "Kept-sandbox cap" });
    // Eight terminal sessions still inside the resume window — the cap of
    // five keeps the newest, so the oldest three must be reaped.
    const oldestFirst: string[] = [];
    for (let i = 0; i < 8; i++) {
      const session = await stub.createAgentSession({
        issueId: issue.id,
        agentId,
        provider: agentId,
        actorId: userId,
        actorType: "user",
        status: "completed",
      });
      await stub.updateAgentSession(session.id, {
        endedAt: new Date(Date.now() - (8 - i) * 60_000).toISOString(),
      });
      oldestFirst.push(session.id);
    }

    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    const rows = await stub.listAgentSessions({ issueId: issue.id });
    const beyondCap = oldestFirst.slice(0, 3).toSorted();
    expect(
      rows
        .filter((r) => r.lastStateHash === "reaped")
        .map((r) => r.id)
        .toSorted()
    ).toEqual(beyondCap);
    expect(canceled.toSorted()).toEqual(beyondCap);
    expect(rows.filter((r) => r.lastStateHash !== "reaped")).toHaveLength(5);
  });

  it("does not count terminal sessions on providers that drop their sandbox", async () => {
    const agentId = `mock-drop-${crypto.randomUUID().slice(0, 8)}`;
    const canceled: string[] = [];
    registerMock(agentId, {
      cancel: (id) => {
        canceled.push(id);
      },
    });
    const issue = await stub.createIssue({ title: "No kept sandboxes" });
    // Past the cap but this provider deletes its sandbox at terminal —
    // there is nothing kept to bound, so nothing gets force-reaped.
    for (let i = 0; i < 8; i++) {
      const session = await stub.createAgentSession({
        issueId: issue.id,
        agentId,
        provider: agentId,
        actorId: userId,
        actorType: "user",
        status: "completed",
      });
      await stub.updateAgentSession(session.id, {
        endedAt: new Date(Date.now() - (8 - i) * 60_000).toISOString(),
      });
    }

    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    const rows = await stub.listAgentSessions({ issueId: issue.id });
    expect(canceled).toHaveLength(0);
    expect(rows.every((r) => r.lastStateHash !== "reaped")).toBe(true);
  });

  it("cancels and escalates a lane past its maxDuration without retrying", async () => {
    const agentId = `mock-budget-${crypto.randomUUID().slice(0, 8)}`;
    registerMock(agentId, {
      dispatch: () => ({ id: "retried", agentId, status: "created" }),
      poll: (id) => ({ id, agentId, status: "running" }),
    });
    const issue = await stub.createIssue({ title: "Budgeted lane" });
    const thirtyMinutesAgo = new Date(
      Date.now() - 30 * 60 * 1000
    ).toISOString();
    // Under the 60m provider default, but over its own 10m budget.
    const overBudget = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
      createdAt: thirtyMinutesAgo,
      startedAt: thirtyMinutesAgo,
      maxDurationMinutes: 10,
      effort: "low",
    });

    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    const after = await stub.getAgentSession(overBudget.id);
    expect(after?.status).toBe("canceled");
    expect(after?.result).toContain("run budget exhausted after 10m");
    expect(after?.infraFailure).toBe(0);

    const siblings = await stub.listAgentSessions({ issueId: issue.id });
    expect(siblings.some((s) => s.retryOf === overBudget.id)).toBe(false);

    const comments = await stub.listComments(issue.id);
    expect(
      comments.some(
        (c) =>
          c.externalSource === "budget" && c.body.includes("10m run budget")
      )
    ).toBe(true);
    const events = await stub.listAgentSessionEvents(overBudget.id, {
      limit: 50,
      order: "desc",
    });
    expect(
      events.some(
        (e) =>
          e.type === "issue.escalated" &&
          String(e.payload).includes("max_duration")
      )
    ).toBe(true);
    expect((await stub.getIssue(issue.id))?.status).toBe("triage");
  });

  it("lets a lane with a larger maxDuration outlive the provider timeout", async () => {
    const agentId = `mock-budget-long-${crypto.randomUUID().slice(0, 8)}`;
    registerMock(agentId, {
      poll: (id) => ({ id, agentId, status: "running", result: "working" }),
    });
    const issue = await stub.createIssue({ title: "Long budget" });
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
      createdAt: twoHoursAgo,
      startedAt: twoHoursAgo,
      maxDurationMinutes: 240,
    });

    await sweepAgentSessions(env, undefined, { probeTimeoutMs: 10 });

    expect((await stub.getAgentSession(session.id))?.status).toBe("running");
  });
});

describe("syncOpenPrSessions", () => {
  const userId = "user-sweep-prs";
  let organizationId = "";
  let stub: ReturnType<typeof env.WORKSPACE_DURABLE_OBJECT.get>;

  beforeAll(async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: userId,
        name: "Sweep PRs",
        email: `${userId}@example.com`,
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, userId);
    const workspace = await createWorkspace(db, env, headers, {
      name: "Sweep PR sync",
      slug: `sweep-prs-${crypto.randomUUID()}`,
      key: `SP${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      ownerId: userId,
    });
    organizationId = workspace!.id;
    stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
  });

  it("reconciles a merged PR into session + issue state", async () => {
    const issue = await stub.createIssue({ title: "PR reconcile" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock-prs",
      provider: "mock-prs",
      actorId: userId,
      actorType: "user",
      status: "completed",
      prUrl: "https://github.com/vortexnyc/pile/pull/210",
      prState: "open",
    });

    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: ghFetchStub as typeof fetch,
    });

    const sessionAfter = await stub.getAgentSession(session.id);
    expect(sessionAfter?.prState).toBe("merged");
    const issueAfter = await stub.getIssue(issue.id);
    expect(issueAfter?.prState).toBe("merged");
    expect(issueAfter?.prCheckState).toBe("passing");
    expect(issueAfter?.status).toBe("done");
  });

  it("does not reopen a terminal issue when its PR merges", async () => {
    const issue = await stub.createIssue({ title: "Canceled with PR" });
    await stub.updateIssue(issue.id, { status: "canceled" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock-prs",
      provider: "mock-prs",
      actorId: userId,
      actorType: "user",
      status: "completed",
      prUrl: "https://github.com/vortexnyc/pile/pull/210",
      prState: "open",
    });

    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: ghFetchStub as typeof fetch,
    });

    expect((await stub.getAgentSession(session.id))?.prState).toBe("merged");
    const issueAfter = await stub.getIssue(issue.id);
    expect(issueAfter?.prState).toBe("merged");
    expect(issueAfter?.status).toBe("canceled");
  });

  it("nudges a running lane with failing check names when CI flips to failing", async () => {
    const agentId = `mock-ci-${crypto.randomUUID().slice(0, 8)}`;
    const prompts: string[] = [];
    registerMock(agentId, {
      sendPrompt: async (_id, prompt) => {
        prompts.push(prompt);
        return true;
      },
    });
    const issue = await stub.createIssue({ title: "CI fail nudge" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
      prUrl: "https://github.com/vortexnyc/pile/pull/777",
      prState: "open",
    });

    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: ghFetchFailing as typeof fetch,
    });

    const issueAfter = await stub.getIssue(issue.id);
    expect(issueAfter?.prCheckState).toBe("failing");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("typecheck");
    expect(prompts[0]).not.toContain("lint (");
    const events = await stub.listAgentSessionEvents(session.id, {});
    const types = events.map((e) => e.type);
    expect(types).toContain("pr.ci_failed");
    expect(types).toContain("prompt.followup");

    // A second sweep with the same failing state must not re-nudge.
    prompts.length = 0;
    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: ghFetchFailing as typeof fetch,
    });
    expect(prompts).toHaveLength(0);
  });

  it("nudges a running lane to rebase when its PR is conflicting", async () => {
    const agentId = `mock-conflict-${crypto.randomUUID().slice(0, 8)}`;
    const prompts: string[] = [];
    registerMock(agentId, {
      sendPrompt: async (_id, prompt) => {
        prompts.push(prompt);
        return true;
      },
    });
    const issue = await stub.createIssue({ title: "Conflicted lane" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
      prUrl: "https://github.com/vortexnyc/pile/pull/888",
      prState: "open",
    });

    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: ghFetchConflict as typeof fetch,
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("merge conflicts");
    const events = await stub.listAgentSessionEvents(session.id, {});
    const types = events.map((e) => e.type);
    expect(types).toContain("pr.conflict");
    expect(types).toContain("prompt.followup");

    // Deduped per headSha: a second sweep on the same conflict must not re-nudge.
    prompts.length = 0;
    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: ghFetchConflict as typeof fetch,
    });
    expect(prompts).toHaveLength(0);
  });

  it("resolves a generated-only conflict with the scripted fixer, no lane", async () => {
    const agentId = `mock-genfix-${crypto.randomUUID().slice(0, 8)}`;
    const prompts: string[] = [];
    const dispatches: string[] = [];
    registerMock(agentId, {
      dispatch: (_org, issue) => {
        dispatches.push(issue.id);
        return { id: "dispatched", agentId, status: "created" };
      },
      sendPrompt: async (_id, prompt) => {
        prompts.push(prompt);
        return true;
      },
    });
    const issue = await stub.createIssue({ title: "Generated conflict" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
      prUrl: "https://github.com/vortexnyc/pile/pull/890",
      prState: "open",
    });
    const fetchGen = ghFetchDeterministicConflict(
      890,
      "gen1",
      [...GENERATED_CONFLICT_FILES, "README.md"],
      [...GENERATED_CONFLICT_FILES, "package.json"]
    );
    const started: string[] = [];
    // Phase 1: fixer launches. Phase 2: process exited with a resolved result.
    let phase: "running" | "done" = "running";
    const compute = () =>
      fakeComputeBackend(
        phase === "done"
          ? {
              state: { exitCode: 0 },
              resultFile: JSON.stringify({ outcome: "resolved", detail: "" }),
            }
          : { state: "running", started }
      );

    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: fetchGen as typeof fetch,
      compute,
    });

    // No follow-up prompt, no new lane — the fixer sandbox owns the conflict.
    expect(prompts).toHaveLength(0);
    expect(dispatches).toHaveLength(0);
    expect(started.some((c) => c.startsWith(`fix-${session.id}`))).toBe(true);
    const events = await stub.listAgentSessionEvents(session.id, {});
    const fixStarted = events.find(
      (e) => e.type === "pr.conflict_fix" && e.payload?.includes('"started"')
    );
    expect(fixStarted).toBeDefined();

    // Fixer finishes on a later sweep — resolved is recorded, still no nudge.
    phase = "done";
    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: fetchGen as typeof fetch,
      compute,
    });
    const after = await stub.listAgentSessionEvents(session.id, {});
    const resolved = after.find(
      (e) => e.type === "pr.conflict_fix" && e.payload?.includes('"resolved"')
    );
    expect(resolved).toBeDefined();
    expect(prompts).toHaveLength(0);
  });

  it("nudges the lane when a real source file is in the conflict set", async () => {
    const agentId = `mock-srcfix-${crypto.randomUUID().slice(0, 8)}`;
    const prompts: string[] = [];
    registerMock(agentId, {
      sendPrompt: async (_id, prompt) => {
        prompts.push(prompt);
        return true;
      },
    });
    const issue = await stub.createIssue({ title: "Source conflict" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
      prUrl: "https://github.com/vortexnyc/pile/pull/891",
      prState: "open",
    });
    // Both sides touched a source file alongside the generated artifacts.
    const fetchSrc = ghFetchDeterministicConflict(
      891,
      "src2",
      ["src/mcp/openapi.json", "packages/cli/src/cli.ts"],
      ["src/mcp/openapi.json", "packages/cli/src/cli.ts"]
    );
    const compute = () => fakeComputeBackend({ state: "running" });

    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: fetchSrc as typeof fetch,
      compute,
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("merge conflicts");
    const events = await stub.listAgentSessionEvents(session.id, {});
    const types = events.map((e) => e.type);
    expect(types).toContain("pr.conflict");
    expect(types).toContain("pr.conflict_lane");
    expect(types).toContain("prompt.followup");
    expect(types).not.toContain("pr.conflict_fix");
  });

  // PILE-269 — conflicts on completed lanes' PRs must reach the lane even
  // when the stored prState isn't exactly "open".
  it("nudges a completed lane whose stored prState is not 'open'", async () => {
    const agentId = `mock-done-${crypto.randomUUID().slice(0, 8)}`;
    const prompts: string[] = [];
    registerMock(agentId, {
      sendPrompt: async (_id, prompt) => {
        prompts.push(prompt);
        return true;
      },
    });
    const issue = await stub.createIssue({ title: "Completed lane conflict" });
    const older = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "failed",
      prUrl: "https://github.com/vortexnyc/pile/pull/893",
      prState: "open",
    });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "completed",
      prUrl: "https://github.com/vortexnyc/pile/pull/893",
      prState: "draft",
    });
    const fetchSrc = ghFetchDeterministicConflict(
      893,
      "done1",
      ["packages/cli/src/cli.ts"],
      ["packages/cli/src/cli.ts"]
    );
    const deps = {
      tokenForRepo: async () => "gh-test-token",
      fetch: fetchSrc as typeof fetch,
      compute: () => fakeComputeBackend({ state: "running" }),
    };

    await syncOpenPrSessions(env, stub, organizationId, deps);
    await syncOpenPrSessions(env, stub, organizationId, deps);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("merge conflicts");
    const types = (await stub.listAgentSessionEvents(session.id, {})).map(
      (e) => e.type
    );
    expect(types.filter((t) => t === "pr.conflict")).toHaveLength(1);
    expect(types.filter((t) => t === "pr.conflict_lane")).toHaveLength(1);
    expect(types).toContain("prompt.followup");
    // One pass per PR: the older sibling sharing the prUrl isn't re-probed.
    const olderTypes = (await stub.listAgentSessionEvents(older.id, {})).map(
      (e) => e.type
    );
    expect(olderTypes).not.toContain("pr.conflict");
    expect((await stub.getAgentSession(session.id))?.status).toBe("running");
    expect((await stub.getAgentSession(session.id))?.prState).toBe("open");
  });

  it("redispatches a completed lane when its kept sandbox rejects the nudge", async () => {
    const agentId = `mock-gone-${crypto.randomUUID().slice(0, 8)}`;
    const instructions: Array<string | undefined> = [];
    registerMock(agentId, {
      sendPrompt: async () => false,
      dispatch: (_org, dispatchedIssue, _model, ctx) => {
        instructions.push(ctx?.instructions);
        return {
          id: `redispatched-${instructions.length}`,
          agentId,
          issueId: dispatchedIssue.id,
          status: "created",
        };
      },
    });
    const issue = await stub.createIssue({ title: "Reaped sandbox conflict" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "completed",
      prUrl: "https://github.com/vortexnyc/pile/pull/894",
      prState: "open",
    });
    const fetchSrc = ghFetchDeterministicConflict(
      894,
      "gone1",
      ["packages/cli/src/fleet.ts"],
      ["packages/cli/src/fleet.ts"]
    );

    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: fetchSrc as typeof fetch,
      compute: () => fakeComputeBackend({ state: "running" }),
    });

    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toContain("merge conflicts");
    const events = await stub.listAgentSessionEvents(session.id, {});
    const types = events.map((e) => e.type);
    expect(types).toContain("pr.conflict_lane");
    expect(types).toContain("prompt.followup_failed");
    expect(types).toContain("prompt.redispatch");
    const lanes = await stub.listAgentSessions({ issueId: issue.id });
    const fresh = lanes.find((l) => l.id !== session.id);
    expect(fresh?.retryOf).toBe(session.id);

    // The redispatch counts as delivery for this headSha — no second lane.
    await stub.applyAgentSessionResult(fresh?.id ?? "", {
      status: "completed",
    });
    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: fetchSrc as typeof fetch,
      compute: () => fakeComputeBackend({ state: "running" }),
    });
    expect(instructions).toHaveLength(1);
  });

  it("cold-dispatches a reaped completed lane without probing the sandbox", async () => {
    const agentId = `mock-reaped-${crypto.randomUUID().slice(0, 8)}`;
    let probes = 0;
    let dispatches = 0;
    registerMock(agentId, {
      sendPrompt: async () => {
        probes += 1;
        return true;
      },
      dispatch: (_org, dispatchedIssue) => {
        dispatches += 1;
        return {
          id: `reaped-redispatch-${dispatches}`,
          agentId,
          issueId: dispatchedIssue.id,
          status: "created",
        };
      },
    });
    const issue = await stub.createIssue({ title: "Reaped lane conflict" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "completed",
      prUrl: "https://github.com/vortexnyc/pile/pull/895",
      prState: "open",
    });
    await stub.updateAgentSession(session.id, { lastStateHash: "reaped" });
    const fetchSrc = ghFetchDeterministicConflict(
      895,
      "reaped1",
      ["packages/cli/src/cli.ts"],
      ["packages/cli/src/cli.ts"]
    );

    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: fetchSrc as typeof fetch,
      compute: () => fakeComputeBackend({ state: "running" }),
    });

    expect(probes).toBe(0);
    expect(dispatches).toBe(1);
    const types = (await stub.listAgentSessionEvents(session.id, {})).map(
      (e) => e.type
    );
    expect(types).toContain("prompt.redispatch");
    expect(types).not.toContain("prompt.followup_failed");
  });

  it("serves the most recent timeline window, not the first entries", async () => {
    const issue = await stub.createIssue({ title: "Long timeline" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock-timeline",
      provider: "mock-timeline",
      actorId: userId,
      actorType: "user",
      status: "completed",
    });
    for (let i = 0; i < 120; i += 1) {
      await stub.addAgentSessionEvent({
        sessionId: session.id,
        type: "pr.conflict",
        message: `e-${i}`,
        payload: {},
      });
    }
    const timeline = await stub.listAgentTimeline(session.id, { limit: 100 });
    const messages = timeline.map((row) => row.message);
    expect(timeline).toHaveLength(100);
    expect(messages).toContain("e-119");
    expect(messages).not.toContain("e-0");
  });

  it("falls back to the lane when the fixer reports source conflicts", async () => {
    const agentId = `mock-fixfail-${crypto.randomUUID().slice(0, 8)}`;
    const prompts: string[] = [];
    registerMock(agentId, {
      sendPrompt: async (_id, prompt) => {
        prompts.push(prompt);
        return true;
      },
    });
    const issue = await stub.createIssue({ title: "Fixer source conflict" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
      prUrl: "https://github.com/vortexnyc/pile/pull/892",
      prState: "open",
    });
    // Detection sees only generated candidates, but the real merge inside the
    // fixer finds a source file too (the candidates set is a superset check —
    // the script is the exact verdict).
    const fetchFix = ghFetchDeterministicConflict(
      892,
      "gen3",
      [...GENERATED_CONFLICT_FILES],
      [...GENERATED_CONFLICT_FILES]
    );
    let phase: "running" | "done" = "running";
    const compute = () =>
      fakeComputeBackend(
        phase === "done"
          ? {
              state: { exitCode: 0 },
              resultFile: JSON.stringify({
                outcome: "source_conflict",
                detail: " packages/cli/src/cli.ts",
              }),
            }
          : { state: "running" }
      );

    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: fetchFix as typeof fetch,
      compute,
    });
    expect(prompts).toHaveLength(0);

    phase = "done";
    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: fetchFix as typeof fetch,
      compute,
    });

    expect(prompts).toHaveLength(1);
    const events = await stub.listAgentSessionEvents(session.id, {});
    const types = events.map((e) => e.type);
    expect(types).toContain("pr.conflict_fix");
    expect(types).toContain("pr.conflict_lane");
    expect(types).toContain("prompt.followup");
  });

  it("update-branches a managed lane PR that is behind the base", async () => {
    const issue = await stub.createIssue({ title: "Behind lane" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock-prs",
      provider: "mock-prs",
      actorId: userId,
      actorType: "user",
      status: "completed",
      prUrl: "https://github.com/vortexnyc/pile/pull/555",
      prState: "open",
    });
    const updates: { url: string; body: string }[] = [];
    const fetchBehind = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = String(input);
      if (url.endsWith("/pulls/555/update-branch")) {
        updates.push({ url, body: String(init?.body) });
        return new Response("{}", { status: 202 });
      }
      if (url.endsWith("/pulls/555")) {
        return new Response(
          JSON.stringify({
            state: "open",
            merged_at: null,
            mergeable: true,
            mergeable_state: "behind",
            head: { sha: "behind111", ref: `issue-${issue.id}` },
          }),
          { status: 200 }
        );
      }
      if (url.includes("/commits/behind111/check-runs")) {
        return new Response(
          JSON.stringify({
            check_runs: [{ status: "completed", conclusion: "success" }],
          }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const deps = {
      tokenForRepo: async () => "gh-test-token",
      fetch: fetchBehind,
    };

    await syncOpenPrSessions(env, stub, organizationId, deps);

    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0]!.body).expected_head_sha).toBe("behind111");
    const events = await stub.listAgentSessionEvents(session.id, {});
    expect(events.some((e) => e.type === "pr.branch_update")).toBe(true);

    // Deduped per headSha: a second sweep on the same sha does not re-fire.
    await syncOpenPrSessions(env, stub, organizationId, deps);
    expect(updates).toHaveLength(1);
  });

  it("update-branches a PR on the issue's linked branch", async () => {
    const issue = await stub.createIssue({
      title: "Linked branch lane",
      branch: "lane-custom",
    });
    await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock-prs",
      provider: "mock-prs",
      actorId: userId,
      actorType: "user",
      status: "completed",
      prUrl: "https://github.com/vortexnyc/pile/pull/557",
      prState: "open",
    });
    const updates: string[] = [];
    const fetchBehind = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/pulls/557/update-branch")) {
        updates.push(url);
        return new Response("{}", { status: 202 });
      }
      if (url.endsWith("/pulls/557")) {
        return new Response(
          JSON.stringify({
            state: "open",
            merged_at: null,
            mergeable: true,
            mergeable_state: "behind",
            head: { sha: "behind222", ref: "lane-custom" },
          }),
          { status: 200 }
        );
      }
      if (url.includes("/commits/behind222/check-runs")) {
        return new Response(JSON.stringify({ check_runs: [] }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: fetchBehind,
    });

    expect(updates).toHaveLength(1);
  });

  it("does not update-branch a conflicting PR — pr.conflict owns it", async () => {
    const issue = await stub.createIssue({ title: "Conflicted behind lane" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock-prs",
      provider: "mock-prs",
      actorId: userId,
      actorType: "user",
      status: "completed",
      prUrl: "https://github.com/vortexnyc/pile/pull/556",
      prState: "open",
    });
    const updates: string[] = [];
    const fetchDirty = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/update-branch")) {
        updates.push(url);
        return new Response("{}", { status: 202 });
      }
      if (url.endsWith("/pulls/556")) {
        return new Response(
          JSON.stringify({
            state: "open",
            merged_at: null,
            mergeable: false,
            mergeable_state: "dirty",
            head: { sha: "conf111", ref: `issue-${issue.id}` },
          }),
          { status: 200 }
        );
      }
      if (url.includes("/commits/conf111/check-runs")) {
        return new Response(
          JSON.stringify({
            check_runs: [{ status: "completed", conclusion: "success" }],
          }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: fetchDirty,
    });

    expect(updates).toHaveLength(0);
    const events = await stub.listAgentSessionEvents(session.id, {});
    const types = events.map((e) => e.type);
    expect(types).toContain("pr.conflict");
    expect(types).not.toContain("pr.branch_update");
  });

  it("does not update-branch a PR on a branch the lane does not manage", async () => {
    const issue = await stub.createIssue({ title: "External head ref" });
    await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock-prs",
      provider: "mock-prs",
      actorId: userId,
      actorType: "user",
      status: "completed",
      prUrl: "https://github.com/vortexnyc/pile/pull/558",
      prState: "open",
    });
    const updates: string[] = [];
    const fetchForeign = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/update-branch")) {
        updates.push(url);
        return new Response("{}", { status: 202 });
      }
      if (url.endsWith("/pulls/558")) {
        return new Response(
          JSON.stringify({
            state: "open",
            merged_at: null,
            mergeable: true,
            mergeable_state: "behind",
            head: { sha: "ext111", ref: "human-topic-branch" },
          }),
          { status: 200 }
        );
      }
      if (url.includes("/commits/ext111/check-runs")) {
        return new Response(
          JSON.stringify({
            check_runs: [{ status: "completed", conclusion: "success" }],
          }),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: fetchForeign,
    });

    expect(updates).toHaveLength(0);
  });

  describe("nudge budget (PILE-270)", () => {
    async function budgetLane(num: number, title: string) {
      const agentId = `mock-budget-${crypto.randomUUID().slice(0, 8)}`;
      const prompts: string[] = [];
      registerMock(agentId, {
        sendPrompt: async (_id, prompt) => {
          prompts.push(prompt);
          return true;
        },
      });
      const issue = await stub.createIssue({ title });
      await stub.updateIssue(issue.id, { status: "in_progress" });
      const prUrl = `https://github.com/vortexnyc/pile/pull/${num}`;
      const session = await stub.createAgentSession({
        issueId: issue.id,
        agentId,
        provider: agentId,
        actorId: userId,
        actorType: "user",
        status: "running",
        prUrl,
        prState: "open",
      });
      return { agentId, prompts, issue, prUrl, session };
    }

    async function seedRounds(
      sessionId: string,
      issueId: string,
      prUrl: string,
      shas: string[]
    ) {
      for (const [i, sha] of shas.entries()) {
        await stub.addAgentSessionEvent({
          sessionId,
          type: "prompt.followup",
          message: `CI failure delivered as follow-up prompt (${i})`,
          payload: { issueId, prUrl, headSha: sha, key: `seed-${sha}-${i}` },
        });
      }
    }

    it("escalates once when the per-lane cap is exhausted", async () => {
      const { prompts, issue, prUrl, session } = await budgetLane(
        2701,
        "Budget lane cap"
      );
      await seedRounds(
        session.id,
        issue.id,
        prUrl,
        Array.from({ length: MAX_NUDGES_PER_LANE }, (_, i) => `old${i}`)
      );
      const fetchSrc = ghFetchFailingPr(2701, "cap1");

      for (let pass = 0; pass < 2; pass++) {
        await syncOpenPrSessions(env, stub, organizationId, {
          tokenForRepo: async () => "gh-test-token",
          fetch: fetchSrc as typeof fetch,
        });
      }

      expect(prompts).toHaveLength(0);
      const events = await stub.listAgentSessionEvents(session.id, {});
      const escalated = events.filter((e) => e.type === "issue.escalated");
      expect(escalated).toHaveLength(1);
      expect(escalated[0]!.payload).toContain(`escalated-${session.id}`);
      const comments = await stub.listComments(issue.id);
      const escalationComments = comments.filter((c) =>
        c.body.includes("Escalated")
      );
      expect(escalationComments).toHaveLength(1);
      expect(escalationComments[0]!.body).toContain(session.agentId);
      expect(escalationComments[0]!.body).toContain("CI failure");
      expect(escalationComments[0]!.body).toContain("old0");
      expect((await stub.getIssue(issue.id))?.status).toBe("triage");
    });

    it("escalates when one headSha exhausts its nudge rounds", async () => {
      const { prompts, issue, prUrl, session } = await budgetLane(
        2702,
        "Budget sha cap"
      );
      await seedRounds(
        session.id,
        issue.id,
        prUrl,
        Array.from({ length: MAX_NUDGES_PER_HEAD_SHA }, () => "sha2702")
      );

      await syncOpenPrSessions(env, stub, organizationId, {
        tokenForRepo: async () => "gh-test-token",
        fetch: ghFetchFailingPr(2702, "sha2702") as typeof fetch,
      });

      expect(prompts).toHaveLength(0);
      const types = (await stub.listAgentSessionEvents(session.id, {})).map(
        (e) => e.type
      );
      expect(types).toContain("issue.escalated");
      expect((await stub.getIssue(issue.id))?.status).toBe("triage");
    });

    it("carries the budget across nudge redispatches, not human retries", async () => {
      const { prompts, issue, prUrl, session } = await budgetLane(
        2703,
        "Budget redispatch chain"
      );
      const parent = await stub.createAgentSession({
        issueId: issue.id,
        agentId: session.agentId,
        provider: session.agentId,
        actorId: userId,
        actorType: "user",
        status: "completed",
      });
      await stub.updateAgentSession(session.id, { retryOf: parent.id });
      await seedRounds(
        parent.id,
        issue.id,
        prUrl,
        Array.from({ length: MAX_NUDGES_PER_LANE }, (_, i) => `p${i}`)
      );
      const fetchSrc = ghFetchFailingPr(2703, "chain1");

      // No prompt.redispatch link: a human retry gets a fresh budget.
      await syncOpenPrSessions(env, stub, organizationId, {
        tokenForRepo: async () => "gh-test-token",
        fetch: fetchSrc as typeof fetch,
      });
      expect(prompts).toHaveLength(1);

      const linked = await budgetLane(2704, "Budget redispatch linked");
      const linkedParent = await stub.createAgentSession({
        issueId: linked.issue.id,
        agentId: linked.agentId,
        provider: linked.agentId,
        actorId: userId,
        actorType: "user",
        status: "completed",
      });
      await stub.updateAgentSession(linked.session.id, {
        retryOf: linkedParent.id,
      });
      await seedRounds(
        linkedParent.id,
        linked.issue.id,
        linked.prUrl,
        Array.from({ length: MAX_NUDGES_PER_LANE - 1 }, (_, i) => `l${i}`)
      );
      await stub.addAgentSessionEvent({
        sessionId: linkedParent.id,
        type: "prompt.redispatch",
        message: "merge conflict redispatched",
        payload: {
          issueId: linked.issue.id,
          prUrl: linked.prUrl,
          redispatchedAs: linked.session.id,
        },
      });

      await syncOpenPrSessions(env, stub, organizationId, {
        tokenForRepo: async () => "gh-test-token",
        fetch: ghFetchFailingPr(2704, "chain2") as typeof fetch,
      });
      expect(linked.prompts).toHaveLength(0);
      const types = (
        await stub.listAgentSessionEvents(linked.session.id, {})
      ).map((e) => e.type);
      expect(types).toContain("issue.escalated");
    });
  });

  it("leaves sessions alone when the repo has no installation", async () => {
    const issue = await stub.createIssue({ title: "No installation" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock-prs",
      provider: "mock-prs",
      actorId: userId,
      actorType: "user",
      status: "completed",
      prUrl: "https://github.com/vortexnyc/pile/pull/999",
      prState: "open",
    });

    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => undefined,
    });

    expect((await stub.getAgentSession(session.id))?.prState).toBe("open");
  });
  // PILE-274 — once the author lane pushes past feedback it was delivered,
  // the matching review threads resolve (once; untouched otherwise).
  it("resolves delivered review threads after the author pushes the fix", async () => {
    const agentId = `mock-review-${crypto.randomUUID().slice(0, 8)}`;
    const prompts: string[] = [];
    registerMock(agentId, {
      sendPrompt: async (_id, prompt) => {
        prompts.push(prompt);
        return true;
      },
    });
    const issue = await stub.createIssue({ title: "Review threads" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
      prUrl: "https://github.com/vortexnyc/pile/pull/950",
      prState: "open",
    });
    let committedDate = "2020-01-01T00:00:00Z";
    const resolvedThreads: string[] = [];
    const fetchReview = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = String(input);
      if (url.endsWith("/graphql")) {
        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: { threadId?: string };
        };
        if (body.query.startsWith("mutation")) {
          resolvedThreads.push(body.variables.threadId ?? "");
          return new Response(
            JSON.stringify({
              data: { resolveReviewThread: { thread: { id: "t" } } },
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  commits: {
                    nodes: [{ commit: { oid: "fix222", committedDate } }],
                  },
                  reviewThreads: {
                    nodes: [
                      reviewThreadFixture("T-delivered", {
                        reviewId: 5001,
                        commit: "old111",
                      }),
                      reviewThreadFixture("T-other", {
                        reviewId: 6001,
                        commit: "old111",
                      }),
                      reviewThreadFixture("T-done", {
                        reviewId: 5001,
                        commit: "old111",
                        isResolved: true,
                      }),
                    ],
                  },
                },
              },
            },
          }),
          { status: 200 }
        );
      }
      if (url.endsWith("/pulls/950")) {
        return new Response(
          JSON.stringify({
            state: "open",
            merged_at: null,
            head: { sha: "fix222" },
          }),
          { status: 200 }
        );
      }
      if (url.includes("/commits/fix222/check-runs")) {
        return new Response(
          JSON.stringify({
            check_runs: [{ status: "completed", conclusion: "success" }],
          }),
          { status: 200 }
        );
      }
      if (url.includes("/pulls/950/reviews")) {
        return new Response(
          JSON.stringify([
            {
              id: 5001,
              state: "CHANGES_REQUESTED",
              body: "rename the helper",
              user: { login: "human" },
            },
          ]),
          { status: 200 }
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const deps = {
      tokenForRepo: async () => "gh-test-token",
      fetch: fetchReview,
    };

    // Head predates the delivery: the fix hasn't landed yet.
    await syncOpenPrSessions(env, stub, organizationId, deps);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("rename the helper");
    expect(resolvedThreads).toHaveLength(0);

    committedDate = new Date(Date.now() + 60_000).toISOString();
    await syncOpenPrSessions(env, stub, organizationId, deps);
    await syncOpenPrSessions(env, stub, organizationId, deps);

    expect(prompts).toHaveLength(1);
    expect(resolvedThreads).toEqual(["T-delivered"]);
    const types = (await stub.listAgentSessionEvents(session.id, {})).map(
      (e) => e.type
    );
    expect(types.filter((t) => t === "pr.review")).toHaveLength(1);
    expect(
      types.filter((t) => t === "pr.review_threads_resolved")
    ).toHaveLength(1);
  });

  it("range-diffs a follow-up review from the last-reviewed sha (PILE-286)", async () => {
    const agentId = `mock-review-${crypto.randomUUID().slice(0, 8)}`;
    const prompts: string[] = [];
    registerMock(agentId, {
      sendPrompt: async (_id, prompt) => {
        prompts.push(prompt);
        return true;
      },
    });
    const issue = await stub.createIssue({ title: "Incremental review" });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
      prUrl: "https://github.com/vortexnyc/pile/pull/901",
      prState: "open",
    });
    await stub.recordLaneReview(session.id, {
      reviewId: 1,
      reviewer: "alice",
      state: "CHANGES_REQUESTED",
      sha: "rev1111",
      excerpt: "needs a regression test",
    });
    const compares: string[] = [];
    const fetchReview = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/pulls/901")) {
        return Response.json({
          state: "open",
          merged_at: null,
          head: { sha: "rev2222" },
        });
      }
      if (url.includes("/commits/rev2222/check-runs")) {
        return Response.json({
          check_runs: [{ status: "completed", conclusion: "success" }],
        });
      }
      if (url.includes("/pulls/901/reviews")) {
        return Response.json([
          {
            id: 2,
            state: "CHANGES_REQUESTED",
            body: "test misses the null branch",
            commit_id: "rev2222",
            user: { login: "alice" },
          },
        ]);
      }
      if (url.includes("/compare/")) {
        compares.push(url);
        return Response.json({
          status: "ahead",
          total_commits: 1,
          commits: [
            { sha: "c0ffee1234", commit: { message: "add regression test" } },
          ],
          files: [
            {
              filename: "src/a.test.ts",
              status: "added",
              additions: 12,
              deletions: 0,
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: fetchReview as typeof fetch,
    });

    expect(compares).toEqual([
      "https://api.github.com/repos/vortexnyc/pile/compare/rev1111...rev2222",
    ]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("test misses the null branch");
    expect(prompts[0]).toContain(
      "- alice changes_requested @rev1111: needs a regression test"
    );
    expect(prompts[0]).toContain("- c0ffee1 add regression test");
    expect(prompts[0]).toContain("- src/a.test.ts (added, +12/-0)");
    const after = await stub.getAgentSession(session.id);
    expect(after?.lastReviewedSha).toBe("rev2222");

    // Delivered once: a second sweep neither re-nudges nor re-compares.
    await syncOpenPrSessions(env, stub, organizationId, {
      tokenForRepo: async () => "gh-test-token",
      fetch: fetchReview as typeof fetch,
    });
    expect(prompts).toHaveLength(1);
    expect(compares).toHaveLength(1);

    // A retry lane inherits the review history it replaces.
    const retry = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: userId,
      actorType: "user",
      status: "running",
    });
    const inherited = await stub.updateAgentSession(retry.id, {
      retryOf: session.id,
    });
    expect(inherited?.lastReviewedSha).toBe("rev2222");
    expect(inherited?.reviewSummary).toBe(after?.reviewSummary);
  });
});

describe("cronMatchesNow", () => {
  const at = new Date("2026-09-28T14:30:00Z"); // Mon 14:30 UTC

  it("matches exact, wildcard, step, range, and list fields", async () => {
    const { cronMatchesNow } = await import("./sweep.js");
    expect(cronMatchesNow("30 14 * * *", at)).toBe(true);
    expect(cronMatchesNow("* * * * *", at)).toBe(true);
    expect(cronMatchesNow("*/15 * * * *", at)).toBe(true);
    expect(cronMatchesNow("10-40/10 * * * *", at)).toBe(true);
    expect(cronMatchesNow("0,30 * * * *", at)).toBe(true);
    expect(cronMatchesNow("30 14 28 9 1", at)).toBe(true);
  });

  it("rejects non-matching and malformed expressions", async () => {
    const { cronMatchesNow } = await import("./sweep.js");
    expect(cronMatchesNow("31 14 * * *", at)).toBe(false);
    expect(cronMatchesNow("*/7 * * * *", at)).toBe(false);
    expect(cronMatchesNow("45-50 * * * *", at)).toBe(false);
    expect(cronMatchesNow("30 14", at)).toBe(false);
    expect(cronMatchesNow("not-a-cron", at)).toBe(false);
  });
});
