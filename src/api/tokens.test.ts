import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { team, user as userTable } from "../global/schema.js";
import { createTeam } from "../global/teams.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

async function fetch(
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : undefined),
    ...(init.headers as Record<string, string> | undefined),
  };
  const request = new Request(`https://example.com${path}`, {
    ...init,
    headers,
  });
  return app.fetch(request, env);
}

async function seed() {
  const db = createD1(env.D1);
  const auth = await createAuth(env);
  const userId = `user-${crypto.randomUUID()}`;
  const email = `${userId}@example.com`;
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: userId,
      name: "Token Owner",
      email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, userId);
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Tokens test",
    slug: `tokens-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: userId,
  });
  if (!workspace) throw new Error("workspace not created");

  const adminResult = await auth.api.createApiKey({
    body: {
      userId,
      name: "test-admin",
      metadata: { organizationId: workspace.id, permissions: "admin" },
    },
  });
  const adminParsed = z.object({ key: z.string() }).parse(adminResult);

  const defaultTeam = await db
    .select({ id: team.id })
    .from(team)
    .where(eq(team.organizationId, workspace.id))
    .get();
  if (!defaultTeam) throw new Error("default team missing");

  // A second private team — agent tokens must join it explicitly to see it.
  const extraTeam = await createTeam(db, env, setupHeaders, {
    organizationId: workspace.id,
    key: "XTRA",
    name: "Extra",
    ownerId: userId,
    isPublic: false,
  });

<<<<<<< HEAD
  return {
    organizationId: workspace.id,
    adminToken: adminParsed.key,
    defaultTeamId: defaultTeam.id,
    extraTeamId: extraTeam.id,
  };
}
||||||| e66b625
  it("rejects listing tokens without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/tokens`);
    expect(res.status).toBe(401);
  });
=======
  return {
    organizationId: workspace.id,
    adminToken: adminParsed.key,
    defaultTeamId: defaultTeam.id,
    extraTeamId: extraTeam.id,
  };
}

async function mintAgent(
  organizationId: string,
  adminToken: string,
  body: Record<string, unknown>
) {
  const res = await fetch(
    `/workspaces/${organizationId}/tokens`,
    { method: "POST", body: JSON.stringify(body) },
    adminToken
  );
  const parsed = z
    .object({ id: z.string(), token: z.string() })
    .parse(await res.json());
  return { res, key: parsed.token };
}

async function visibleTeamCount(
  organizationId: string,
  token: string
): Promise<number> {
  const res = await fetch(`/workspaces/${organizationId}/teams`, {}, token);
  const parsed = z
    .object({ teams: z.array(z.object({ id: z.string() })) })
    .parse(await res.json());
  return parsed.teams.length;
}

describe("agent tokens", () => {
  it("joins every team by default so the agent sees workspace data", async () => {
    const { organizationId, adminToken } = await seed();
    const { res, key } = await mintAgent(organizationId, adminToken, {
      name: "grok-bot",
      actorType: "agent",
      permissions: "read,write",
    });
    expect(res.status).toBe(201);
    // Both the default team and the private second team are visible —
    // before this, agent keys saw zero teams and every list came back empty.
    expect(await visibleTeamCount(organizationId, key)).toBe(2);
  });
>>>>>>> origin/main

<<<<<<< HEAD
async function mintAgent(
  organizationId: string,
  adminToken: string,
  body: Record<string, unknown>
) {
  const res = await fetch(
    `/workspaces/${organizationId}/tokens`,
    { method: "POST", body: JSON.stringify(body) },
    adminToken
  );
  const parsed = z
    .object({ id: z.string(), token: z.string() })
    .parse(await res.json());
  return { res, key: parsed.token };
}
||||||| e66b625
  it("lists tokens for an admin", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {},
      adminToken
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ tokens: unknown[] }>();
    expect(body.tokens.length).toBeGreaterThanOrEqual(2);
  });
=======
  it("scopes to explicit teamIds when provided", async () => {
    const { organizationId, adminToken, defaultTeamId } = await seed();
    const { res, key } = await mintAgent(organizationId, adminToken, {
      name: "scoped-bot",
      actorType: "agent",
      permissions: "read",
      teamIds: [defaultTeamId],
    });
    expect(res.status).toBe(201);
    expect(await visibleTeamCount(organizationId, key)).toBe(1);
  });
>>>>>>> origin/main

<<<<<<< HEAD
async function visibleTeamCount(
  organizationId: string,
  token: string
): Promise<number> {
  const res = await fetch(`/workspaces/${organizationId}/teams`, {}, token);
  const parsed = z
    .object({ teams: z.array(z.object({ id: z.string() })) })
    .parse(await res.json());
  return parsed.teams.length;
}

