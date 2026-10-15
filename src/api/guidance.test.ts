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

// PILE-423 — guidance packs: scoped markdown instructions injected into
// dispatch prompts, versioned, with versions recorded on each session.
describe("guidance packs API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: "user-guidance",
        name: "Guidance User",
        email: "guidance-user@example.com",
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, "user-guidance");
    const workspace = await createWorkspace(db, env, headers, {
      name: "Guidance tests",
      slug: `guidance-${crypto.randomUUID()}`,
      ownerId: "user-guidance",
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
        userId: "user-guidance",
        name: "guidance-admin",
        metadata: { organizationId, permissions: "admin" },
      },
    });
    token = z.object({ key: z.string() }).parse(result).key;
  });

  it("creates, lists, edits (version bump), versions, and deletes packs", async () => {
    const base = `/workspaces/${organizationId}/agent/guidance`;

    const created = await app.fetch(
      request(base, {
        method: "POST",
        token,
        body: JSON.stringify({
          name: "Outreach rules",
          scope: "status",
          scopeKey: "in_progress",
          body: "No rate or savings numbers.",
          links: [{ label: "Playbook", url: "https://example.com/pb" }],
        }),
      }),
      env
    );
    expect(created.status).toBe(201);
    const pack = await created.json<{
      id: string;
      scope: string;
      scopeKey: string | null;
      version: number;
      links: Array<{ label?: string; url: string }> | null;
    }>();
    expect(pack.scope).toBe("status");
    expect(pack.scopeKey).toBe("in_progress");
    expect(pack.version).toBe(1);
    expect(pack.links?.[0]?.label).toBe("Playbook");

    const list = await app.fetch(
      request(`${base}?scope=status`, { token }),
      env
    );
    const { packs } = await list.json<{ packs: Array<{ id: string }> }>();
    expect(packs.some((p) => p.id === pack.id)).toBe(true);

    const edit = await app.fetch(
      request(`${base}/${pack.id}`, {
        method: "PATCH",
        token,
        body: JSON.stringify({ body: "No rate, savings, or ROI numbers." }),
      }),
      env
    );
    expect(edit.status).toBe(200);
    const edited = await edit.json<{ version: number; body: string }>();
    expect(edited.version).toBe(2);
    expect(edited.body).toBe("No rate, savings, or ROI numbers.");

    const versions = await app.fetch(
      request(`${base}/${pack.id}/versions`, { token }),
      env
    );
    const { versions: history } = await versions.json<{
      versions: Array<{ version: number; body: string }>;
    }>();
    expect(history.map((v) => v.version)).toEqual([1, 2]);
    expect(history[0]?.body).toBe("No rate or savings numbers.");

    const del = await app.fetch(
      request(`${base}/${pack.id}`, { method: "DELETE", token }),
      env
    );
    expect(del.status).toBe(200);
    const gone = await app.fetch(
      request(`${base}/${pack.id}`, { token }),
      env
    );
    expect(gone.status).toBe(404);
    // Version history survives delete — sessions reference it.
    const versionsAfter = await app.fetch(
      request(`${base}/${pack.id}/versions`, { token }),
      env
    );
    expect(
      (await versionsAfter.json<{ versions: unknown[] }>()).versions
    ).toHaveLength(2);
  });

  it("rejects scoped packs without a scopeKey", async () => {
    const res = await app.fetch(
      request(`/workspaces/${organizationId}/agent/guidance`, {
        method: "POST",
        token,
        body: JSON.stringify({
          name: "Team pack",
          scope: "team",
          body: "x",
        }),
      }),
      env
    );
    expect(res.status).toBe(400);
  });

  it("injects a stage pack into a dispatched session and records versions", async () => {
    const agentId = `mock-courier-${crypto.randomUUID().slice(0, 8)}`;
    let instructions = "";
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: (_o, _i, _m, ctx) => {
            instructions = ctx?.instructions ?? "";
            return { id: "c-1", agentId, status: "created" as const };
          },
        })
    );

    const issueRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues`, {
        method: "POST",
        token,
        body: JSON.stringify({ title: "Courier dispatch" }),
      }),
      env
    );
    const issue = await issueRes.json<{ id: string; status: string }>();

    await app.fetch(
      request(`/workspaces/${organizationId}/agent/guidance`, {
        method: "POST",
        token,
        body: JSON.stringify({
          name: "Outreach",
          scope: "status",
          scopeKey: issue.status,
          body: "No rate or savings numbers.",
        }),
      }),
      env
    );
    const dispatchRes = await app.fetch(
      request(`/workspaces/${organizationId}/issues/${issue.id}/dispatch`, {
        method: "POST",
        token,
        body: JSON.stringify({ agentId }),
      }),
      env
    );
    expect(dispatchRes.status).toBe(201);
    expect(instructions).toContain("No rate or savings numbers.");

    const session = await dispatchRes.json<{
      id: string;
      guidance: Array<{ name: string; scope: string; version: number }>;
    }>();
    expect(
      session.guidance.some(
        (g) => g.name === "Outreach" && g.scope === "status" && g.version === 1
      )
    ).toBe(true);
  });
});
