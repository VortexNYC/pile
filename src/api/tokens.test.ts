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
    .passthrough()
    .parse(await res.json());
  return { res, key: parsed.token, body: parsed };
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
  it(
    "lists installs with actorType, provider, and joined teams",
    { timeout: 30000 },
    async () => {
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
    }
  );

  it(
    "joins every team by default so the agent sees workspace data",
    { timeout: 30000 },
    async () => {
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
    }
  );

  it(
    "scopes to explicit teamIds when provided",
    { timeout: 30000 },
    async () => {
      const { organizationId, adminToken, defaultTeamId } = await seed();
      const { res, key } = await mintAgent(organizationId, adminToken, {
        name: "scoped-bot",
        actorType: "agent",
        permissions: "read",
        teamIds: [defaultTeamId],
      });
      expect(res.status).toBe(201);
      expect(await visibleTeamCount(organizationId, key)).toBe(1);
    }
  );

  it(
    "rejects unknown team ids instead of minting a blind key",
    { timeout: 30000 },
    async () => {
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
    }
  );

  it(
    "returns the agent userId so admins can target grants at it",
    { timeout: 30000 },
    async () => {
      const { organizationId, adminToken } = await seed();
      const { res, body } = await mintAgent(organizationId, adminToken, {
        name: "id-bot",
        actorType: "agent",
        permissions: "read",
      });
      expect(res.status).toBe(201);
      const parsed = z
        .object({ userId: z.string(), actorType: z.string() })
        .parse(body);
      expect(parsed.actorType).toBe("agent");
      expect(parsed.userId.length).toBeGreaterThan(0);
    }
  );

  it(
    "grants restricted-space read via spaceIds at mint time",
    { timeout: 30000 },
    async () => {
      const { organizationId, adminToken } = await seed();
      const spaceRes = await fetch(
        `/workspaces/${organizationId}/document-spaces`,
        {
          method: "POST",
          body: JSON.stringify({ name: "Leadership", restricted: true }),
        },
        adminToken
      );
      expect(spaceRes.status).toBe(201);
      const space = z.object({ id: z.string() }).parse(await spaceRes.json());

      // A gap doc in the restricted space — no explicit doc ACL.
      const docRes = await fetch(
        `/workspaces/${organizationId}/documents`,
        {
          method: "POST",
          body: JSON.stringify({
            title: "CEO Notes",
            spaceId: space.id,
          }),
        },
        adminToken
      );
      expect(docRes.status).toBe(201);
      const doc = z.object({ id: z.string() }).parse(await docRes.json());

      // Ungranted agent: the restricted space denies by default.
      const { key: blindKey } = await mintAgent(organizationId, adminToken, {
        name: "blind-bot",
        actorType: "agent",
        permissions: "read",
      });
      const denied = await fetch(
        `/workspaces/${organizationId}/documents/${doc.id}`,
        {},
        blindKey
      );
      expect(denied.status).toBe(404);

      // Granted agent: the spaceIds install grant opens the gap doc.
      const { res, key, body } = await mintAgent(organizationId, adminToken, {
        name: "leadership-bot",
        actorType: "agent",
        permissions: "read",
        spaceIds: [space.id],
      });
      expect(res.status).toBe(201);
      const minted = z
        .object({ userId: z.string(), spaceIds: z.array(z.string()) })
        .parse(body);
      expect(minted.spaceIds).toEqual([space.id]);

      const perms = await fetch(
        `/workspaces/${organizationId}/document-spaces/${space.id}/permissions`,
        {},
        adminToken
      );
      const grants = z
        .object({
          permissions: z.array(
            z.object({ actorId: z.string(), level: z.string() })
          ),
        })
        .parse(await perms.json()).permissions;
      expect(
        grants.some((g) => g.actorId === minted.userId && g.level === "view")
      ).toBe(true);

      const allowed = await fetch(
        `/workspaces/${organizationId}/documents/${doc.id}`,
        {},
        key
      );
      expect(allowed.status).toBe(200);
    }
  );

  it(
    "rejects unknown space ids instead of minting a blind key",
    { timeout: 30000 },
    async () => {
      const { organizationId, adminToken } = await seed();
      const res = await fetch(
        `/workspaces/${organizationId}/tokens`,
        {
          method: "POST",
          body: JSON.stringify({
            name: "bad-spaces",
            actorType: "agent",
            spaceIds: ["not-a-space"],
          }),
        },
        adminToken
      );
      expect(res.status).toBe(400);
    }
  );

  it(
    "rejects spaceIds unless the token is an agent install",
    { timeout: 30000 },
    async () => {
      const { organizationId, adminToken } = await seed();
      const res = await fetch(
        `/workspaces/${organizationId}/tokens`,
        {
          method: "POST",
          body: JSON.stringify({
            name: "self-grant",
            spaceIds: ["anything"],
          }),
        },
        adminToken
      );
      expect(res.status).toBe(400);
    }
  );
});
