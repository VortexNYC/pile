import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { organization, user as userTable } from "../global/schema.js";
import { createTeam } from "../global/teams.js";
import { createWorkspace } from "../global/workspaces.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { DEFAULT_GIT_IDENTITY_REPO } from "../types/workspace.js";
import { ComputeError } from "./compute.js";
import { MockAgentProvider } from "./harness.js";
import {
  dispatchAgent,
  failedDispatchSessionId,
  getAgentProvider,
  inheritTeamDefaultRepo,
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

  it("continues an open covering PR on its head branch instead of conflict (PILE-446)", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({
      title: "Continue PR work",
      repo: "acme/widgets",
    });

    let captured:
      | {
          branch?: string | null;
          instructions?: string;
        }
      | undefined;
    const agentId = `mock-cont-${crypto.randomUUID().slice(0, 8)}`;
    const provider = new MockAgentProvider(agentId, {
      dispatch: (_org, dispatchedIssue, _model, ctx) => {
        captured = {
          branch: dispatchedIssue.branch,
          instructions: ctx?.instructions,
        };
        return {
          id: "cont-1",
          agentId,
          issueId: dispatchedIssue.id,
          status: "created",
        };
      },
    });
    registerAgentProvider(agentId, () => provider);

    const prUrl = "https://github.com/acme/widgets/pull/555";
    const session = await dispatchAgent(
      env,
      agentId,
      actor.organizationId,
      issue,
      actor,
      undefined,
      undefined,
      {
        dedupeDeps: {
          tokenForRepo: async () => "gh-token",
          fetch: async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/pulls?state=open")) {
              return new Response(
                JSON.stringify([
                  {
                    number: 555,
                    html_url: prUrl,
                    title: `${issue.identifier} continuation target`,
                    body: null,
                    head: { ref: "pr-555-branch" },
                  },
                ]),
                { status: 200 }
              );
            }
            return new Response("[]", { status: 200 });
          },
        },
      }
    );

    expect(session.status).toBe("created");
    // The covering PR's head branch is persisted on the issue and handed to
    // the provider as the lane's working branch.
    const stored = await stub.getIssue(issue.id);
    expect(stored?.branch).toBe("pr-555-branch");
    expect(captured?.branch).toBe("pr-555-branch");
    expect(captured?.instructions).toContain("Continuation dispatch");
    expect(captured?.instructions).toContain(prUrl);
    expect(captured?.instructions).toContain("pr-555-branch");
    const events = await stub.listAgentSessionEvents(session.id, {
      limit: 100,
    });
    expect(events.some((e) => e.type === "lane.continuation")).toBe(true);
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

  it("lane delegates the issue, hands off via elicitation, stays delegate on terminal", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({
      title: "Handoff test",
      assigneeId: actor.id,
    });

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

    // PILE-417 — dispatch is delegation: the agent lands on delegateId and
    // the human assignee stays accountable for the whole run.
    const owned = await stub.getIssue(issue.id);
    expect(owned?.delegateId).toBe(session.agentId);
    expect(owned?.assigneeId).toBe(actor.id);

    // Elicitation is the lane→human ask: needs_input event + notification
    // to the issue's human assignee.
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

    // Terminal transition keeps the delegate-of-record and the assignee.
    await stub.applyAgentSessionResult(session.id, { status: "completed" });
    const released = await stub.getIssue(issue.id);
    expect(released?.delegateId).toBe(session.agentId);
    expect(released?.assigneeId).toBe(actor.id);
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

  it("promotes a queued session with a fresh provision clock and keeps its queuedAfter edge", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const agentId = `mock-promote-${crypto.randomUUID().slice(0, 8)}`;
    let dispatched = 0;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: (_org, dispatchedIssue) => {
            dispatched += 1;
            return {
              id: `promote-${dispatched}`,
              agentId,
              issueId: dispatchedIssue.id,
              status: "created" as const,
            };
          },
        })
    );

    const blockerIssue = await stub.createIssue({ title: "Promote blocker" });
    const blocker = await stub.createAgentSession({
      issueId: blockerIssue.id,
      agentId,
      provider: agentId,
      actorId: actor.id,
      actorType: actor.type,
      status: "completed",
    });
    const issue = await stub.createIssue({ title: "Promote queued lane" });
    const stale = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const queued = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: actor.id,
      actorType: actor.type,
      status: "waiting",
      queuedAfter: blocker.id,
      createdAt: stale,
    });

    const promoted = await dispatchAgent(
      env,
      agentId,
      actor.organizationId,
      issue,
      actor,
      undefined,
      undefined,
      { promoteSessionId: queued.id }
    );

    expect(promoted.id).toBe(queued.id);
    expect(promoted.status).toBe("created");
    expect(dispatched).toBe(1);
    // Promotion restarts the provision clock — queue dwell is not lane
    // runtime — and keeps the queuedAfter edge so an infra-retry can
    // re-anchor to it (PILE-260).
    const stored = await stub.getAgentSession(queued.id);
    expect(stored?.status).toBe("created");
    expect(stored?.queuedAfter).toBe(blocker.id);
    expect(Date.parse(stored?.createdAt ?? "")).toBeGreaterThan(
      Date.parse(stale)
    );
  });
});

