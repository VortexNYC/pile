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
      id: "user-comments",
      name: "Comments User",
      email: "comments-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-comments");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Comments test",
    slug: `comments-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-comments",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-comments",
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

describe("comments API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("rejects listing comments without auth", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments`
    );
    expect(res.status).toBe(401);
  });

  it("rejects listing comments for an unknown issue", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects creating a comment with no JSON body", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments`,
      { method: "POST" },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating a comment with no content-type or body", async () => {
    const request = new Request(
      `https://example.com/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } }
    );
    const res = await app.fetch(request, env);
    console.log("status", res.status, await res.text());
    expect(res.status).toBe(400);
  });

  it("rejects creating a comment with an empty body", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "" }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating a comment on an unknown issue", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "Hello" }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects creating a comment without auth", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "Hello" }),
      }
    );
    expect(res.status).toBe(403);
  });

  it("rejects getting an unknown comment", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments/00000000-0000-0000-0000-000000000000`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects updating an unknown comment", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments/00000000-0000-0000-0000-000000000000`,
      {
        method: "PATCH",
        body: JSON.stringify({ body: "Updated" }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects deleting an unknown comment", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments/00000000-0000-0000-0000-000000000000`,
      {
        method: "DELETE",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects resolving an unknown comment", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments/00000000-0000-0000-0000-000000000000/resolve`,
      {
        method: "POST",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects unresolving an unknown comment", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/comments/00000000-0000-0000-0000-000000000000/unresolve`,
      {
        method: "POST",
      },
      token
    );
    expect(res.status).toBe(404);
  });
});

describe("comment creation", () => {
  it("creates a comment on an issue", async () => {
    const seeded = await seedWorkspace();
    const issueRes = await fetch(
      `/workspaces/${seeded.organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({ title: "Comment target" }),
      },
      seeded.token
    );
    expect(issueRes.status).toBe(201);
    const issue = z.object({ id: z.string() }).parse(await issueRes.json());

    const res = await fetch(
      `/workspaces/${seeded.organizationId}/issues/${issue.id}/comments`,
      {
        method: "POST",
        body: JSON.stringify({ body: "Hello world" }),
      },
      seeded.token
    );
    expect(res.status).toBe(201);
    const comment = z.object({ id: z.string(), body: z.string() }).parse(await res.json());
    expect(comment.body).toBe("Hello world");
  });
});
