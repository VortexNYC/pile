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

// PILE-421 — structured handoffs between sub-step agents: a completing lane
// posts {step_key, outputs, next_agent, evidence}; the record anchors on the
// parent issue and is queryable there, and a requireHandoff lane cannot
// complete until its record exists.
describe("agent handoffs API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: "user-handoffs",
        name: "Handoff User",
        email: "handoffs-user@example.com",
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, "user-handoffs");
    const workspace = await createWorkspace(db, env, headers, {
      name: "Handoff tests",
      slug: `handoffs-${crypto.randomUUID()}`,
      ownerId: "user-handoffs",
    });
    organizationId = workspace!.id;
    await db
      .update(organization)
      .set({
        metadata: JSON.stringify({ key: workspace?.key ?? null }),
      })
      .where(eq(organization.id, organizationId));
    const auth = await createAuth(env);
    const result = await auth.api.createApiKey({
      body: {
        userId: "user-handoffs",
        name: "handoffs-admin",
        metadata: { organizationId, permissions: "admin" },
      },
    });
    token = z.object({ key: z.string() }).parse(result).key;
    registerAgentProvider("mock", () => new MockAgentProvider("mock"));
  });

  const createIssue = async (body: Record<string, unknown>) => {
    const res = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify(body),
      }),
      env
    );
    expect(res.status).toBe(201);
    return res.json<{ id: string }>();
  };

  it("gates completion on a posted handoff and anchors it on the parent", async () => {
    const parent = await createIssue({ title: "Deal record" });
    const sub = await createIssue({ title: "Sourced", parentId: parent.id });

    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${sub.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({
          agentId: "mock",
          stepKey: "sourced",
          requireHandoff: true,
        }),
      }),
      env
    );
    expect(dispatchRes.status).toBe(201);
    const session = await dispatchRes.json<{
      id: string;
      stepKey: string | null;
      handoffRequired?: number;
    }>();
    expect(session.stepKey).toBe("sourced");
    expect(session.handoffRequired).toBe(1);

    // Completing without a handoff is rejected — the write fails 409 and
    // the lane stays non-terminal.
    const early = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        method: "PATCH",
        token,
        body: JSON.stringify({ status: "completed", result: "done" }),
      }),
      env
    );
    expect(early.status).toBe(409);

    const handoffRes = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/handoffs`,
        {
          method: "POST",
          token,
          body: JSON.stringify({
            outputs: { domain: "acme.com", score: 0.8 },
            nextAgent: "profiler",
            evidence: [
              { type: "document", ref: "doc-1", label: "Source notes" },
            ],
          }),
        }
      ),
      env
    );
    expect(handoffRes.status).toBe(201);
    const handoff = await handoffRes.json<{
      id: string;
      issueId: string;
      fromIssueId: string | null;
      stepKey: string;
      nextAgent: string | null;
      outputs: Record<string, unknown> | null;
      evidence: Array<{ ref: string; type?: string; label?: string }> | null;
    }>();
    expect(handoff.issueId).toBe(parent.id);
    expect(handoff.fromIssueId).toBe(sub.id);
    expect(handoff.stepKey).toBe("sourced");
    expect(handoff.nextAgent).toBe("profiler");
    expect(handoff.outputs).toEqual({ domain: "acme.com", score: 0.8 });
    expect(handoff.evidence?.[0]?.ref).toBe("doc-1");

    // An identical replay is idempotent (200 with the same row); a
    // divergent second post conflicts.
    const replay = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/handoffs`,
        {
          method: "POST",
          token,
          body: JSON.stringify({
            outputs: { domain: "acme.com", score: 0.8 },
            nextAgent: "profiler",
            evidence: [
              { type: "document", ref: "doc-1", label: "Source notes" },
            ],
          }),
        }
      ),
      env
    );
    expect(replay.status).toBe(200);
    expect((await replay.json<{ id: string }>()).id).toBe(handoff.id);

    const divergent = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/handoffs`,
        {
          method: "POST",
          token,
          body: JSON.stringify({ outputs: { domain: "other.com" } }),
        }
      ),
      env
    );
    expect(divergent.status).toBe(409);

    // Completion succeeds once the record exists.
    const done = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/${session.id}`, {
        method: "PATCH",
        token,
        body: JSON.stringify({ status: "completed", result: "done" }),
      }),
      env
    );
    expect(done.status).toBe(200);

    // The timeline query: by parent issue, filterable by step_key.
    const listRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${parent.id}/handoffs`, {
        token,
      }),
      env
    );
    expect(listRes.status).toBe(200);
    const { handoffs } = await listRes.json<{
      handoffs: Array<{ id: string; stepKey: string }>;
    }>();
    expect(handoffs.map((h) => h.id)).toEqual([handoff.id]);

    const filtered = await app.fetch(
      request(
        `/workspaces/${organizationId}/issues/${parent.id}/handoffs?stepKey=nope`,
        { token }
      ),
      env
    );
    expect(
      (await filtered.json<{ handoffs: unknown[] }>()).handoffs
    ).toHaveLength(0);

    const bySession = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/handoffs`,
        { token }
      ),
      env
    );
    expect(
      (
        await bySession.json<{ handoffs: Array<{ id: string }> }>()
      ).handoffs.map((h) => h.id)
    ).toEqual([handoff.id]);
  });

  it("accepts a lane-token post for the session it is bound to", async () => {
    const issue = await createIssue({ title: "Lane emit" });
    const registerRes = await app.fetch(
      request(`/workspaces/${organizationId}/agent/sessions/register`, {
        method: "POST",
        token,
        body: JSON.stringify({ issueId: issue.id, provider: "external" }),
      }),
      env
    );
    expect(registerRes.status).toBe(201);
    const { session, laneToken } = await registerRes.json<{
      session: { id: string };
      laneToken: string;
    }>();
    expect(laneToken).toBeTruthy();

    // The lane posts its own handoff with the per-session HMAC bearer —
    // the same credential the /report route accepts.
    const res = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${session.id}/handoffs`,
        {
          method: "POST",
          token: laneToken,
          body: JSON.stringify({
            stepKey: "external-step",
            outputs: { verdict: "ok" },
          }),
        }
      ),
      env
    );
    expect(res.status).toBe(201);
    const handoff = await res.json<{ stepKey: string; issueId: string }>();
    expect(handoff.stepKey).toBe("external-step");
    expect(handoff.issueId).toBe(issue.id);

    // A lane token cannot read a different session's handoffs — it fails
    // the per-session token check and falls through to workspace auth.
    const other = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/sessions/${crypto.randomUUID()}/handoffs`,
        { token: laneToken }
      ),
      env
    );
    expect(other.status).toBe(401);
  });
});
