import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import { MockAgentProvider } from "./harness.js";
import {
  dispatchAgent,
  getAgentProvider,
  registerAgentProvider,
} from "./index.js";

const actor: WorkspaceIdentity = {
  id: "user-1",
  workspaceId: "",
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
  const workspace = await createWorkspace(db, env, {
    name: "Test workspace",
    slug: "test-ws",
    ownerId: actor.id,
  });
  if (workspace) {
    actor.workspaceId = workspace.id;
  }
});

describe("agent providers", () => {
  it("throws for unknown provider", () => {
    expect(() => getAgentProvider("unknown", env)).toThrow(
      "Unknown agent provider: unknown"
    );
  });

  it("registers and dispatches a mock provider", async () => {
    const provider = new MockAgentProvider("mock", {
      dispatch: () => ({
        id: "test-1",
        agentId: "mock",
        issueId: "issue-1",
        status: "created",
      }),
    });
    registerAgentProvider("mock", () => provider);

    const session = await dispatchAgent(
      env,
      "mock",
      actor.workspaceId,
      {
        id: "issue-1",
        teamId: "team-1",
        title: "Test",
        description: null,
      },
      actor
    );

    expect(session.agentId).toBe("mock");
    expect(session.issueId).toBe("issue-1");
    expect(session.provider).toBe("mock");
    expect(session.actorId).toBe("user-1");
  });

  it("polls a mock session", async () => {
    const provider = new MockAgentProvider("mock", {
      poll: (sessionId) => ({
        id: sessionId,
        agentId: "mock",
        issueId: "issue-1",
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
});
