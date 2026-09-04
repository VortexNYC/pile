import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { MockAgentProvider } from "../agents/harness.js";
import { registerAgentProvider } from "../agents/index.js";
import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";

const ORIGIN = "https://your-domain.com";

function request(
  path: string,
  init: RequestInit & { token?: string } = {}
): Request {
  const headers = new Headers(init.headers);
  if (init.token) {
    headers.set("Authorization", `Bearer ${init.token}`);
  }
  if (["POST", "PATCH", "PUT", "DELETE"].includes(init.method ?? "GET")) {
    headers.set("Origin", ORIGIN);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }
  return new Request(`http://localhost${path}`, {
    ...init,
    headers,
  });
}

describe("agent sessions API", () => {
  let workspaceId: string;
  let token: string;

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
      name: "Agent API tests",
      slug: `agent-api-${crypto.randomUUID()}`,
      ownerId: "user-1",
    });
    workspaceId = workspace!.id;
    const auth = createAuth(env);
    const result = await auth.api.createApiKey({
      body: {
        userId: "user-1",
        name: "test-admin",
        metadata: { workspaceId, permissions: "admin" },
      },
    });
    token = z.object({ key: z.string() }).parse(result).key;

    registerAgentProvider("mock", () => new MockAgentProvider("mock"));
  });

  it("creates a session by dispatching an agent", async () => {
    const issueRes = await app.fetch(
      request(`/workspaces/${workspaceId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Agent test" }),
      }),
      env
    );
    expect(issueRes.status).toBe(201);
    const issue = await issueRes.json<{ id: string }>();

    const dispatchRes = await app.fetch(
      request(`/workspaces/${workspaceId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({ agentId: "mock" }),
      }),
      env
    );
    expect(dispatchRes.status).toBe(201);
    const session = await dispatchRes.json<{
      id: string;
      issueId: string;
      status: string;
    }>();
    expect(session.issueId).toBe(issue.id);
    expect(session.status).toBe("created");

    const listRes = await app.fetch(
      request(`/workspaces/${workspaceId}/agent/sessions?issueId=${issue.id}`, {
        token,
      }),
      env
    );
    expect(listRes.status).toBe(200);
    const list = await listRes.json<{ sessions: unknown[] }>();
    expect(list.sessions.length).toBe(1);

    const getRes = await app.fetch(
      request(`/workspaces/${workspaceId}/agent/sessions/${session.id}`, {
        token,
      }),
      env
    );
    expect(getRes.status).toBe(200);
    const got = await getRes.json<{ activities: unknown[] }>();
    expect(got.activities.length).toBeGreaterThanOrEqual(1);
  });

  it("appends an activity and updates session state", async () => {
    const db = createD1(env.D1);
    const { createAgentSession } = await import("../global/agent-sessions.js");
    const session = await createAgentSession(db, {
      workspaceId,
      issueId: "issue-patch",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const activityRes = await app.fetch(
      request(
        `/workspaces/${workspaceId}/agent/sessions/${session.id}/activities`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ type: "thought", message: "Hello" }),
        }
      ),
      env
    );
    expect(activityRes.status).toBe(201);

    const patchRes = await app.fetch(
      request(`/workspaces/${workspaceId}/agent/sessions/${session.id}`, {
        method: "PATCH",
        token,
        body: JSON.stringify({ status: "completed", result: "done" }),
      }),
      env
    );
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json<{
      status: string;
      result: string | null;
    }>();
    expect(patched.status).toBe("completed");
    expect(patched.result).toBe("done");
  });
});