describe("agent tokens", () => {
  it("lists installs with actorType, provider, and joined teams", async () => {
    const { organizationId, adminToken } = await seed();
    await mintAgent(organizationId, adminToken, {
      name: "grok-bot",
      actorType: "agent",
      provider: "grok",
      permissions: "read,write",
    });
    const res = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {},
      adminToken
    );
    const { tokens } = z
      .object({
        tokens: z.array(
          z.object({
            actorType: z.string().optional(),
            provider: z.string().optional(),
            teamIds: z.array(z.string()).optional(),
          })
        ),
      })
      .parse(await res.json());
    const agent = tokens.find((t) => t.actorType === "agent");
    expect(agent?.provider).toBe("grok");
    expect(agent?.teamIds?.length).toBe(2);
  });

  it("joins every team by default so the agent sees workspace data", async () => {
    const { organizationId, adminToken } = await seed();
    const { res, key } = await mintAgent(organizationId, adminToken, {
      name: "grok-bot",
      actorType: "agent",
      permissions: "read,write",
    });
    expect(res.status).toBe(201);
    // Both the default team and the private second team are visible —
    // before this, agent keys saw zero teams and every list came back empty.
    expect(await visibleTeamCount(organizationId, key)).toBe(2);
  });

  it("scopes to explicit teamIds when provided", async () => {
    const { organizationId, adminToken, defaultTeamId } = await seed();
    const { res, key } = await mintAgent(organizationId, adminToken, {
      name: "scoped-bot",
      actorType: "agent",
      permissions: "read",
      teamIds: [defaultTeamId],
    });
    expect(res.status).toBe(201);
    expect(await visibleTeamCount(organizationId, key)).toBe(1);
  });

  it("rejects unknown team ids instead of minting a blind key", async () => {
    const { organizationId, adminToken } = await seed();
    const res = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "bad-teams",
          actorType: "agent",
          teamIds: ["not-a-team"],
        }),
      },
      adminToken
    );
    expect(res.status).toBe(400);
