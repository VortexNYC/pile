import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { agentLogToken } from "../agents/credentials.js";
import { MockAgentProvider } from "../agents/harness.js";
import { registerAgentProvider } from "../agents/index.js";
import { createD1 } from "../global/db.js";
import {
  githubInstallations,
  organization,
  user as userTable,
} from "../global/schema.js";
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
    const auth = await createAuth(env);
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

  it("dispatches an agent on a repo-less issue (research/docs/design work)", async () => {
    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Write onboarding doc" }),
      }),
      env
    );
    expect(issueRes.status).toBe(201);
    const issue = await issueRes.json<{ id: string; repo: unknown }>();
    expect(issue.repo).toBeNull();

    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({ agentId: "mock" }),
      }),
      env
    );
    expect(dispatchRes.status).toBe(201);
    const session = await dispatchRes.json<{ status: string }>();
    expect(session.status).toBe("created");
  });

  it("falls back to the repo's default agent when none is given", async () => {
    const db = createD1(env.D1);
    const agentId = `mock-repo-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(agentId, () => new MockAgentProvider(agentId));
    const repo = "VortexNYC/other-repo";
    await db.insert(githubInstallations).values({
      id: crypto.randomUUID(),
      organizationId,
      installationId: "inst-1",
      repo,
      defaultAgentId: agentId,
    });

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Repo default", repo }),
      }),
      env
    );
    const issue = await issueRes.json<{ id: string }>();

    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({}),
      }),
      env
    );
    expect(dispatchRes.status).toBe(201);
    const session = await dispatchRes.json<{ agentId: string }>();
    expect(session.agentId).toBe(agentId);
  });

  it("returns a preflight report and flags gaps on the thread once", async () => {
    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Fix the thing",
          description: "TBD.",
        }),
      }),
      env
    );
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
      preflight?: { ready: boolean; missing: string[] };
    }>();
    expect(session.preflight?.ready).toBe(false);
    expect(session.preflight?.missing.length).toBeGreaterThan(0);

    const commentsRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/comments`, {
        token,
      }),
      env
    );
    const comments = await commentsRes.json<{
      comments: Array<{ externalSource: string | null; body: string }>;
    }>();
    const flagged = (comments.comments ?? comments).filter(
      (c: { externalSource: string | null }) => c.externalSource === "preflight"
    );
    expect(flagged.length).toBe(1);
  });

  it("preflight dispatch creates a repo-less critique session", async () => {
    const agentId = `mock-pf-${crypto.randomUUID().slice(0, 8)}`;
    let seenRepo: string | null | undefined;
    let seenInstructions: string | undefined;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: (_org, dispatchedIssue, _model, ctx) => {
            seenRepo = dispatchedIssue.repo;
            seenInstructions = ctx?.instructions;
            return {
              id: `pf-${crypto.randomUUID()}`,
              agentId,
              issueId: dispatchedIssue.id,
              status: "created" as const,
            };
          },
        })
    );

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Improve the sweep",
          description:
            "Lanes should rebase when the base branch moves forward so their PRs never land stale. Verify the sweep detects out-of-date PRs and prompts the lane.",
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
        body: JSON.stringify({ agentId, preflight: true }),
      }),
      env
    );
    expect(dispatchRes.status).toBe(201);
    const session = await dispatchRes.json<{
      purpose?: string | null;
      preflight?: { ready: boolean };
    }>();
    expect(session.purpose).toBe("preflight");
    expect(session.preflight?.ready).toBe(true);
    expect(seenRepo).toBeNull();
    expect(seenInstructions).toContain("do NOT implement");
    expect(seenInstructions).toContain("VortexNYC/pile");
  });

  it("sets a repo's default agent via installation PATCH", async () => {
    const db = createD1(env.D1);
    const instId = crypto.randomUUID();
    const repo = "VortexNYC/patch-repo";
    await db.insert(githubInstallations).values({
      id: instId,
      organizationId,
      installationId: "inst-2",
      repo,
    });

    const patchRes = await app.fetch(
      request(`/workspaces/${organizationId}/github/installations/${instId}`, {
        method: "PATCH",
        token,
        body: JSON.stringify({ defaultAgentId: "devin" }),
      }),
      env
    );
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json<{ defaultAgentId: string }>();
    expect(updated.defaultAgentId).toBe("devin");

    const badRes = await app.fetch(
      request(`/workspaces/${organizationId}/github/installations/${instId}`, {
        method: "PATCH",
        token,
        body: JSON.stringify({ defaultAgentId: "not-a-provider" }),
      }),
      env
    );
    expect(badRes.status).toBe(400);
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

  it("accepts repo/branch/instructions overrides without mutating the issue", async () => {
    let captured:
      | {
          issue: { repo?: string | null; branch?: string | null };
          context?: { instructions?: string };
        }
      | undefined;
    registerAgentProvider(
      "mock-override",
      () =>
        new MockAgentProvider("mock-override", {
          dispatch: (_org, dispatchedIssue, _model, ctx) => {
            captured = { issue: dispatchedIssue, context: ctx };
            return {
              id: "override-1",
              agentId: "mock-override",
              status: "created",
            };
          },
        })
    );

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Override dispatch" }),
      }),
      env
    );
    expect(issueRes.status).toBe(201);
    const issue = await issueRes.json<{ id: string }>();

    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({
          agentId: "mock-override",
          repo: "VortexNYC/other",
          branch: "feat/override",
          instructions: "Stay inside src/api",
        }),
      }),
      env
    );
    expect(dispatchRes.status).toBe(201);
    expect(captured?.issue.repo).toBe("VortexNYC/other");
    expect(captured?.issue.branch).toBe("feat/override");
    expect(captured?.context?.instructions).toBe("Stay inside src/api");

    const getRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}`, { token }),
      env
    );
    const stored = await getRes.json<{
      repo: string | null;
      branch: string | null;
    }>();
    expect(stored.repo).toBeNull();
    expect(stored.branch).toBeNull();
  });

  it("prefers stored repo/branch when no overrides are given", async () => {
    let captured: { repo?: string | null; branch?: string | null } | undefined;
    registerAgentProvider(
      "mock-stored",
      () =>
        new MockAgentProvider("mock-stored", {
          dispatch: (_org, dispatchedIssue) => {
            captured = dispatchedIssue;
            return {
              id: "stored-1",
              agentId: "mock-stored",
              status: "created",
            };
          },
        })
    );

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Stored repo",
          repo: "VortexNYC/pile",
          branch: "iss-42",
        }),
      }),
      env
    );
    const issue = await issueRes.json<{ id: string }>();

    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({ agentId: "mock-stored" }),
      }),
      env
    );
    expect(dispatchRes.status).toBe(201);
    expect(captured?.repo).toBe("VortexNYC/pile");
    expect(captured?.branch).toBe("iss-42");
  });

  it("retries a completed session into a new session on the same lane branch", async () => {
    const agentId = `mock-retry-${crypto.randomUUID().slice(0, 8)}`;
    let seenBranch: string | null | undefined;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: (_org, dispatchedIssue) => {
            seenBranch = dispatchedIssue.branch;
            return {
              id: `rs-${crypto.randomUUID()}`,
              agentId,
              issueId: dispatchedIssue.id,
              status: "created" as const,
            };
          },
        })
    );

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({
          title: "Retry lane",
          repo: "acme/roadmap",
          branch: "lane/pile-249",
        }),
      }),
      env
    );
    expect(issueRes.status).toBe(201);
    const issue = await issueRes.json<{ id: string }>();

    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: "user-1",
      actorType: "user",
      status: "completed",
      result: "opened a PR",
    });

    const retryRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/retry`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ context: "address the review feedback" }),
        }
      ),
      env
    );
    expect(retryRes.status).toBe(201);
    const retried = await retryRes.json<{
      id: string;
      issueId: string;
      status: string;
    }>();
    expect(retried.id).not.toBe(session.id);
    expect(retried.issueId).toBe(issue.id);
    // The lane branch is already on the issue — the new session resumes it.
    expect(seenBranch).toBe("lane/pile-249");
    const stored = await stub.getAgentSession(retried.id);
    expect(stored?.retryOf).toBe(session.id);
    expect(stored?.retryCount).toBe(1);
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

  it("guards the lane github-token mint with per-session token auth", async () => {
    const sessionId = crypto.randomUUID();
    const laneToken = await agentLogToken(
      env as unknown as WorkerEnv,
      organizationId,
      sessionId
    );
    const base = `/workspaces/${organizationId}/agent/sessions/${sessionId}/github-token`;

    const noAuth = await app.fetch(request(base, { method: "POST" }), env);
    expect([401, 403]).toContain(noAuth.status);

    const badToken = await app.fetch(
      request(base, {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
      }),
      env
    );
    expect(badToken.status).toBe(401);

    // Valid lane token, unknown session → 404 (token can't mint for another
    // session id, and a real session is required to resolve the repo).
    const unknown = await app.fetch(
      request(base, {
        method: "POST",
        headers: { Authorization: `Bearer ${laneToken}` },
      }),
      env
    );
    expect(unknown.status).toBe(404);
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

  it("registers an external agent session and returns lane credentials", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "External session",
      repo: "VortexNYC/pile",
    });

    const res = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/register`, {
        method: "POST",
        token,
        body: JSON.stringify({
          issueId: issue.id,
          provider: "cursor-cloud",
          providerSessionId: "cursor-ext-1",
          status: "running",
          url: "https://cursor.com/agents/abc",
          branch: "cursor/fix-thing",
        }),
      }),
      env
    );
    expect(res.status).toBe(201);
    const body = await res.json<{
      session: { id: string; providerSessionId: string | null; status: string };
      laneToken: string;
      logUrl: string | null;
      reportUrl: string | null;
    }>();
    expect(body.session.providerSessionId).toBe("cursor-ext-1");
    expect(body.session.status).toBe("running");
    expect(body.laneToken).toBeTruthy();
    expect(body.reportUrl).toContain(
      `/agent/sessions/${body.session.id}/report`
    );

    // Re-registering the same provider session dedupes to the same row.
    const again = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/register`, {
        method: "POST",
        token,
        body: JSON.stringify({
          issueId: issue.id,
          provider: "cursor-cloud",
          providerSessionId: "cursor-ext-1",
        }),
      }),
      env
    );
    expect(again.status).toBe(200);
    const againBody = await again.json<{ session: { id: string } }>();
    expect(againBody.session.id).toBe(body.session.id);
  });

  it("rejects registration for a missing issue", async () => {
    const res = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/register`, {
        method: "POST",
        token,
        body: JSON.stringify({
          issueId: crypto.randomUUID(),
          provider: "cursor-cloud",
        }),
      }),
      env
    );
    expect(res.status).toBe(404);
  });

  it("lets a registered external session report via its lane token", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "Report test",
      repo: "VortexNYC/pile",
    });
    const reg = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/register`, {
        method: "POST",
        token,
        body: JSON.stringify({ issueId: issue.id, provider: "custom-bot" }),
      }),
      env
    );
    const { session, laneToken } = await reg.json<{
      session: { id: string };
      laneToken: string;
    }>();
    const reportBase = `/workspaces/${organizationId}/agent/sessions/${session.id}/report`;

    // No token / wrong token → 401.
    const noAuth = await app.fetch(
      request(reportBase, {
        method: "POST",
        body: JSON.stringify({ status: "running" }),
      }),
      env
    );
    expect([401, 403]).toContain(noAuth.status);
    const badToken = await app.fetch(
      request(reportBase, {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
        body: JSON.stringify({ status: "running" }),
      }),
      env
    );
    expect(badToken.status).toBe(401);

    // A lane token minted for a *different* session must not work here.
    const otherToken = await agentLogToken(
      env as unknown as WorkerEnv,
      organizationId,
      crypto.randomUUID()
    );
    const cross = await app.fetch(
      request(reportBase, {
        method: "POST",
        headers: { Authorization: `Bearer ${otherToken}` },
        body: JSON.stringify({ status: "running" }),
      }),
      env
    );
    expect(cross.status).toBe(401);

    // Invalid status rejected.
    const badStatus = await app.fetch(
      request(reportBase, {
        method: "POST",
        headers: { Authorization: `Bearer ${laneToken}` },
        body: JSON.stringify({ status: "exploded" }),
      }),
      env
    );
    expect(badStatus.status).toBe(400);

    // Non-lifecycle fields land.
    const fields = await app.fetch(
      request(reportBase, {
        method: "POST",
        headers: { Authorization: `Bearer ${laneToken}` },
        body: JSON.stringify({
          url: "https://example.com/run",
          branch: "bot/branch",
          prUrl: "https://github.com/VortexNYC/pile/pull/999",
        }),
      }),
      env
    );
    expect(fields.status).toBe(200);
    const got = await stub.getAgentSession(session.id);
    expect(got?.branch).toBe("bot/branch");
    expect(got?.prUrl).toBe("https://github.com/VortexNYC/pile/pull/999");
    expect(got?.lastProgressAt).toBeTruthy();

    // Terminal transition flows through the result path.
    const done = await app.fetch(
      request(reportBase, {
        method: "POST",
        headers: { Authorization: `Bearer ${laneToken}` },
        body: JSON.stringify({ status: "completed", result: "all done" }),
      }),
      env
    );
    expect(done.status).toBe(200);
    const final = await stub.getAgentSession(session.id);
    expect(final?.status).toBe("completed");
    expect(final?.result).toBe("all done");
    // A bare status report must not wipe fields set by earlier reports —
    // caught live: the completion report nulled prUrl/branch.
    expect(final?.prUrl).toBe("https://github.com/VortexNYC/pile/pull/999");
    expect(final?.branch).toBe("bot/branch");

    // Terminal sessions refuse further reports.
    const after = await app.fetch(
      request(reportBase, {
        method: "POST",
        headers: { Authorization: `Bearer ${laneToken}` },
        body: JSON.stringify({ status: "running" }),
      }),
      env
    );
    expect(after.status).toBe(409);
  });

  it("lets a lane token read back its own session and events (PILE-232)", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.createIssue({
      title: "Lane read test",
      repo: "VortexNYC/pile",
    });
    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: "mock",
      provider: "mock",
      actorId: "user-1",
      actorType: "user",
      status: "running",
      providerSessionId: "lane-read-1",
    });
    const laneToken = await agentLogToken(
      env as unknown as WorkerEnv,
      organizationId,
      session.id
    );

    const getRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        headers: { Authorization: `Bearer ${laneToken}` },
      }),
      env
    );
    expect(getRes.status).toBe(200);
    const got = await getRes.json<{ id: string; status: string }>();
    expect(got.id).toBe(session.id);

    const evRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/events`,
        { headers: { Authorization: `Bearer ${laneToken}` } }
      ),
      env
    );
    expect(evRes.status).toBe(200);

    // No prUrl → checks resolves empty without touching GitHub.
    const checksRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/checks`,
        { headers: { Authorization: `Bearer ${laneToken}` } }
      ),
      env
    );
    expect(checksRes.status).toBe(200);
    const checks = await checksRes.json<{ checks: unknown[] }>();
    expect(checks.checks).toEqual([]);

    // A token minted for a different session cannot read this one.
    const foreign = await agentLogToken(
      env as unknown as WorkerEnv,
      organizationId,
      crypto.randomUUID()
    );
    const cross = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        headers: { Authorization: `Bearer ${foreign}` },
      }),
      env
    );
    expect([401, 403]).toContain(cross.status);

    // No credentials → not a lane request, falls to workspace auth → 401.
    const anon = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`),
      env
    );
    expect([401, 403]).toContain(anon.status);

    // Workspace tokens keep working on the same path (no regression).
    const wsRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        token,
      }),
      env
    );
    expect(wsRes.status).toBe(200);
  });

  describe("dispatch-batch", () => {
    // Separate workspace: the shared org accumulates live sessions across the
    // suite and trips the per-workspace active-lane ceiling.
    let batchOrg: string;
    let batchToken: string;

    beforeAll(async () => {
      const db = createD1(env.D1);
      const headers = await createAdminHeaders(env, "user-1");
      const workspace = await createWorkspace(db, env, headers, {
        name: "Batch dispatch tests",
        slug: `batch-dispatch-${crypto.randomUUID()}`,
        ownerId: "user-1",
      });
      batchOrg = workspace!.id;
      const auth = await createAuth(env);
      const result = await auth.api.createApiKey({
        body: {
          userId: "user-1",
          name: "batch-dispatch",
          metadata: { organizationId: batchOrg, permissions: "admin" },
        },
      });
      batchToken = z.object({ key: z.string() }).parse(result).key;
    });

    const createIssue = async (title: string) => {
      const res = await app.fetch(
        request(`/workspaces/${batchOrg}/issues`, {
          method: "POST",
          token: batchToken,
          body: JSON.stringify({ title }),
        }),
        env
      );
      expect(res.status).toBe(201);
      return (await res.json<{ id: string }>()).id;
    };

    type BatchResult = {
      issueId: string;
      sessionId: string | null;
      status: string | null;
      error: string | null;
    };

    const postBatch = (items: unknown[]) =>
      app.fetch(
        request(`/workspaces/${batchOrg}/agent/dispatch-batch`, {
          method: "POST",
          token: batchToken,
          body: JSON.stringify({ items }),
        }),
        env
      );

    it("dispatches every item in one call and returns all session ids", async () => {
      const issueIds = await Promise.all([
        createIssue("Batch lane one"),
        createIssue("Batch lane two"),
        createIssue("Batch lane three"),
      ]);

      const res = await postBatch(
        issueIds.map((issueId) => ({ issueId, agentId: "mock" }))
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        batchId: string;
        results: BatchResult[];
      }>();
      expect(body.batchId).toBeTruthy();
      expect(body.results).toHaveLength(3);
      for (const [index, result] of body.results.entries()) {
        expect(result.issueId).toBe(issueIds[index]);
        expect(result.sessionId).toBeTruthy();
        expect(result.status).toBe("created");
        expect(result.error).toBeNull();
      }

      // Each issue got its session plus an activity noting the batch.
      for (const [index, result] of body.results.entries()) {
        const sessionsRes = await app.fetch(
          request(
            `/workspaces/${batchOrg}/agent/sessions?issueId=${issueIds[index]}`,
            { token: batchToken }
          ),
          env
        );
        const sessions = await sessionsRes.json<{
          sessions: { id: string }[];
        }>();
        expect(sessions.sessions.map((s) => s.id)).toContain(result.sessionId);

        const activityRes = await app.fetch(
          request(
            `/workspaces/${batchOrg}/issues/${issueIds[index]}/activity`,
            { token: batchToken }
          ),
          env
        );
        const feed = await activityRes.json<{
          activity: { kind: string; message?: string }[];
        }>();
        const batchNote = feed.activity.find(
          (a) => a.kind === "agent" && a.message?.includes(body.batchId)
        );
        expect(batchNote).toBeTruthy();
      }
    });

    it("reports a conflicted item's error without failing the rest", async () => {
      const conflicted = await createIssue("Already has a lane");
      const ok = await createIssue("Fresh lane");

      const first = await app.fetch(
        request(`/workspaces/${batchOrg}/issues/${conflicted}/dispatch`, {
          method: "POST",
          token: batchToken,
          body: JSON.stringify({ agentId: "mock" }),
        }),
        env
      );
      expect(first.status).toBe(201);

      const res = await postBatch([
        { issueId: conflicted, agentId: "mock" },
        { issueId: ok, agentId: "mock" },
        { issueId: "missing-issue-id", agentId: "mock" },
      ]);
      expect(res.status).toBe(200);
      const body = await res.json<{ results: BatchResult[] }>();
      expect(body.results).toHaveLength(3);
      expect(body.results[0].sessionId).toBeNull();
      expect(body.results[0].error).toContain("active agent session");
      expect(body.results[1].sessionId).toBeTruthy();
      expect(body.results[1].error).toBeNull();
      expect(body.results[2].sessionId).toBeNull();
      expect(body.results[2].error).toBe("Issue not found");
    });

    it("queues an item behind a sibling item via queuedAfter", async () => {
      const blocker = await createIssue("Runs first");
      const queued = await createIssue("Runs after");

      const res = await postBatch([
        { issueId: blocker, agentId: "mock" },
        { issueId: queued, agentId: "mock", queuedAfter: blocker },
      ]);
      expect(res.status).toBe(200);
      const body = await res.json<{ results: BatchResult[] }>();
      expect(body.results[0].status).toBe("created");
      expect(body.results[1].status).toBe("waiting");
      expect(body.results[1].sessionId).toBeTruthy();

      const sessionRes = await app.fetch(
        request(
          `/workspaces/${batchOrg}/agent/sessions/${body.results[1].sessionId}`,
          { token: batchToken }
        ),
        env
      );
      const session = await sessionRes.json<{
        status: string;
        queuedAfter: string | null;
      }>();
      expect(session.status).toBe("waiting");
      expect(session.queuedAfter).toBe(body.results[0].sessionId);
    });

    it("queues an item behind an existing session id", async () => {
      const blocker = await createIssue("Lane already running");
      const queued = await createIssue("Parks behind it");

      const first = await app.fetch(
        request(`/workspaces/${batchOrg}/issues/${blocker}/dispatch`, {
          method: "POST",
          token: batchToken,
          body: JSON.stringify({ agentId: "mock" }),
        }),
        env
      );
      const blockerSession = await first.json<{ id: string }>();

      const res = await postBatch([
        {
          issueId: queued,
          agentId: "mock",
          queuedAfter: blockerSession.id,
        },
      ]);
      expect(res.status).toBe(200);
      const body = await res.json<{ results: BatchResult[] }>();
      expect(body.results[0].status).toBe("waiting");
      expect(body.results[0].sessionId).toBeTruthy();
    });

    it("fails the dependent item when its queuedAfter sibling fails", async () => {
      const missing = "missing-sibling-issue";
      const queued = await createIssue("Orphaned dependent");

      const res = await postBatch([
        { issueId: missing, agentId: "mock" },
        { issueId: queued, agentId: "mock", queuedAfter: missing },
      ]);
      expect(res.status).toBe(200);
      const body = await res.json<{ results: BatchResult[] }>();
      expect(body.results[0].error).toBe("Issue not found");
      expect(body.results[1].sessionId).toBeNull();
      expect(body.results[1].error).toContain("queuedAfter target failed");
    });
  });
});