function workspaceStub() {
  return env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
  );
}

describe("inheritTeamDefaultRepo (PILE-321)", () => {
  const getStub = workspaceStub;

  it("inherits and persists the team's defaultRepo on a repo-less issue", async () => {
    const db = createD1(env.D1);
    const stub = getStub();
    await stub.setOrganizationId(actor.organizationId);
    const team = await createTeam(db, env, new Headers(), {
      organizationId: actor.organizationId,
      key: "INH",
      name: "Inherited",
      ownerId: actor.id,
      defaultRepo: "VortexNYC/team-default",
    });
    const issue = await stub.createIssue({
      title: "Repo-less dispatch",
      teamId: team.id,
    });
    expect(issue.repo).toBeNull();

    const resolved = await inheritTeamDefaultRepo(
      db,
      stub,
      actor.organizationId,
      issue,
      actor.id
    );

    expect(resolved.repo).toBe("VortexNYC/team-default");
    // Persisted — redispatches and lane-token minting read issue.repo.
    expect((await stub.getIssue(issue.id))?.repo).toBe(
      "VortexNYC/team-default"
    );
  });

  it("leaves an issue that already has a repo untouched", async () => {
    const db = createD1(env.D1);
    const stub = getStub();
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({
      title: "Has its own repo",
      repo: "VortexNYC/own-repo",
    });

    const resolved = await inheritTeamDefaultRepo(
      db,
      stub,
      actor.organizationId,
      issue,
      actor.id
    );

    expect(resolved.repo).toBe("VortexNYC/own-repo");
    expect((await stub.getIssue(issue.id))?.repo).toBe("VortexNYC/own-repo");
  });

  it("stays repo-less when the team has no defaultRepo", async () => {
    const db = createD1(env.D1);
    const stub = getStub();
    await stub.setOrganizationId(actor.organizationId);
    const team = await createTeam(db, env, new Headers(), {
      organizationId: actor.organizationId,
      key: "NODEF",
      name: "No default repo",
      ownerId: actor.id,
    });
    const issue = await stub.createIssue({
      title: "Deliberately repo-less",
      teamId: team.id,
    });

    const resolved = await inheritTeamDefaultRepo(
      db,
      stub,
      actor.organizationId,
      issue,
      actor.id
    );

    expect(resolved.repo).toBeNull();
    expect((await stub.getIssue(issue.id))?.repo).toBeNull();
  });

  it("no-ops when the issue has no team", async () => {
    const db = createD1(env.D1);
    const stub = getStub();
    const issue = await stub.createIssue({ title: "No team" });

    const resolved = await inheritTeamDefaultRepo(
      db,
      stub,
      actor.organizationId,
      { ...issue, teamId: "" },
      actor.id
    );

    expect(resolved.repo).toBeNull();
  });
});

