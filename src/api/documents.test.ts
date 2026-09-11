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
      id: "user-documents",
      name: "Documents User",
      email: "documents-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-documents");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Documents test",
    slug: `documents-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-documents",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-documents",
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

describe("documents API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("rejects listing documents without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/documents`);
    expect(res.status).toBe(401);
  });

  it("rejects creating a document with an empty title", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({ title: "" }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating a document with an invalid content format", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Bad format",
          contentFormat: "html",
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating a document without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/documents`, {
      method: "POST",
      body: JSON.stringify({ title: "No auth" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects getting an unknown document", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents/00000000-0000-0000-0000-000000000000`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects updating an unknown document", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents/00000000-0000-0000-0000-000000000000`,
      {
        method: "PATCH",
        body: JSON.stringify({ title: "Updated" }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects deleting an unknown document", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents/00000000-0000-0000-0000-000000000000`,
      {
        method: "DELETE",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects restoring an unknown document", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents/00000000-0000-0000-0000-000000000000/restore`,
      {
        method: "POST",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects fetching history for an unknown document", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents/00000000-0000-0000-0000-000000000000/history`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects creating a space with an empty name", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/document-spaces`,
      {
        method: "POST",
        body: JSON.stringify({ name: "" }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects updating an unknown space", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/document-spaces/00000000-0000-0000-0000-000000000000`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: "Updated" }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects deleting an unknown space", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/document-spaces/00000000-0000-0000-0000-000000000000`,
      {
        method: "DELETE",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects creating a comment on an unknown document", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents/00000000-0000-0000-0000-000000000000/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "Hello" }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects creating a share for an unknown document", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents/00000000-0000-0000-0000-000000000000/share`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects reading a shared document with an unknown token", async () => {
    const res = await fetch(
      `/shared-documents/${organizationId}/00000000-0000-0000-0000-000000000000`
    );
    expect(res.status).toBe(404);
  });

  it("rejects searching without a query", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/documents/search`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });
});
