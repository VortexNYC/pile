import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import {
  addAgentActivity,
  createAgentSession,
  getAgentSession,
  getAgentSessionWithActivities,
  listAgentActivities,
  listAgentSessions,
  updateAgentSession,
} from "./agent-sessions.js";
import { createD1 } from "./db.js";
import { createWorkspace } from "./workspaces.js";

describe("agent sessions", () => {
  let workspaceId: string;

  beforeAll(async () => {
    const db = createD1(env.D1);
    const workspace = await createWorkspace(db, {
      name: "Agent session tests",
      slug: `agent-sessions-${crypto.randomUUID()}`,
      ownerId: "user-1",
    });
    workspaceId = workspace.id;
  });

  it("creates and retrieves a session", async () => {
    const db = createD1(env.D1);
    const session = await createAgentSession(db, {
      workspaceId,
      issueId: "issue-1",
      agentId: "devin",
      provider: "devin",
      actorId: "user-1",
      actorType: "user",
    });

    expect(session.workspaceId).toBe(workspaceId);
    expect(session.issueId).toBe("issue-1");
    expect(session.status).toBe("created");

    const found = await getAgentSession(db, session.id);
    expect(found).not.toBeNull();
    expect(found?.id).toBe(session.id);
  });

  it("lists sessions for a workspace", async () => {
    const db = createD1(env.D1);
    await createAgentSession(db, {
      workspaceId,
      issueId: "issue-list",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const sessions = await listAgentSessions(db, workspaceId);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions[0]?.workspaceId).toBe(workspaceId);
  });

  it("updates session state", async () => {
    const db = createD1(env.D1);
    const session = await createAgentSession(db, {
      workspaceId,
      issueId: "issue-update",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const updated = await updateAgentSession(db, session.id, {
      status: "completed",
      result: "done",
    });
    expect(updated?.status).toBe("completed");
    expect(updated?.result).toBe("done");
  });

  it("adds and lists activities", async () => {
    const db = createD1(env.D1);
    const session = await createAgentSession(db, {
      workspaceId,
      issueId: "issue-activity",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    await addAgentActivity(db, {
      sessionId: session.id,
      actorId: "user-1",
      type: "thought",
      message: "Thinking...",
      payload: { step: 1 },
    });

    const activities = await listAgentActivities(db, session.id);
    expect(activities.length).toBe(1);
    expect(activities[0]?.type).toBe("thought");
    expect(activities[0]?.message).toBe("Thinking...");

    const withActivities = await getAgentSessionWithActivities(db, session.id);
    expect(withActivities?.activities.length).toBe(1);
  });
});
