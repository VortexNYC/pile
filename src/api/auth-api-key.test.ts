import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { member, user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

async function seed() {
  const db = createD1(env.D1);
  const now = new Date();
  const userId = `authkey-user-${crypto.randomUUID()}`;
  await db.insert(userTable).values({
    id: userId,
    name: "Auth Key User",
    email: `${userId}@example.com`,
    emailVerified: false,
    image: null,
    createdAt: now,
    updatedAt: now,
  });

  const setupHeaders = await createAdminHeaders(env, userId);
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Auth key test",
    slug: `authkey-${crypto.randomUUID()}`,
    key: `K${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: userId,
  });
  const organizationId = workspace!.id;

  const auth = await createAuth(env);
  const mint = async (
    name: string,
    body: Record<string, unknown>
  ): Promise<string> => {
    const result = await auth.api.createApiKey({
      body: {
        userId,
        name,
        rateLimitEnabled: false,
        metadata: { organizationId, permissions: "read" },
        ...body,
      },
    });
    return z.object({ key: z.string() }).parse(result).key;
  };

  const readKey = await mint("read", {
    permissions: { workspace: ["read"] },
  });
  // A metadata-forged "admin agent" key — no server-set grant.
  const forgedAgentKey = await mint("forged", {
    metadata: {
      organizationId,
      permissions: "admin",
      actorType: "agent",
    },
  });
  return { organizationId, userId, readKey, forgedAgentKey };
}

function authFetch(
  path: string,
  token: string,
  init: RequestInit = {}
): Promise<Response> {
  return app.fetch(
    new Request(`https://example.com${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    }),
    env
  );
}

describe("API-key session handling on /api/auth/*", () => {
  let org: Awaited<ReturnType<typeof seed>>;

  beforeAll(async () => {
    org = await seed();
  }, 30000);

  it("rejects API-key callers on /api/auth/api-key/create", async () => {
    const res = await authFetch("/api/auth/api-key/create", org.readKey, {
      method: "POST",
      body: JSON.stringify({
        name: "escalated",
        metadata: {
          organizationId: org.organizationId,
          permissions: "admin",
          actorType: "agent",
        },
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects API-key callers on /api/auth/api-key/update and /delete", async () => {
    const update = await authFetch("/api/auth/api-key/update", org.readKey, {
      method: "POST",
      body: JSON.stringify({ keyId: "x", metadata: { permissions: "admin" } }),
    });
    expect(update.status).toBe(401);
    const del = await authFetch("/api/auth/api-key/delete", org.readKey, {
      method: "POST",
      body: JSON.stringify({ keyId: "x" }),
    });
    expect(del.status).toBe(401);
  });

  it("does not echo the credential back in get-session", async () => {
    const res = await authFetch("/api/auth/get-session", org.readKey);
    expect(res.status).toBe(200);
    const body = z
      .object({
        user: z.object({ id: z.string() }),
        session: z.record(z.string(), z.unknown()).nullable(),
      })
      .parse(await res.json());
    expect(body.user.id).toBe(org.userId);
    expect(body.session).not.toBeNull();
    expect(body.session?.token).toBeUndefined();
  });

  it("clamps a metadata-forged agent key to read regardless of claims", async () => {
    // actorType/permissions in metadata are client-controlled: a key with
    // no server-set workspace grant is a read-only user identity.
    const read = await authFetch(
      `/workspaces/${org.organizationId}/issues`,
      org.forgedAgentKey
    );
    expect(read.status).toBe(200);
    const admin = await authFetch(
      `/workspaces/${org.organizationId}/memberships`,
      org.forgedAgentKey,
      { method: "POST", body: JSON.stringify({ userId: "nobody" }) }
    );
    expect(admin.status).toBe(403);
  });

  it("clamps agent-typed keys to the member-role ceiling", async () => {
    // An agent key minted with an admin grant for a *member* agent user
    // loses admin under the role clamp.
    const db = createD1(env.D1);
    const agentId = crypto.randomUUID();
    const now = new Date();
    await db.insert(userTable).values({
      id: agentId,
      name: "clamped-agent",
      email: `agent-${agentId}@example.com`,
      emailVerified: true,
      role: "user",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(member).values({
      id: crypto.randomUUID(),
      organizationId: org.organizationId,
      userId: agentId,
      role: "member",
      createdAt: now,
    });
    const auth = await createAuth(env);
    const result = await auth.api.createApiKey({
      body: {
        userId: agentId,
        name: "agent-admin-claim",
        rateLimitEnabled: false,
        metadata: {
          organizationId: org.organizationId,
          permissions: "admin",
          actorType: "agent",
        },
        permissions: { workspace: ["admin"] },
      },
    });
    const key = z.object({ key: z.string() }).parse(result).key;
    const res = await authFetch(
      `/workspaces/${org.organizationId}/memberships`,
      key,
      { method: "POST", body: JSON.stringify({ userId: "nobody" }) }
    );
    expect(res.status).toBe(403);
  });

  it("keeps lane keys working for synthetic actors without a member row", async () => {
    // Dispatch mints keys for synthetic actors (e.g. "automation") that
    // have no member row — their read grant still resolves.
    const auth = await createAuth(env);
    const result = await auth.api.createApiKey({
      body: {
        userId: `automation-${crypto.randomUUID()}`,
        name: "lane-read",
        rateLimitEnabled: false,
        metadata: {
          organizationId: org.organizationId,
          permissions: "read",
          actorType: "agent",
        },
        permissions: { workspace: ["read"] },
      },
    });
    const key = z.object({ key: z.string() }).parse(result).key;
    const res = await authFetch(
      `/workspaces/${org.organizationId}/issues`,
      key
    );
    expect(res.status).toBe(200);
  });
});
