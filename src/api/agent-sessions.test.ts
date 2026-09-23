import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { agentLogToken } from "../agents/credentials.js";
import { MockAgentProvider } from "../agents/harness.js";
import { registerAgentProvider } from "../agents/index.js";
import { createD1 } from "../global/db.js";
import { organization, user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import type { WorkerEnv } from "../platform/middleware.js";
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

  it("dispatches via the provider alias and rejects unknown body keys", async () => {
    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Alias", repo: "VortexNYC/pile" }),
      }),
      env
    );
    expect(issueRes.status).toBe(201);
    const issue = await issueRes.json<{ id: string }>();

    const aliasRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({ provider: "mock" }),
      }),
      env
    );
    expect(aliasRes.status).toBe(201);
    const session = await aliasRes.json<{ agentId: string }>();
    expect(session.agentId).toBe("mock");

    const badRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({ provdier: "mock" }),
      }),
      env
    );
    expect(badRes.status).toBe(400);
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

  it("records span activities with parent links and close-out duration", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-span",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const spanRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/activities`,
        {
          method: "POST",
          token,
          body: JSON.stringify({
            type: "action",
            message: "provision sandbox",
            startedAt: new Date(Date.now() - 1500).toISOString(),
          }),
        }
      ),
      env
    );
    expect(spanRes.status).toBe(201);
    const span = await spanRes.json<{
      id: string;
      startedAt: string | null;
      endedAt: string | null;
    }>();
    expect(span.startedAt).toBeTruthy();
    expect(span.endedAt).toBeNull();

    const childRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/activities`,
        {
          method: "POST",
          token,
          body: JSON.stringify({
            type: "status",
            message: "sandbox created",
            parentId: span.id,
          }),
        }
      ),
      env
    );
    expect(childRes.status).toBe(201);
    const child = await childRes.json<{ parentId: string | null }>();
    expect(child.parentId).toBe(span.id);

    const closed = await stub.closeAgentActivity(span.id);
    expect(closed?.endedAt).toBeTruthy();
    expect(closed?.durationMs).toBeGreaterThanOrEqual(0);

    const eventsRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/events`,
        { token }
      ),
      env
    );
    const events = await eventsRes.json<{
      events: {
        id: string;
        parentId: string | null;
        durationMs: number | null;
      }[];
    }>();
    const spanEvent = events.events.find((e) => e.id === span.id);
    expect(spanEvent?.durationMs).toBeGreaterThanOrEqual(0);
    const childEvent = events.events.find((e) => e.parentId === span.id);
    expect(childEvent).toBeTruthy();
  });

  it("captures a text artifact to the session timeline", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-artifact-text",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const res = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/artifacts`,
        {
          method: "POST",
          token,
          body: JSON.stringify({
            name: "diff.patch",
            type: "diff",
            content: "@@ -1 +1 @@\n- old\n+ new",
          }),
        }
      ),
      env
    );
    expect(res.status).toBe(201);

    const activity = await res.json<{
      type: string;
      message: string;
      payload: {
        name: string;
        type: string;
        content: string;
        provider: string;
      };
    }>();
    expect(activity.type).toBe("artifact");
    expect(activity.message).toBe("Artifact: diff.patch");
    expect(activity.payload.type).toBe("diff");
    expect(activity.payload.content).toContain("+ new");
    expect(activity.payload.provider).toBe("mock");

    const eventsRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/events`,
        { token }
      ),
      env
    );
    expect(eventsRes.status).toBe(200);
    const eventsBody = await eventsRes.json<{
      events: Array<{ type: string; payload: { type: string } }>;
    }>();
    expect(
      eventsBody.events.some(
        (event) =>
          event.type === "artifact" || event.payload.type === "artifact"
      )
    ).toBe(true);
  });

  it("captures a binary artifact to R2", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-artifact-binary",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const res = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/artifacts`,
        {
          method: "POST",
          token,
          body: JSON.stringify({
            name: "screenshot.png",
            type: "screenshot",
            data: btoa("binary content"),
            mimeType: "image/png",
          }),
        }
      ),
      env
    );
    expect(res.status).toBe(201);

    const activity = await res.json<{
      payload: { r2Key: string; attachmentId: string };
    }>();
    expect(activity.payload.r2Key).toBeTruthy();
    expect(activity.payload.attachmentId).toBeTruthy();

    const stored = await env.ATTACHMENTS_BUCKET.get(activity.payload.r2Key);
    expect(stored).not.toBeNull();
  });

  it("rejects an artifact with no content, data, or url", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-artifact-empty",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
    });

    const res = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/artifacts`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ name: "empty", type: "other" }),
        }
      ),
      env
    );
    expect(res.status).toBe(400);
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

  it("returns live provider state for sessions that support it", async () => {
    registerAgentProvider(
      "mock-state",
      () =>
        new MockAgentProvider("mock-state", {
          getState: (_providerSessionId, trackerSessionId) => ({
            provider: { status: "running" },
            compute: { sandbox: trackerSessionId },
          }),
        })
    );

    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-state",
      agentId: "mock-state",
      provider: "mock-state",
      actorId: "user-1",
      actorType: "user",
      status: "running",
    });

    const res = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/state`,
        { token }
      ),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session: { id: string; status: string };
      provider: { status: string };
      compute: { sandbox: string };
    };
    expect(body.session.id).toBe(session.id);
    expect(body.provider.status).toBe("running");
    expect(body.compute.sandbox).toBe(session.id);
  });

  it("returns 400 for live state when the agent does not support it", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: "issue-no-state",
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
      status: "running",
    });

    const res = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/state`,
        { token }
      ),
      env
    );
    expect(res.status).toBe(400);
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

  it("probes provider health", async () => {
    registerAgentProvider(
      "healthy",
      () =>
        new MockAgentProvider("healthy", {
          health: () => ({ ok: true, message: "up" }),
        })
    );
    const res = await app.fetch(
      request(`/workspaces/${organizationId}/agent/providers/healthy/health`, {
        method: "POST",
        token,
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; message?: string }>();
    expect(body.ok).toBe(true);
    expect(body.message).toBe("up");
  });

  it("applies inbound provider webhooks onto the matching session", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "Webhook test",
      repo: "VortexNYC/pile",
    });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
      status: "running",
      providerSessionId: "remote-webhook-1",
    });

    const res = await app.fetch(
      request(`/workspaces/${organizationId}/agent/providers/mock/hooks`, {
        method: "POST",
        token,
        body: JSON.stringify({
          session_id: "remote-webhook-1",
          status: "completed",
          result: "done via hook",
        }),
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; sessionId: string }>();
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBe(session.id);

    const got = await stub.getAgentSession(session.id);
    expect(got?.status).toBe("completed");
    expect(got?.result).toBe("done via hook");
  });

  it("accepts inbound provider webhooks with a configured secret", async () => {
    const put = await app.fetch(
      request(`/workspaces/${organizationId}/agent/providers/mock`, {
        method: "PUT",
        token,
        body: JSON.stringify({
          config: { webhookSecret: "hook-secret" },
        }),
      }),
      env
    );
    expect(put.status).toBe(200);
    const saved = await put.json<{
      config: { hasWebhookSecret?: boolean; webhookSecret?: string };
    }>();
    expect(saved.config.hasWebhookSecret).toBe(true);
    expect(saved.config.webhookSecret).toBeUndefined();

    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "Inbound webhook",
      repo: "VortexNYC/pile",
    });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
      status: "running",
      providerSessionId: "remote-inbound-1",
    });

    const denied = await app.fetch(
      request(`/webhooks/agent/${organizationId}/mock`, {
        method: "POST",
        body: JSON.stringify({
          session_id: "remote-inbound-1",
          status: "failed",
        }),
      }),
      env
    );
    expect(denied.status).toBe(401);

    const res = await app.fetch(
      request(`/webhooks/agent/${organizationId}/mock`, {
        method: "POST",
        headers: { "X-Pile-Webhook-Secret": "hook-secret" },
        body: JSON.stringify({
          session_id: "remote-inbound-1",
          status: "failed",
          result: "provider push",
        }),
      }),
      env
    );
    expect(res.status).toBe(200);
    const got = await stub.getAgentSession(session.id);
    expect(got?.status).toBe("failed");
    expect(got?.result).toBe("provider push");
  });

  it("captures a PR URL from poll as a session artifact", async () => {
    registerAgentProvider(
      "pr-mock",
      () =>
        new MockAgentProvider("pr-mock", {
          dispatch: (_org, issue) => ({
            id: "pr-remote",
            agentId: "pr-mock",
            issueId: issue.id,
            status: "running",
          }),
          poll: (sessionId) => ({
            id: sessionId,
            agentId: "pr-mock",
            status: "running",
            prUrl: "https://github.com/VortexNYC/pile/pull/999",
            prState: "open",
          }),
        })
    );
    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "PR artifact",
          repo: "VortexNYC/pile",
        }),
      }),
      env
    );
    const issue = await issueRes.json<{ id: string }>();
    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({ agentId: "pr-mock" }),
      }),
      env
    );
    const session = await dispatchRes.json<{ id: string }>();
    const pollRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/poll`,
        { method: "POST", token }
      ),
      env
    );
    expect(pollRes.status).toBe(200);
    const polled = await pollRes.json<{
      activities: Array<{ type: string; payload: { url?: string } | null }>;
    }>();
    const artifact = polled.activities.find((a) => a.type === "artifact");
    expect(artifact?.payload?.url).toBe(
      "https://github.com/VortexNYC/pile/pull/999"
    );
  });

  it("serves the runner pnpm-store cache with per-session token auth", async () => {
    const sessionId = crypto.randomUUID();
    const cacheToken = await agentLogToken(
      env as unknown as WorkerEnv,
      organizationId,
      sessionId
    );
    const hash = "ab".repeat(32);
    const base = `/workspaces/${organizationId}/agent/sessions/${sessionId}/cache/pnpm-store/${hash}`;

    // No credentials at all: rejected by CSRF middleware before the route.
    const noAuth = await app.fetch(
      request(base, { method: "PUT", body: "store-bytes" }),
      env
    );
    expect([401, 403]).toContain(noAuth.status);

    const badToken = await app.fetch(
      request(base, {
        method: "PUT",
        body: "store-bytes",
        headers: { Authorization: "Bearer wrong" },
      }),
      env
    );
    expect(badToken.status).toBe(401);

    const badHash = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${sessionId}/cache/pnpm-store/nothex`,
        {
          method: "PUT",
          body: "x",
          headers: { Authorization: `Bearer ${cacheToken}` },
        }
      ),
      env
    );
    expect(badHash.status).toBe(401);

    const put = await app.fetch(
      request(base, {
        method: "PUT",
        body: "store-bytes",
        headers: { Authorization: `Bearer ${cacheToken}` },
      }),
      env
    );
    expect(put.status).toBe(200);

    const get = await app.fetch(
      request(base, {
        headers: { Authorization: `Bearer ${cacheToken}` },
      }),
      env
    );
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("store-bytes");

    // Multipart path: parts + manifest reassemble into one stream.
    const mhash = "ef".repeat(32);
    const mbase = `/workspaces/${organizationId}/agent/sessions/${sessionId}/cache/pnpm-store/${mhash}`;
    for (const [i, chunk] of ["part-a-", "part-b"].entries()) {
      const res = await app.fetch(
        request(`${mbase}/parts/${i}`, {
          method: "PUT",
          body: chunk,
          headers: { Authorization: `Bearer ${cacheToken}` },
        }),
        env
      );
      expect(res.status).toBe(200);
    }
    const man = await app.fetch(
      request(`${mbase}/manifest`, {
        method: "PUT",
        body: JSON.stringify({ parts: 2 }),
        headers: { Authorization: `Bearer ${cacheToken}` },
      }),
      env
    );
    expect(man.status).toBe(200);
    const joined = await app.fetch(
      request(mbase, { headers: { Authorization: `Bearer ${cacheToken}` } }),
      env
    );
    expect(joined.status).toBe(200);
    expect(await joined.text()).toBe("part-a-part-b");

    const miss = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${sessionId}/cache/pnpm-store/${"cd".repeat(32)}`,
        { headers: { Authorization: `Bearer ${cacheToken}` } }
      ),
      env
    );
    expect(miss.status).toBe(404);
  });
});
