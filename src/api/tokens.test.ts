import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  const userId = `tokens-user-${crypto.randomUUID()}`;
  await db
    .insert(userTable)
    .values({
      id: userId,
      name: "Tokens User",
      email: `${userId}@example.com`,
      emailVerified: false,
      image: null,
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

  const auth = createAuth(env);
  const adminResult = await auth.api.createApiKey({
    body: {
      userId,
      name: "test-admin",
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const adminParsed = z.object({ key: z.string() }).parse(adminResult);

  const readResult = await auth.api.createApiKey({
    body: {
      userId,
      name: "test-read",
      metadata: { organizationId: workspace!.id, permissions: "read" },
    },
  });
  const readParsed = z.object({ key: z.string() }).parse(readResult);

  return {
    organizationId: workspace!.id,
    adminToken: adminParsed.key,
    readToken: readParsed.key,
  };
}

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

describe("tokens API", () => {
  let organizationId: string;
  let adminToken: string;
  let readToken: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    adminToken = seeded.adminToken;
    readToken = seeded.readToken;
  });

  it("rejects listing tokens without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/tokens`);
    expect(res.status).toBe(401);
  });

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
});
