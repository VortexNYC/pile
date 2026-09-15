import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import { createAdminHeaders } from "../platform/test-auth.js";
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

    const prUrl = "https://github.com/vortexnyc/issuetracker/pull/42";
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
});
