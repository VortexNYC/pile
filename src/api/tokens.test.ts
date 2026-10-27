import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { member, team, user as userTable } from "../global/schema.js";
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
      permissions: { workspace: ["admin"] },
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

  return {
    organizationId: workspace.id,
    adminToken: adminParsed.key,
    defaultTeamId: defaultTeam.id,
    extraTeamId: extraTeam.id,
  };
}

/** A workspace member (role=member) plus a member-scoped API key — the
 * identity `pile auth login` / the Developer page gives non-admins. */
async function seedMember(organizationId: string) {
  const db = createD1(env.D1);
  const auth = await createAuth(env);
  const memberId = `member-${crypto.randomUUID()}`;
  await db.insert(userTable).values({
    id: memberId,
    name: "Workspace Member",
    email: `${memberId}@example.com`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId,
    userId: memberId,
    role: "member",
    createdAt: new Date(),
  });
  const keyResult = await auth.api.createApiKey({
    body: {
      userId: memberId,
      name: "member-key",
      metadata: { organizationId, permissions: "read,write" },
      permissions: { workspace: ["read", "write"] },
    },
  });
  const { id, key } = z
    .object({ id: z.string(), key: z.string() })
    .parse(keyResult);
  return { memberId, memberKeyId: id, memberToken: key };
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
  });

  it("DELETE cascades the token's team_member installs (PILE-623)", async () => {
    const { organizationId, adminToken } = await seed();
    const minted = await mintAgent(organizationId, adminToken, {
      name: "retire-me",
      actorType: "agent",
      permissions: "read",
    });
    expect(minted.res.status).toBe(201);
    const list = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {},
      adminToken
    );
    const { tokens } = z
      .object({
        tokens: z.array(z.object({ id: z.string(), name: z.string() })),
      })
      .parse(await list.json());
    const token = tokens.find((t) => t.name === "retire-me");
    expect(token).toBeDefined();

    const db = createD1(env.D1);
    const { apikey, teamMember } = await import("../global/schema.js");
    const keyRow = await db
      .select({ referenceId: apikey.referenceId })
      .from(apikey)
      .where(eq(apikey.id, token!.id))
      .get();
    const installsBefore = await db
      .select()
      .from(teamMember)
      .where(eq(teamMember.userId, keyRow!.referenceId))
      .all();
    expect(installsBefore.length).toBeGreaterThan(0);

    const del = await fetch(
      `/workspaces/${organizationId}/tokens/${token!.id}`,
      { method: "DELETE" },
      adminToken
    );
    expect(del.status).toBe(204);
    const installsAfter = await db
      .select()
      .from(teamMember)
      .where(eq(teamMember.userId, keyRow!.referenceId))
      .all();
    expect(installsAfter).toHaveLength(0);
  });

  it("POST /tokens/prune removes stale agent-* lane keys only (PILE-623)", async () => {
    const { organizationId, adminToken } = await seed();
    const db = createD1(env.D1);
    const { apikey } = await import("../global/schema.js");
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    await db.insert(apikey).values([
      {
        id: `k-${crypto.randomUUID()}`,
        name: "agent-deadbeef-cafe",
        key: `key-${crypto.randomUUID()}`,
        referenceId: "user-1",
        metadata: JSON.stringify({
          organizationId,
          permissions: "admin",
          actorType: "agent",
        }),
        createdAt: new Date(now - 2 * day),
        updatedAt: new Date(now - 2 * day),
      },
      {
        id: `k-${crypto.randomUUID()}`,
        name: "agent-feedface-babe",
        key: `key-${crypto.randomUUID()}`,
        referenceId: "user-1",
        metadata: JSON.stringify({
          organizationId: "other-org",
          permissions: "admin",
          actorType: "agent",
        }),
        createdAt: new Date(now - 2 * day),
        updatedAt: new Date(now - 2 * day),
      },
    ]);
    const res = await fetch(
      `/workspaces/${organizationId}/tokens/prune`,
      { method: "POST", body: JSON.stringify({ maxAgeHours: 24 }) },
      adminToken
    );
    expect(res.status).toBe(200);
    const { pruned } = z.object({ pruned: z.number() }).parse(await res.json());
    expect(pruned).toBe(1);
    const left = await db
      .select({ name: apikey.name })
      .from(apikey)
      .where(eq(apikey.name, "agent-feedface-babe"))
      .get();
    expect(left?.name).toBe("agent-feedface-babe");
  });
});

describe("member self-serve keys (PILE-647)", () => {
  it("lists only the member's own keys — never other users' or agent installs", async () => {
    const { organizationId, adminToken } = await seed();
    const { memberKeyId, memberToken } = await seedMember(organizationId);
    await mintAgent(organizationId, adminToken, {
      name: "grok-bot",
      actorType: "agent",
      permissions: "read",
    });

    const res = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {},
      memberToken
    );
    expect(res.status).toBe(200);
    const { tokens } = z
      .object({
        tokens: z.array(z.object({ id: z.string(), actorType: z.string() })),
      })
      .parse(await res.json());
    expect(tokens.map((t) => t.id)).toEqual([memberKeyId]);
  });

  it("mints a key clamped to the member role — admin grants are dropped", async () => {
    const { organizationId } = await seed();
    const { memberToken } = await seedMember(organizationId);
    const res = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "mcp-key",
          permissions: ["read", "write", "admin"],
        }),
      },
      memberToken
    );
    expect(res.status).toBe(201);
    const { permissions, token } = z
      .object({ permissions: z.string(), token: z.string() })
      .parse(await res.json());
    expect(permissions).not.toContain("admin");
    // The minted key actually works — a member-scoped read route accepts it.
    const list = await fetch(`/workspaces/${organizationId}/tokens`, {}, token);
    expect(list.status).toBe(200);
  });

  it("cannot mint agent tokens", async () => {
    const { organizationId } = await seed();
    const { memberToken } = await seedMember(organizationId);
    const res = await fetch(
      `/workspaces/${organizationId}/tokens`,
      {
        method: "POST",
        body: JSON.stringify({ name: "bot", actorType: "agent" }),
      },
      memberToken
    );
    expect(res.status).toBe(403);
  });

  it("revokes its own key but 404s on keys owned by others", async () => {
    const { organizationId, adminToken } = await seed();
    const { memberKeyId, memberToken } = await seedMember(organizationId);
    const { tokens: adminTokens } = z
      .object({ tokens: z.array(z.object({ id: z.string() })) })
      .parse(
        await (
          await fetch(`/workspaces/${organizationId}/tokens`, {}, adminToken)
        ).json()
      );
    const adminKeyId = adminTokens.find((t) => t.id !== memberKeyId)!.id;

    const denied = await fetch(
      `/workspaces/${organizationId}/tokens/${adminKeyId}`,
      { method: "DELETE" },
      memberToken
    );
    expect(denied.status).toBe(404);

    const own = await fetch(
      `/workspaces/${organizationId}/tokens/${memberKeyId}`,
      { method: "DELETE" },
      memberToken
    );
    expect(own.status).toBe(204);
  });
});
