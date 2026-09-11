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
      id: "user-cycles",
      name: "Cycles User",
      email: "cycles-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-cycles");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Cycles test",
    slug: `cycles-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-cycles",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-cycles",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
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

describe("cycles API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("rejects listing cycles without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/cycles`);
    expect(res.status).toBe(401);
  });

  it("rejects creating a cycle without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/cycles`, {
      method: "POST",
      body: JSON.stringify({ name: "No auth" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects creating a cycle without a name", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/cycles`,
      {
        method: "POST",
        body: JSON.stringify({ status: "active" }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating a cycle with an invalid status", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/cycles`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "Bad status",
          status: "frozen",
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating a cycle with a non-integer number", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/cycles`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "Bad number",
          number: 1.5,
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects getting an unknown cycle", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/cycles/00000000-0000-0000-0000-000000000000`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects updating an unknown cycle", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/cycles/00000000-0000-0000-0000-000000000000`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: "Updated" }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects getting capacity for an unknown cycle", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/cycles/00000000-0000-0000-0000-000000000000/capacity`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects shifting an unknown cycle", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/cycles/00000000-0000-0000-0000-000000000000/shift-all`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects starting an unknown cycle today", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/cycles/00000000-0000-0000-0000-000000000000/start-today`,
      {
        method: "POST",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects archiving an unknown cycle", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/cycles/00000000-0000-0000-0000-000000000000/archive`,
      {
        method: "POST",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects unarchiving an unknown cycle", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/cycles/00000000-0000-0000-0000-000000000000/unarchive`,
      {
        method: "POST",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("returns 204 when deleting an unknown cycle", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/cycles/00000000-0000-0000-0000-000000000000`,
      {
        method: "DELETE",
      },
      token
    );
    expect(res.status).toBe(204);
  });

  it("rejects rollover without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/cycles/rollover`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });
});
