import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { usageRecords, user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  const userId = `billing-user-${crypto.randomUUID()}`;
  await db
    .insert(userTable)
    .values({
      id: userId,
      name: "Billing User",
      email: `${userId}@example.com`,
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, userId);
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Billing test",
    slug: `billing-${crypto.randomUUID()}`,
    key: `B${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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

describe("billing API", () => {
  let organizationId: string;
  let adminToken: string;
  let readToken: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    adminToken = seeded.adminToken;
    readToken = seeded.readToken;

    const db = createD1(env.D1);
    const ts = new Date().toISOString();
    const period = "2026-09";
    await db.insert(usageRecords).values([
      {
        id: crypto.randomUUID(),
        organizationId,
        period,
        resource: "issue",
        action: "create",
        count: 3,
        createdAt: ts,
        updatedAt: ts,
      },
      {
        id: crypto.randomUUID(),
        organizationId,
        period,
        resource: "comment",
        action: "create",
        count: 5,
        createdAt: ts,
        updatedAt: ts,
      },
    ]);
  });

  it("returns aggregated billing usage for the workspace", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/billing?period=2026-09`,
      {},
      adminToken
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      organizationId: string;
      period: string;
      usage: Array<{ resource: string; action: string; count: number }>;
      total: number;
    }>();
    expect(body.organizationId).toBe(organizationId);
    expect(body.period).toBe("2026-09");
    expect(body.usage).toHaveLength(2);
    expect(body.total).toBe(8);
    expect(
      body.usage.find((u) => u.resource === "issue" && u.action === "create")
        ?.count
    ).toBe(3);
    expect(
      body.usage.find((u) => u.resource === "comment" && u.action === "create")
        ?.count
    ).toBe(5);
  });

  it("requires admin permission", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/billing?period=2026-09`,
      {},
      readToken
    );
    expect(res.status).toBe(403);
  });
});
