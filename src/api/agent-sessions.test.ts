import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { MockAgentProvider } from "../agents/harness.js";
import { registerAgentProvider } from "../agents/index.js";
import { createD1 } from "../global/db.js";
import { organization, user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

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
  let organizationId: string;
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
    const headers = await createAdminHeaders(env, "user-1");
    const workspace = await createWorkspace(db, env, headers, {
      name: "Agent API tests",
      slug: `agent-api-${crypto.randomUUID()}`,
      ownerId: "user-1",
    });
    organizationId = workspace!.id;
    await db
      .update(organization)
      .set({
        metadata: JSON.stringify({
          key: workspace?.key ?? null,
          maxConcurrentAgentChildren: 2,
        }),
      })
      .where(eq(organization.id, organizationId));
    const auth = createAuth(env);
    const result = await auth.api.createApiKey({
      body: {
        userId: "user-1",
        name: "test-admin",
        metadata: { organizationId, permissions: "admin" },
      },
    });
    token = z.object({ key: z.string() }).parse(result).key;

    registerAgentProvider("mock", () => new MockAgentProvider("mock"));
  });

  it("creates a session by dispatching an agent", async () => {
    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Agent test",
          repo: "VortexNYC/pile",
        }),
      }),
      env
    );
    expect(issueRes.status).toBe(201);
    const issue = await issueRes.json<{ id: string }>();

    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
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
      request(
        `/workspaces/${organizationId}/agent/sessions?issueId=${issue.id}`,
        {
          token,
        }
      ),
      env
    );
    expect(listRes.status).toBe(200);
    const list = await listRes.json<{ sessions: unknown[] }>();
    expect(list.sessions.length).toBe(1);

    const getRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        token,
      }),
      env
    );
    expect(getRes.status).toBe(200);
    const got = await getRes.json<{ activities: unknown[] }>();
    expect(got.activities.length).toBeGreaterThanOrEqual(1);

    const eventsRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/events`,
        { token }
      ),
      env
    );
    expect(eventsRes.status).toBe(200);
    const eventsBody = await eventsRes.json<{ events: unknown[] }>();
    expect(eventsBody.events.length).toBeGreaterThanOrEqual(1);

    const missingRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/00000000-0000-0000-0000-000000000000/events`,
        { token }
      ),
      env
    );
    expect(missingRes.status).toBe(404);
  });

  it("appends an activity and updates session state", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-patch",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const activityRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/activities`,
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
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
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

  it("shows live agent state for an issue", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-live",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
      status: "running",
    });
    await stub.addAgentActivity({
      sessionId: session.id,
      actorId: "user-1",
      type: "status",
      message: "Running tests",
    });

    const res = await app.fetch(
      request(`/workspaces/${organizationId}/issues/issue-live/live`, {
        token,
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      session: { id: string; status: string } | null;
      activities: Array<{ type: string; message: string }>;
    }>();
    expect(body.session?.id).toBe(session.id);
    expect(body.session?.status).toBe("running");
    expect(body.activities).toHaveLength(1);
    expect(body.activities[0]?.type).toBe("status");
  });

  it("uses scoped agent:read and agent:write permissions", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-scoped",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const tokenRes = await app.fetch(
      request(`/workspaces/${organizationId}/tokens`, {
        method: "POST",
        token,
        body: JSON.stringify({
          name: "scoped-agent",
          permissions: "agent:read,agent:write",
          actorType: "agent",
        }),
      }),
      env
    );
    expect(tokenRes.status).toBe(201);
    const { token: agentToken } = await tokenRes.json<{ token: string }>();

    const listRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions?issueId=issue-scoped`,
        { token: agentToken }
      ),
      env
    );
    expect(listRes.status).toBe(200);

    const getRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        token: agentToken,
      }),
      env
    );
    expect(getRes.status).toBe(200);

    const activityRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/activities`,
        {
          method: "POST",
          token: agentToken,
          body: JSON.stringify({ type: "thought", message: "scoped" }),
        }
      ),
      env
    );
    expect(activityRes.status).toBe(201);

    const patchRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        method: "PATCH",
        token: agentToken,
        body: JSON.stringify({ status: "completed" }),
      }),
      env
    );
    expect(patchRes.status).toBe(200);

    const readOnlyRes = await app.fetch(
      request(`/workspaces/${organizationId}/tokens`, {
        method: "POST",
        token,
        body: JSON.stringify({
          name: "readonly-agent",
          permissions: "agent:read",
          actorType: "agent",
        }),
      }),
      env
    );
    expect(readOnlyRes.status).toBe(201);
    const { token: readOnlyToken } = await readOnlyRes.json<{
      token: string;
    }>();

    const forbiddenPatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        method: "PATCH",
        token: readOnlyToken,
        body: JSON.stringify({ status: "failed" }),
      }),
      env
    );
    expect(forbiddenPatchRes.status).toBe(403);
  });

  it("creates a child issue and dispatches a child session", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const parent = await stub.createIssue({
      title: "Parent issue",
      repo: "VortexNYC/pile",
    });
    const session = await stub.createAgentSession({
      issueId: parent.id,
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const childRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/children`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ title: "Child task", agentId: "mock" }),
        }
      ),
      env
    );
    expect(childRes.status).toBe(201);
    const child = await childRes.json<{
      session: { id: string; issueId: string };
      issue: { id: string; parentId: string };
    }>();
    expect(child.issue.parentId).toBe(parent.id);
    expect(child.session.issueId).toBe(child.issue.id);

    const secondRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/children`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ title: "Child 2", agentId: "mock" }),
        }
      ),
      env
    );
    expect(secondRes.status).toBe(201);

    const thirdRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/children`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ title: "Child 3", agentId: "mock" }),
        }
      ),
      env
    );
    expect(thirdRes.status).toBe(429);
  });

  it("streams session events as SSE with Last-Event-ID support", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "Stream test",
      repo: "VortexNYC/pile",
    });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const streamRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/stream`,
        { token }
      ),
      env
    );
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type")).toBe("text/event-stream");

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();

    const patchResPromise = app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        method: "PATCH",
        token,
        body: JSON.stringify({ status: "running" }),
      }),
      env
    );

    let buffer = "";
    let found = false;
    while (!found) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes("event: session.status")) {
        found = true;
      }
    }
    await reader.cancel();
    await patchResPromise;

    expect(found).toBe(true);
    expect(buffer).toContain('"type":"session.status"');
    expect(buffer).toContain('"new":"running"');

    const lastEventIdMatch = buffer.match(/id: (\d+)/);
    expect(lastEventIdMatch).not.toBeNull();
    const lastEventId = Number(lastEventIdMatch![1]);

    const reconnectRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/stream`,
        {
          token,
          headers: { "Last-Event-ID": String(lastEventId) },
        }
      ),
      env
    );
    expect(reconnectRes.status).toBe(200);
    await reconnectRes.body?.cancel?.();
  });
});
