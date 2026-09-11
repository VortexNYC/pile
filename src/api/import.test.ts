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
      id: "user-import",
      name: "Import User",
      email: "import-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-import");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Import test",
    slug: `import-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-import",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-import",
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

describe("import API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("rejects creating an import without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/import`, {
      method: "POST",
      body: JSON.stringify({
        source: "linear",
        credentials: { token: "abc" },
      }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects creating an import with an invalid source", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/import`,
      {
        method: "POST",
        body: JSON.stringify({
          source: "trello",
          credentials: { token: "abc" },
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating an import without credentials", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/import`,
      {
        method: "POST",
        body: JSON.stringify({ source: "linear" }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects getting an unknown import job", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/import/00000000-0000-0000-0000-000000000000`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects resuming an unknown import job", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/import/00000000-0000-0000-0000-000000000000/resume`,
      {
        method: "POST",
        body: JSON.stringify({ credentials: { token: "abc" } }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects resuming without credentials", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/import/00000000-0000-0000-0000-000000000000/resume`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects approving an unknown import job", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/import/00000000-0000-0000-0000-000000000000/approve`,
      {
        method: "POST",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects rejecting an unknown import job", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/import/00000000-0000-0000-0000-000000000000/reject`,
      {
        method: "POST",
      },
      token
    );
    expect(res.status).toBe(404);
  });
});