describe("guidance pack injection (PILE-423)", () => {
  it("injects applicable packs into dispatch instructions, most specific last, and records versions", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const issue = await stub.createIssue({
      title: "Guidance dispatch test",
    });

    await stub.createGuidancePack(
      {
        name: "Workspace rules",
        scope: "workspace",
        body: "Always be terse.",
      },
      { actorId: actor.id }
    );
    const stagePack = await stub.createGuidancePack(
      {
        name: "Backlog stage",
        scope: "status",
        scopeKey: "backlog",
        body: "No rate or savings numbers.",
        links: JSON.stringify([
          { label: "Playbook", url: "https://example.com/pb" },
        ]),
      },
      { actorId: actor.id }
    );
    await stub.createGuidancePack(
      {
        name: "Contacted step",
        scope: "step",
        scopeKey: "contacted",
        body: "Human approval required.",
      },
      { actorId: actor.id }
    );
    // Non-matching packs stay out.
    await stub.createGuidancePack(
      {
        name: "Done stage",
        scope: "status",
        scopeKey: "done",
        body: "should not appear",
      },
      { actorId: actor.id }
    );

    let captured: AgentDispatchContext | undefined;
    const agentId = `mock-guidance-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: (_o, _i, _m, ctx) => {
            captured = ctx;
            return { id: "g-1", agentId, status: "created" as const };
          },
        })
    );

    const session = await dispatchAgent(
      env,
      agentId,
      actor.organizationId,
      issue,
      actor,
      undefined,
      undefined,
      { instructions: "Caller note.", stepKey: "contacted" }
    );

    const instructions = captured?.instructions ?? "";
    expect(instructions).toContain("## Guidance");
    expect(instructions).toContain("Always be terse.");
    expect(instructions).toContain("No rate or savings numbers.");
    expect(instructions).toContain("Human approval required.");
    expect(instructions).not.toContain("should not appear");
    // Least specific first; caller instructions land last.
    expect(instructions.indexOf("Always be terse.")).toBeLessThan(
      instructions.indexOf("No rate or savings numbers.")
    );
    expect(instructions.indexOf("No rate or savings numbers.")).toBeLessThan(
      instructions.indexOf("Human approval required.")
    );
    expect(instructions.indexOf("Human approval required.")).toBeLessThan(
      instructions.indexOf("Caller note.")
    );

    // The session records the pack versions it used.
    const recorded = (await stub.getAgentSession(session.id)) ?? session;
    const refs = JSON.parse(recorded.guidance ?? "[]") as Array<{
      id: string;
      scope: string;
      version: number;
    }>;
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.scope)).toEqual(["workspace", "status", "step"]);
    const stageRef = refs.find((r) => r.id === stagePack.id);
    expect(stageRef?.version).toBe(1);
    expect(recorded.stepKey).toBe("contacted");
  });
});

describe("spend caps (PILE-425)", () => {
  it("parks a dispatch whose agent type breached its run cap", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(actor.organizationId)
    );
    await stub.setOrganizationId(actor.organizationId);
    const agentId = `mock-cap-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: () => ({ id: "x", agentId, status: "created" }),
        })
    );
    await stub.upsertAgentSpendCap(agentId, { maxRunsPerDay: 1 });
    // One prior run already consumed the day's budget.
    const prior = await stub.createIssue({ title: "prior run" });
    await stub.createAgentSession({
      issueId: prior.id,
      agentId,
      provider: agentId,
      actorId: actor.id,
      actorType: "user",
      status: "completed",
    });

    const issue = await stub.createIssue({ title: "capped dispatch" });
    const session = await dispatchAgent(
      env,
      agentId,
      actor.organizationId,
      issue,
      actor
    );
    // Held like a PILE-420 pause — waiting + paused, never dispatched.
    expect(session.status).toBe("waiting");
    expect(session.paused).toBe(1);
    const pause = await stub.getAgentPause(agentId);
    expect(pause?.createdBy).toBe("spend-cap");
    expect(pause?.reason).toContain("daily runs cap");
  });
});

