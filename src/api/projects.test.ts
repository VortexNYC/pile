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
      id: "user-projects",
      name: "Projects User",
      email: "projects-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-projects");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Projects test",
    slug: `projects-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-projects",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-projects",
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

describe("projects API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("rejects listing projects without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/projects`);
    expect(res.status).toBe(401);
  });

  it("rejects creating a project without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/projects`, {
      method: "POST",
      body: JSON.stringify({ name: "No auth" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects creating a project without a name", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/projects`,
      {
        method: "POST",
        body: JSON.stringify({ description: "No name" }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating a project with an invalid health", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/projects`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "Bad health",
          health: "green",
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects getting an unknown project", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/projects/00000000-0000-0000-0000-000000000000`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects updating an unknown project", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/projects/00000000-0000-0000-0000-000000000000`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: "Updated" }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects archiving an unknown project", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/projects/00000000-0000-0000-0000-000000000000/archive`,
      {
        method: "POST",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects unarchiving an unknown project", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/projects/00000000-0000-0000-0000-000000000000/unarchive`,
      {
        method: "POST",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("returns 204 when deleting an unknown project", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/projects/00000000-0000-0000-0000-000000000000`,
      {
        method: "DELETE",
      },
      token
    );
    expect(res.status).toBe(204);
  });

  it("rejects listing updates for an unknown project", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/projects/00000000-0000-0000-0000-000000000000/updates`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects creating an update for an unknown project", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/projects/00000000-0000-0000-0000-000000000000/updates`,
      {
        method: "POST",
        body: JSON.stringify({ content: "Hello" }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects listing milestones for an unknown project", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/projects/00000000-0000-0000-0000-000000000000/milestones`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects creating a milestone for an unknown project", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/projects/00000000-0000-0000-0000-000000000000/milestones`,
      {
        method: "POST",
        body: JSON.stringify({ name: "Milestone" }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects getting a reminder for an unknown project", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/projects/00000000-0000-0000-0000-000000000000/reminder`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });
});
