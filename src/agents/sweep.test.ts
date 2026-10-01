import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { supportTickets, user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { MockAgentProvider } from "./harness.js";
import { registerAgentProvider } from "./index.js";
import {
  DEFAULT_INACTIVITY_MINUTES,
  DEFAULT_PROVISION_TIMEOUT_MINUTES,
  DEFAULT_TIMEOUT_MINUTES,
  hashAgentState,
  ingestFailedAgentSession,
  parseAgentTimeouts,
  progressIsStale,
  prStateFromPull,
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