// PILE-452 — Daytona start/provision failures must classify as infra: they
// feed the retry path and the fleet breaker, not the task-failure trail.
describe("infra classification of dispatch failures (PILE-452)", () => {
  const stub = workspaceStub;

  const substrateErrors = [
    "Daytona sandbox create failed: 400 sandbox exited with code 1 before becoming ready",
    "Daytona process session create failed: 400 SANDBOX_NOT_RUNNING",
    "Daytona sandbox failed: failed to resolve container IP",
    "compute sandbox error",
    "devin-cli provision timed out after 300000ms",
  ];

  for (const message of substrateErrors) {
    it(`records infraFailure=1 for "${message.slice(0, 45)}…"`, async () => {
      const agentId = `mock-infra-${crypto.randomUUID().slice(0, 8)}`;
      registerAgentProvider(
        agentId,
        () =>
          new MockAgentProvider(agentId, {
            dispatch: () => {
              throw new ComputeError({
                code: "AGENT_ERROR",
                status: 502,
                message,
              });
            },
          })
      );
      const issue = await stub().createIssue({ title: "infra test" });

      let thrown: unknown;
      try {
        await dispatchAgent(env, agentId, actor.organizationId, issue, actor);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ComputeError);

      const sessions = await stub().listAgentSessions({ issueId: issue.id });
      expect(sessions[0]?.status).toBe("failed");
      expect(sessions[0]?.infraFailure).toBe(1);
      expect(sessions[0]?.result).toBe(message);
      // The corpse's id rides the throw so redispatch can link retryOf.
      expect(failedDispatchSessionId(thrown)).toBe(sessions[0]?.id);
    });
  }

  it("keeps ordinary provider failures off the infra path", async () => {
    const agentId = `mock-task-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: () => {
            throw new Error("model exploded");
          },
        })
    );
    const issue = await stub().createIssue({ title: "task failure" });
    await expect(
      dispatchAgent(env, agentId, actor.organizationId, issue, actor)
    ).rejects.toThrow("model exploded");
    const sessions = await stub().listAgentSessions({ issueId: issue.id });
    expect(sessions[0]?.status).toBe("failed");
    expect(sessions[0]?.infraFailure).toBe(0);
  });

  it("throws AGENT_PAUSED instead of parking when onPaused is fail", async () => {
    const agentId = `mock-nohold-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(agentId, () => new MockAgentProvider(agentId));
    const s = stub();
    await s.pauseAgentType(agentId, {
      reason: "frozen",
      actorId: actor.id,
      actorType: "user",
    });
    const issue = await s.createIssue({ title: "no holds" });
    await expect(
      dispatchAgent(
        env,
        agentId,
        actor.organizationId,
        issue,
        actor,
        undefined,
        undefined,
        { onPaused: "fail" }
      )
    ).rejects.toMatchObject({ code: "AGENT_PAUSED" });
    const sessions = await s.listAgentSessions({ issueId: issue.id });
    expect(sessions).toHaveLength(0);
    await s.resumeAgentType(agentId, {
      actorId: actor.id,
      actorType: "user",
    });
  });

  it("refuses a stale dispatch on a finished issue whose lane PR merged (VTX-621)", async () => {
    const s = stub();
    const agentId = `mock-merged-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(agentId, () => new MockAgentProvider(agentId));
    const issue = await s.createIssue({
      title: "already shipped",
      repo: "acme/widgets",
    });
    await s.updateIssue(issue.id, { status: "done" }, actor.id);
    const mergedPr = {
      number: 900,
      html_url: "https://github.com/acme/widgets/pull/900",
      title: `${issue.identifier} shipped work`,
      body: null,
      head: { ref: "merged-branch" },
      merged_at: "2026-10-20T12:00:00Z",
    };
    const dedupeDeps = {
      tokenForRepo: async () => "gh-token",
      fetch: async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/pulls?state=closed")) {
          return new Response(JSON.stringify([mergedPr]), { status: 200 });
        }
        return new Response("[]", { status: 200 });
      },
    };
    const done = await s.getIssue(issue.id);
    await expect(
      dispatchAgent(
        env,
        agentId,
        actor.organizationId,
        done!,
        actor,
        undefined,
        undefined,
        {
          dedupeDeps,
        }
      )
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // A reopened issue with the same merged PR dispatches normally — the
    // merged PR is history; the lane opens a fresh one (PILE-257).
    await s.updateIssue(issue.id, { status: "todo" }, actor.id);
    const reopened = await s.getIssue(issue.id);
    const session = await dispatchAgent(
      env,
      agentId,
      actor.organizationId,
      reopened!,
      actor,
      undefined,
      undefined,
      { dedupeDeps }
    );
    expect(session.status).toBe("created");
  });

  it("recalls issue.identifier and issue.repo facts into dispatch instructions (VTX-645)", async () => {
    const s = stub();
    let capturedInstructions: string | null | undefined;
    const agentId = `mock-mem-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: (_org, _issue, _model, ctx) => {
            capturedInstructions = ctx?.instructions;
            return { id: "prov-mem", agentId, status: "running" };
          },
        })
    );
    const issue = await s.createIssue({
      title: "memory recall test",
      repo: "VortexNYC/pile",
    });
    await s.memoryRemember({
      entityType: "issue",
      entityId: issue.identifier!,
      kind: "lesson",
      fact: "identifier-keyed lesson for lane",
    });
    await s.memoryRemember({
      entityType: "repo",
      entityId: "VortexNYC/pile",
      kind: "toolchain",
      fact: "use pnpm only, never npm",
    });
    await dispatchAgent(env, agentId, actor.organizationId, issue, actor);
    expect(capturedInstructions).toContain("identifier-keyed lesson for lane");
    expect(capturedInstructions).toContain("use pnpm only, never npm");
  });

  it("caps review lanes at reviewConcurrencyCap without pausing implementation dispatches (VTX-648)", async () => {
    const s = stub();
    const agentId = `mock-revcap-${crypto.randomUUID().slice(0, 8)}`;
    const dispatchedIds: string[] = [];
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          maxConcurrentLanes: 4,
          dispatch: (_org, _issue, _model, ctx) => {
            dispatchedIds.push(ctx?.sessionId ?? "");
            return { id: `prov-${ctx?.sessionId}`, agentId, status: "running" };
          },
        })
    );
    // maxConcurrentLanes=4 -> reviewCap=2. First 2 review lanes run; 3rd holds locally.
    const r1Issue = await s.createIssue({ title: "rev 1" });
    const r2Issue = await s.createIssue({ title: "rev 2" });
    const r3Issue = await s.createIssue({ title: "rev 3" });
    const r1 = await dispatchAgent(
      env,
      agentId,
      actor.organizationId,
      r1Issue,
      actor,
      undefined,
      undefined,
      { purpose: "review" }
    );
    const r2 = await dispatchAgent(
      env,
      agentId,
      actor.organizationId,
      r2Issue,
      actor,
      undefined,
      undefined,
      { purpose: "review" }
    );
    const r3 = await dispatchAgent(
      env,
      agentId,
      actor.organizationId,
      r3Issue,
      actor,
      undefined,
      undefined,
      { purpose: "review" }
    );
    expect(r1.status).toBe("running");
    expect(r2.status).toBe("running");
    expect(r3.status).toBe("waiting");
    expect(r3.paused).toBe(1);
    // Agent type is NOT paused workspace-wide — an implementation lane still dispatches!
    expect(await s.getAgentPause(agentId)).toBeUndefined();
    const implIssue = await s.createIssue({ title: "impl work" });
    const impl = await dispatchAgent(
      env,
      agentId,
      actor.organizationId,
      implIssue,
      actor
    );
    expect(impl.status).toBe("running");
    expect(impl.paused).toBe(0);
    expect(dispatchedIds).toContain(impl.id);
  });

  it("provisions PgxLaneDb when org metadata configures provider=pgx for the issue repo (VTX-651)", async () => {
    const s = stub();
    let capturedExtraEnv: Record<string, string> | undefined;
    const agentId = `mock-pgx-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: (_org, _issue, _model, ctx) => {
            capturedExtraEnv = ctx?.extraEnv;
            return { id: "prov-pgx", agentId, status: "running" };
          },
        })
    );
    const db = createD1(env.D1);
    await db
      .update(organization)
      .set({
        metadata: JSON.stringify({
          key: "IS",
          laneDb: {
            "VortexNYC/vortex": {
              provider: "pgx",
              template: "vortex_base",
              ttl: "2h",
            },
          },
        }),
      })
      .where(eq(organization.id, actor.organizationId));
    const issue = await s.createIssue({
      title: "pgx lane db test",
      repo: "VortexNYC/vortex",
    });
    const session = await dispatchAgent(
      env,
      agentId,
      actor.organizationId,
      issue,
      actor
    );
    expect(session.laneDbRef).toContain('"provider":"pgx"');
    expect(capturedExtraEnv?.PILE_PGX_TEMPLATE).toBe("vortex_base");
    expect(capturedExtraEnv?.PILE_PGX_TTL).toBe("2h");
    expect(capturedExtraEnv?.DATABASE_URL).toContain("127.0.0.1:5432/lane_");
  });
});
