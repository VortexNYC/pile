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
  await db
    .insert(userTable)
    .values({
      id: "user-migration",
      name: "Migration User",
      email: "migration-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-migration");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Support migration test",
    slug: `support-migration-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-migration",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-migration",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

function fetch(
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(token ? { Authorization: `Bearer ${token}` } : undefined),
    ...(init.headers as Record<string, string> | undefined),
  };
  const request = new Request(`https://example.com${path}`, {
    ...init,
    headers,
  });
  return app.fetch(request, env) as Promise<Response>;
}

describe("support-migration API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("rejects start import without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/support/imports`, {
      method: "POST",
      body: JSON.stringify({
        source: "intercom",
        credentials: { accessToken: "x" },
      }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects an invalid import source", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/support/imports`,
      {
        method: "POST",
        body: JSON.stringify({
          source: "unknown",
          credentials: { accessToken: "x" },
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects missing credentials for a valid source", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/support/imports`,
      {
        method: "POST",
        body: JSON.stringify({ source: "intercom" }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("returns not found for unknown import", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/support/imports/00000000-0000-0000-0000-000000000000`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects canceling an unknown import", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/support/imports/00000000-0000-0000-0000-000000000000/cancel`,
      { method: "POST" },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects resuming an unknown import", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/support/imports/00000000-0000-0000-0000-000000000000/resume`,
      {
        method: "POST",
        body: JSON.stringify({
          source: "intercom",
          credentials: { token: "x" },
        }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects validation of an invalid source", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/support/imports/validate`,
      {
        method: "POST",
        body: JSON.stringify({
          source: "unknown",
          credentials: { accessToken: "x" },
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });
});
