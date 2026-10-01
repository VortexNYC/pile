import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { DEFAULT_GIT_IDENTITY_REPO } from "../types/workspace.js";
import { MockAgentProvider } from "./harness.js";
import {
  dispatchAgent,
  getAgentProvider,
  registerAgentProvider,
} from "./index.js";
import type { AgentDispatchContext } from "./provider.js";

const actor: WorkspaceIdentity = {
  id: "user-1",
  organizationId: "",
  type: "user",
  permissions: ["write"],
};

beforeAll(async () => {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-1",
      name: "Test User",
      email: "user-1@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const headers = await createAdminHeaders(env, "user-1");
  const workspace = await createWorkspace(db, env, headers, {
    name: "Test workspace",
    slug: "test-ws",
    ownerId: actor.id,
  });
  if (workspace) {
    actor.organizationId = workspace.id;
  }
});

describe("agent providers", () => {
  it("throws for unknown provider", () => {
    expect(() => getAgentProvider("unknown", env)).toThrow(
      "Unknown agent provider: unknown"
    );
  });

  it("registers and dispatches a mock provider", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({ title: "Mock dispatch test" });

    const provider = new MockAgentProvider("mock", {
      dispatch: () => ({
        id: "test-1",
        agentId: "mock",
        issueId: issue.id,
        status: "created",
      }),
    });
    registerAgentProvider("mock", () => provider);

    const session = await dispatchAgent(
      env,
      "mock",
      actor.organizationId,
      issue,
      actor
    );

    expect(session.agentId).toBe("mock");
    expect(session.issueId).toBe(issue.id);
    expect(session.provider).toBe("mock");
    expect(session.actorId).toBe("user-1");
  });

  it("keeps ctx.waitUntil bound so providers can fire-and-forget", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({ title: "waitUntil binding test" });

    let waited = 0;
    // Mimics workerd's ExecutionContext: waitUntil is a WebIDL method that
    // throws "Illegal invocation" when invoked detached from its receiver.
    const ctx = {
      waitUntil(this: unknown, task: Promise<unknown>) {
        if (this !== ctx) throw new TypeError("Illegal invocation");
        waited += 1;
        void task;
      },
    };

    const provider = new MockAgentProvider("mock", {
      dispatch: (_org, _i, _model, sessionContext) => {
        // Real providers hand their start() to sessionContext.waitUntil —
        // this call is detached from ctx by construction.
        sessionContext?.waitUntil?.(Promise.resolve());
        return {
          id: "wu-1",
          agentId: "mock-waituntil",
          issueId: issue.id,
          status: "created",
        };
      },
    });
    registerAgentProvider("mock-waituntil", () => provider);

    const session = await dispatchAgent(
      env,
      "mock-waituntil",
      actor.organizationId,
      issue,
      actor,
      undefined,
      ctx
    );
    expect(session.status).toBe("created");
    expect(waited).toBe(1);
  });

  it("polls a mock session", async () => {
    const provider = new MockAgentProvider("mock", {
      poll: (sessionId) => ({
        id: sessionId,
        agentId: "mock",
        status: "completed",
        result: "done",
      }),
    });
    registerAgentProvider("mock-poll", () => provider);

    const p = getAgentProvider("mock-poll", env);
    const session = await p.poll("session-1");

    expect(session.id).toBe("session-1");
    expect(session.status).toBe("completed");
  });

  it("blocks a second dispatch while an active session exists", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({ title: "Duplicate dispatch test" });

    const provider = new MockAgentProvider("mock", {
      dispatch: () => ({
        id: "dup-1",
        agentId: "mock",
        status: "created",
      }),
    });
    registerAgentProvider("mock-dup", () => provider);

    await dispatchAgent(env, "mock-dup", actor.organizationId, issue, actor);
    await expect(
      dispatchAgent(env, "mock-dup", actor.organizationId, issue, actor)
    ).rejects.toThrow("active agent session");
  });

  it("moves the issue to in_progress on dispatch", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({ title: "Status transition test" });

    const provider = new MockAgentProvider("mock", {
      dispatch: () => ({
        id: "run-1",
        agentId: "mock",
        status: "running",
      }),
    });
    registerAgentProvider("mock-run", () => provider);

    const session = await dispatchAgent(
      env,
      "mock-run",
      actor.organizationId,
      issue,
      actor
    );

    expect(session.status).toBe("running");
    const updated = await stub.getIssue(issue.id);
    expect(updated?.status).toBe("in_progress");
  });

  it("writes PR fields and creates a comment when a session completes", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({ title: "PR writeback test" });

    const provider = new MockAgentProvider("mock", {
      dispatch: () => ({
        id: "pr-1",
        agentId: "mock",
        status: "created",
      }),
    });
    registerAgentProvider("mock-pr", () => provider);

    const session = await dispatchAgent(
      env,
      "mock-pr",
      actor.organizationId,
      issue,
      actor
    );

    const prUrl = "https://github.com/vortexnyc/pile/pull/42";
    await stub.applyAgentSessionResult(session.id, {
      status: "completed",
      result: "Done",
      prUrl,
      prState: "open",
    });

    const updated = await stub.getIssue(issue.id);
    expect(updated?.prUrl).toBe(prUrl);
    expect(updated?.prState).toBe("open");
    expect(updated?.status).toBe("in_progress");

    const comments = await stub.listComments(issue.id);
    expect(comments.length).toBe(1);
    expect(comments[0]?.body).toContain(prUrl);
  });

  it("writes a session.summary event on terminal transition with provider digest", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({ title: "Digest test" });

    const provider = new MockAgentProvider("mock", {
      dispatch: () => ({
        id: "digest-1",
        agentId: "mock",
        status: "created",
      }),
    });
    registerAgentProvider("mock-digest", () => provider);

    const session = await dispatchAgent(
      env,
      "mock-digest",
      actor.organizationId,
      issue,
      actor
    );

    await stub.applyAgentSessionResult(session.id, {
      status: "completed",
      result: JSON.stringify({
        output_tail: "done",
        digest: { durationSec: 42, filesChanged: ["a.ts"], commits: 1 },
      }),
    });

    const events = await stub.listAgentSessionEvents(session.id, {
      limit: 100,
    });
    const summary = events.find((e) => e.type === "session.summary");
    expect(summary).toBeDefined();
    const payload = JSON.parse(summary?.payload as string) as Record<
      string,
      unknown
    >;
    expect(payload.status).toBe("completed");
    expect(payload.agentId).toBe("mock-digest");
    expect(typeof payload.durationMs).toBe("number");
    expect(payload.digest).toEqual({
      durationSec: 42,
      filesChanged: ["a.ts"],
      commits: 1,
    });

    // Plain-text results still emit a summary — just without a digest.
    const issue2 = await stub.createIssue({ title: "Digest text" });
    const session2 = await dispatchAgent(
      env,
      "mock-digest",
      actor.organizationId,
      issue2,
      actor
    );
    await stub.applyAgentSessionResult(session2.id, {
      status: "failed",
      result: "plain failure text",
    });
    const events2 = await stub.listAgentSessionEvents(session2.id, {
      limit: 100,
    });
    const summary2 = events2.find((e) => e.type === "session.summary");
    expect(summary2).toBeDefined();
    const payload2 = JSON.parse(summary2?.payload as string) as Record<
      string,
      unknown
    >;
    expect(payload2.status).toBe("failed");
    expect(payload2.digest).toBeUndefined();
  });

  it("lane owns the issue while running, hands off via elicitation, releases on terminal", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({ title: "Handoff test" });

    const provider = new MockAgentProvider("mock", {
      dispatch: () => ({
        id: "handoff-1",
        agentId: "mock",
        status: "created",
      }),
    });
    registerAgentProvider("mock-handoff", () => provider);

    const session = await dispatchAgent(
      env,
      "mock-handoff",
      actor.organizationId,
      issue,
      actor
    );

    // Lane owns the workload while it runs.
    const owned = await stub.getIssue(issue.id);
    expect(owned?.assigneeId).toBe(`lane:${session.id}`);

    // Elicitation is the lane→human ask: needs_input event + notification
    // to the dispatching human (no human assignee set on the issue).
    await stub.addAgentActivity({
      sessionId: session.id,
      type: "elicitation",
      message: "Which environment should I target?",
    });
    const events = await stub.listAgentSessionEvents(session.id, {
      limit: 100,
    });
    expect(events.some((e) => e.type === "session.needs_input")).toBe(true);
    const notifications = await stub.listNotificationsForRecipient(
      actor.id,
      "user",
      {}
    );
    const n = notifications.find((x) => x.type === "lane_needs_input");
    expect(n).toBeDefined();
    expect(n?.recipientId).toBe(actor.id);

    // Terminal transition releases ownership.
    await stub.applyAgentSessionResult(session.id, { status: "completed" });
    const released = await stub.getIssue(issue.id);
    expect(released?.assigneeId).toBeNull();
  });

  it("marks the session failed without changing the issue status", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({ title: "Failure test" });

    const provider = new MockAgentProvider("mock", {
      dispatch: () => {
        throw new Error("provider dispatch failed");
      },
    });
    registerAgentProvider("mock-fail", () => provider);

    await expect(
      dispatchAgent(env, "mock-fail", actor.organizationId, issue, actor)
    ).rejects.toThrow("provider dispatch failed");

    const updated = await stub.getIssue(issue.id);
    expect(updated?.status).toBe("backlog");

    const sessions = await stub.listAgentSessions({ issueId: issue.id });
    expect(sessions[0]?.status).toBe("failed");
  });

  it("allows dispatch when no teamIds are configured", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({
      title: "No team scoping test",
    });
    await stub.upsertAgentProviderConfig({
      agentId: "mock-no-teams",
      token: "test-token",
    });

    const provider = new MockAgentProvider("mock-no-teams");
    registerAgentProvider("mock-no-teams", () => provider);

    const session = await dispatchAgent(
      env,
      "mock-no-teams",
      actor.organizationId,
      issue,
      actor
    );

    expect(session.agentId).toBe("mock-no-teams");
  });

  it("rejects dispatch when the issue team is not in teamIds", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({
      title: "Team scoping reject test",
    });
    await stub.upsertAgentProviderConfig({
      agentId: "mock-scoped",
      token: "test-token",
      teamIds: ["other-team-id"],
    });

    const provider = new MockAgentProvider("mock-scoped");
    registerAgentProvider("mock-scoped", () => provider);

    await expect(
      dispatchAgent(env, "mock-scoped", actor.organizationId, issue, actor)
    ).rejects.toThrow("not enabled for this team");
  });

  it("allows dispatch when the issue team is in teamIds", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({
      title: "Team scoping allow test",
    });
    await stub.upsertAgentProviderConfig({
      agentId: "mock-scoped-allow",
      token: "test-token",
      teamIds: [issue.teamId],
    });

    const provider = new MockAgentProvider("mock-scoped-allow");
    registerAgentProvider("mock-scoped-allow", () => provider);

    const session = await dispatchAgent(
      env,
      "mock-scoped-allow",
      actor.organizationId,
      issue,
      actor
    );

    expect(session.agentId).toBe("mock-scoped-allow");
  });

  it("passes the repo git identity to the provider", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({
      title: "Git identity dispatch test",
      repo: "VortexNYC/pile",
    });
    const identity = await stub.upsertGitIdentity({
      repo: "VortexNYC/pile",
      name: "Test Agent",
      email: "agent@example.com",
      githubUsername: "test-agent",
      signingKeyRef: "veil://github-signing",
    });

    let captured: AgentDispatchContext | undefined;
    const provider = new MockAgentProvider("mock", {
      dispatch: (_1, _2, _3, ctx) => {
        captured = ctx;
        return { id: "gitid-1", agentId: "mock", status: "created" };
      },
    });
    registerAgentProvider("mock-gitid", () => provider);

    await dispatchAgent(env, "mock-gitid", actor.organizationId, issue, actor);

    expect(captured?.gitIdentity).toEqual(identity);
  });

  it("falls back to the workspace-default git identity", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({
      title: "Default git identity test",
      repo: "VortexNYC/no-bound-identity",
    });
    const fallback = await stub.upsertGitIdentity({
      repo: DEFAULT_GIT_IDENTITY_REPO,
      name: "Workspace Agent",
      email: "workspace-agent@example.com",
      githubUsername: null,
      signingKeyRef: null,
    });

    let captured: AgentDispatchContext | undefined;
    const provider = new MockAgentProvider("mock", {
      dispatch: (_1, _2, _3, ctx) => {
        captured = ctx;
        return { id: "gitid-default-1", agentId: "mock", status: "created" };
      },
    });
    registerAgentProvider("mock-gitid-default", () => provider);

    await dispatchAgent(
      env,
      "mock-gitid-default",
      actor.organizationId,
      issue,
      actor
    );

    expect(captured?.gitIdentity).toEqual(fallback);
  });

  it("prefers the repo-bound identity over the workspace default", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({
      title: "Repo identity precedence test",
      repo: "VortexNYC/bound-precedence",
    });
    const bound = await stub.upsertGitIdentity({
      repo: "VortexNYC/bound-precedence",
      name: "Repo Agent",
      email: "repo-agent@example.com",
      githubUsername: null,
      signingKeyRef: null,
    });
    await stub.upsertGitIdentity({
      repo: DEFAULT_GIT_IDENTITY_REPO,
      name: "Workspace Agent",
      email: "workspace-agent@example.com",
      githubUsername: null,
      signingKeyRef: null,
    });

    let captured: AgentDispatchContext | undefined;
    const provider = new MockAgentProvider("mock", {
      dispatch: (_1, _2, _3, ctx) => {
        captured = ctx;
        return { id: "gitid-bound-1", agentId: "mock", status: "created" };
      },
    });
    registerAgentProvider("mock-gitid-bound", () => provider);

    await dispatchAgent(
      env,
      "mock-gitid-bound",
      actor.organizationId,
      issue,
      actor
    );

    expect(captured?.gitIdentity).toEqual(bound);
  });

  it("rejects all teams when teamIds is an empty array", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({
      title: "Empty teamIds test",
    });
    await stub.upsertAgentProviderConfig({
      agentId: "mock-empty-teams",
      token: "test-token",
      teamIds: [],
    });

    const provider = new MockAgentProvider("mock-empty-teams");
    registerAgentProvider("mock-empty-teams", () => provider);

    await expect(
      dispatchAgent(env, "mock-empty-teams", actor.organizationId, issue, actor)
    ).rejects.toThrow("not enabled for this team");
  });

  it("throws for malformed teamIds configuration", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({
      title: "Malformed teamIds test",
    });
    const agentId = "mock-malformed-teams";
    await stub.upsertAgentProviderConfig({
      agentId,
      token: "test-token",
      teamIds: "not-json",
    });

    const provider = new MockAgentProvider(agentId);
    registerAgentProvider(agentId, () => provider);

    await expect(
      dispatchAgent(env, agentId, actor.organizationId, issue, actor)
    ).rejects.toThrow("Invalid agent provider teamIds configuration");
  });

  it("filters extraEnv against the repo env allowlist", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({ title: "Env allowlist" });

    let captured: AgentDispatchContext | undefined;
    registerAgentProvider(
      "mock-envlist",
      () =>
        new MockAgentProvider("mock-envlist", {
          dispatch: (_org, _issue, _model, ctx) => {
            captured = ctx;
            return { id: "env-1", agentId: "mock-envlist", status: "created" };
          },
        })
    );

    await dispatchAgent(
      env,
      "mock-envlist",
      actor.organizationId,
      issue,
      actor,
      undefined,
      undefined,
      {
        extraEnv: { DATABASE_URL: "postgres://x", GITHUB_TOKEN: "ghp_x" },
        envAllowlist: ["DATABASE_URL"],
      }
    );

    expect(captured?.extraEnv).toEqual({ DATABASE_URL: "postgres://x" });
  });

  it("persists secondaryRepos and passes them to a supporting provider", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({
      title: "Cross-repo dispatch test",
      repo: "VortexNYC/pile",
    });

    let captured: AgentDispatchContext | undefined;
    class CrossRepoProvider extends MockAgentProvider {
      readonly supportsSecondaryRepos = true;
    }
    const provider = new CrossRepoProvider("mock", {
      dispatch: (_1, _2, _3, ctx) => {
        captured = ctx;
        return { id: "xrepo-1", agentId: "mock", status: "created" };
      },
    });
    registerAgentProvider("mock-xrepo", () => provider);

    const secondaryRepos = [
      { repo: "VortexNYC/vortex", access: "read" as const },
      { repo: "VortexNYC/cloudflare-ci", access: "write" as const },
    ];
    const session = await dispatchAgent(
      env,
      "mock-xrepo",
      actor.organizationId,
      issue,
      actor,
      undefined,
      undefined,
      { secondaryRepos }
    );

    expect(captured?.secondaryRepos).toEqual(secondaryRepos);
    const stored = await stub.getAgentSession(session.id);
    expect(JSON.parse(stored?.secondaryRepos ?? "null")).toEqual(
      secondaryRepos
    );
  });

  it("rejects secondaryRepos for providers without support", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({
      title: "Cross-repo unsupported test",
      repo: "VortexNYC/pile",
    });
    registerAgentProvider(
      "mock-no-xrepo",
      () =>
        new MockAgentProvider("mock", {
          dispatch: () => ({ id: "x", agentId: "mock", status: "created" }),
        })
    );

    await expect(
      dispatchAgent(
        env,
        "mock-no-xrepo",
        actor.organizationId,
        issue,
        actor,
        undefined,
        undefined,
        { secondaryRepos: [{ repo: "VortexNYC/vortex", access: "read" }] }
      )
    ).rejects.toThrow("does not support secondaryRepos");
  });

  it("picks the effort-tier model from issue priority and persists the budget", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    await stub.upsertAgentProviderConfig({
      agentId: "mock-effort",
      config: { effortModels: { low: "cheap-model", max: "big-model" } },
    });
    let captured: { model?: string; effort?: string } = {};
    registerAgentProvider(
      "mock-effort",
      () =>
        new MockAgentProvider("mock-effort", {
          dispatch: (_org, issue, model, ctx) => {
            captured = { model, effort: ctx?.effort };
            return {
              id: `run-${issue.id}`,
              agentId: "mock-effort",
              status: "created",
            };
          },
        })
    );

    const triage = await stub.createIssue({
      title: "Low-priority triage",
      priority: "low",
    });
    const cheap = await dispatchAgent(
      env,
      "mock-effort",
      actor.organizationId,
      triage,
      actor,
      undefined,
      undefined,
      { maxDurationMinutes: 15 }
    );
    expect(captured).toEqual({ model: "cheap-model", effort: "low" });
    expect(cheap.effort).toBe("low");
    expect(cheap.maxDurationMinutes).toBe(15);

    const urgent = await stub.createIssue({
      title: "Urgent with explicit model",
      priority: "urgent",
    });
    const pinned = await dispatchAgent(
      env,
      "mock-effort",
      actor.organizationId,
      urgent,
      actor,
      "explicit-model"
    );
    expect(captured).toEqual({ model: "explicit-model", effort: "max" });
    expect(pinned.effort).toBe("max");
    expect(pinned.maxDurationMinutes).toBeNull();
  });
});
