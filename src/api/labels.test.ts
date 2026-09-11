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
      id: "user-labels",
      name: "Labels User",
      email: "labels-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-labels");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Labels test",
    slug: `labels-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-labels",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-labels",
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

describe("issue labels API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("rejects listing labels without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/labels`);
    expect(res.status).toBe(401);
  });

  it("rejects creating a label without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/labels`, {
      method: "POST",
      body: JSON.stringify({ name: "No auth" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects creating a label without a name", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/labels`,
      {
        method: "POST",
        body: JSON.stringify({ color: "#ff0000" }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating a label with a non-string color", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/labels`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "Bad color",
          color: 123,
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects getting an unknown label", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/labels/00000000-0000-0000-0000-000000000000`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects updating an unknown label", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/labels/00000000-0000-0000-0000-000000000000`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: "Updated" }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("returns 204 when deleting an unknown label", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/labels/00000000-0000-0000-0000-000000000000`,
      {
        method: "DELETE",
      },
      token
    );
    expect(res.status).toBe(204);
  });
});
