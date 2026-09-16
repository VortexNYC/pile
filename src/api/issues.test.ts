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
      id: "user-issues",
      name: "Issues User",
      email: "issues-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-issues");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Issues test",
    slug: `issues-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-issues",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-issues",
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

describe("issues API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("rejects listing issues without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/issues`);
    expect(res.status).toBe(401);
  });

  it("rejects creating an issue without a title", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({ description: "No title" }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating an issue with an invalid priority", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Bad priority",
          priority: "critical",
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects creating an issue without auth", async () => {
    const res = await fetch(`/workspaces/${organizationId}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: "No auth",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects getting an unknown issue", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects updating an unknown issue", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000`,
      {
        method: "PATCH",
        body: JSON.stringify({
          title: "Updated",
        }),
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects deleting an unknown issue", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000`,
      {
        method: "DELETE",
      },
      token
    );
    expect(res.status).toBe(404);
  });

  it("rejects an invalid resolution status combination", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Resolution with todo",
          status: "todo",
          resolution: "duplicate",
        }),
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("captures a page to a triage issue", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/capture`,
      {
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/page",
          title: "Example page",
          selection: "selected text",
          source: "web-clipper",
        }),
      },
      token
    );
    expect(res.status).toBe(201);
    const issue = await res.json();
    expect(issue.status).toBe("triage");
    expect(issue.title).toBe("Example page");
    expect(issue.description).toContain("https://example.com/page");
    expect(issue.description).toContain("selected text");
    expect(issue.description).toContain("web-clipper");
  });

  it("captures without a title using the url", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/capture`,
      {
        method: "POST",
        body: JSON.stringify({
          url: "https://example.com/untitled",
        }),
      },
      token
    );
    expect(res.status).toBe(201);
    const issue = await res.json();
    expect(issue.title).toBe("https://example.com/untitled");
    expect(issue.status).toBe("triage");
  });

  it("rejects capture without a url", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/capture`,
      {
        method: "POST",
        body: JSON.stringify({ title: "No url" }),
      },
      token
    );
    expect(res.status).toBe(400);
  });
});