||||||| e66b625
  it("rejects listing tokens for a read-only token", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {},
      readToken
    );
    expect(res.status).toBe(403);
  });

  it("creates an agent token", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "agent-token",
          permissions: ["read"],
          actorType: "agent",
          provider: "vortex",
        }),
      },
      adminToken
    );
    expect(res.status).toBe(201);
    const body = await res.json<{
      id: string;
      token: string;
      permissions: string;
    }>();
    expect(body.token).toBeDefined();
    expect(body.permissions).toBe("read");
  });

  it("mints workspace keys exempt from the per-key rate limiter", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({ name: "no-limit", permissions: "read" }),
      },
      adminToken
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ id: string }>();

    const db = createD1(env.D1);
    const row = await db
      .select({ rateLimitEnabled: apikey.rateLimitEnabled })
      .from(apikey)
      .where(eq(apikey.id, body.id))
      .get();
    // Shared machine keys (agent-dispatch, CLI) previously kept the default
    // limiter on and 429'd mid-session once request_count crossed the cap.
    expect(row?.rateLimitEnabled).toBe(false);
  });

  it("rejects creating a token for a read-only token", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({ name: "nope", permissions: "admin" }),
      },
      readToken
    );
    expect(res.status).toBe(403);
  });

  it("lets a session member mint a token clamped to member permissions", async () => {
    const member = await seedMemberSession(organizationId);
    const res = await fetch(`/workspaces/${organizationId}/tokens`, {
      method: "POST",
      headers: { Cookie: member.cookie, Origin: origin },
      body: JSON.stringify({
        name: "member-cli",
        permissions: ["read", "write", "admin"],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{
      id: string;
      token: string;
      permissions: string;
    }>();
    expect(body.permissions).toBe("read,write");

    const db = createD1(env.D1);
    const row = await db
      .select()
      .from(apikey)
      .where(eq(apikey.id, body.id))
      .get();
    expect(row?.referenceId).toBe(member.userId);
    const metadata = z
      .object({ actorType: z.string(), permissions: z.string() })
      .parse(JSON.parse(row?.metadata ?? "{}"));
    expect(metadata).toEqual({ actorType: "user", permissions: "read,write" });

    const issuesRes = await fetch(
      `/workspaces/${organizationId}/issues`,
      {},
      body.token
    );
    expect(issuesRes.status).toBe(200);
  });

  it("defaults a session member token to read", async () => {
    const member = await seedMemberSession(organizationId);
    const res = await fetch(`/workspaces/${organizationId}/tokens`, {
      method: "POST",
      headers: { Cookie: member.cookie, Origin: origin },
      body: JSON.stringify({ name: "member-default" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ permissions: string }>();
    expect(body.permissions).toBe("read");
  });

  it("rejects a member token request for permissions they do not hold", async () => {
    const member = await seedMemberSession(organizationId);
    const res = await fetch(`/workspaces/${organizationId}/tokens`, {
      method: "POST",
      headers: { Cookie: member.cookie, Origin: origin },
      body: JSON.stringify({ name: "escalate", permissions: ["admin"] }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects agent token creation for a session member", async () => {
    const member = await seedMemberSession(organizationId);
    const res = await fetch(`/workspaces/${organizationId}/tokens`, {
      method: "POST",
      headers: { Cookie: member.cookie, Origin: origin },
      body: JSON.stringify({ name: "agent", actorType: "agent" }),
    });
    expect(res.status).toBe(403);
  });

  it("clamps a token minted by a write-scoped key to its own permissions", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "child",
          permissions: ["write", "admin"],
        }),
      },
      writeToken
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ permissions: string }>();
    expect(body.permissions).toBe("write");
  });

  it("revokes a member's key when their membership is removed", async () => {
    const memberSession = await seedMemberSession(organizationId);
    const res = await fetch(`/workspaces/${organizationId}/tokens`, {
      method: "POST",
      headers: { Cookie: memberSession.cookie, Origin: origin },
      body: JSON.stringify({ name: "doomed", permissions: ["read"] }),
    });
    expect(res.status).toBe(201);
    const { token } = await res.json<{ token: string }>();

    const working = await fetch(
      `/workspaces/${organizationId}/issues`,
      {},
      token
    );
    expect(working.status).toBe(200);

    const db = createD1(env.D1);
    await db
      .delete(memberTable)
      .where(
        and(
          eq(memberTable.organizationId, organizationId),
          eq(memberTable.userId, memberSession.userId)
        )
      );

    const check = await fetch(
      `/workspaces/${organizationId}/issues`,
      {},
      token
    );
    expect(check.status).toBe(403);
  });

  it("binds a non-admin agent key's minted token to the agent, not the owner", async () => {
    const agentRes = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "lane-key",
          permissions: ["read", "write"],
          actorType: "agent",
        }),
      },
      adminToken
    );
    expect(agentRes.status).toBe(201);
    const agentKey = await agentRes.json<{ id: string; token: string }>();

    const db = createD1(env.D1);
    const agentRow = await db
      .select()
      .from(apikey)
      .where(eq(apikey.id, agentKey.id))
      .get();
    const agentUserId = agentRow?.referenceId;

    const res = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({ name: "agent-child", permissions: ["read"] }),
      },
      agentKey.token
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ id: string }>();
    const row = await db
      .select()
      .from(apikey)
      .where(eq(apikey.id, body.id))
      .get();
    expect(row?.referenceId).toBe(agentUserId);
  });

  it("deletes a token", async () => {
    const createRes = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({ name: "to-delete", permissions: "read" }),
      },
      adminToken
    );
    expect(createRes.status).toBe(201);
    const { id } = await createRes.json<{ id: string }>();

    const deleteRes = await fetch(
      `/workspaces/${organizationId}/tokens/${id}`,
      { method: "DELETE" },
      adminToken
    );
    expect(deleteRes.status).toBe(204);
  });

  it("rejects deleting a token for a read-only token", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/tokens/00000000-0000-0000-0000-000000000000`,
      { method: "DELETE" },
      readToken
    );
    expect(res.status).toBe(403);
  });

  it("records token lifecycle in the workspace audit log", async () => {
    const createRes = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({ name: "audited", permissions: "read" }),
      },
      adminToken
    );
    expect(createRes.status).toBe(201);
    const { id } = await createRes.json<{ id: string }>();

    const deleteRes = await fetch(
      `/workspaces/${organizationId}/tokens/${id}`,
      { method: "DELETE" },
      adminToken
    );
    expect(deleteRes.status).toBe(204);

    const auditRes = await fetch(
      `/workspaces/${organizationId}/audit-log?entityType=token&entityId=${id}`,
      {},
      adminToken
    );
    expect(auditRes.status).toBe(200);
    const { entries } = await auditRes.json<{
      entries: Array<{
        action: string;
        actorType: string | null;
        userAgent: string | null;
        changes: Record<string, { from: unknown; to: unknown }> | null;
      }>;
    }>();
    const actions = entries.map((e) => e.action);
    expect(actions).toContain("token.created");
    expect(actions).toContain("token.deleted");
    expect(entries[0]!.actorType).toBe("user");
    expect(entries.find((e) => e.action === "token.created")!.changes).toEqual(
      expect.objectContaining({
        name: { from: null, to: "audited" },
      })
    );
=======
  it("rejects unknown team ids instead of minting a blind key", async () => {
    const { organizationId, adminToken } = await seed();
    const res = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "bad-teams",
          actorType: "agent",
          teamIds: ["not-a-team"],
        }),
      },
      adminToken
    );
    expect(res.status).toBe(400);
>>>>>>> origin/main
  });
});
