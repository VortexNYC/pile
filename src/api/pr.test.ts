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
      id: "user-pr",
      name: "PR User",
      email: "pr-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-pr");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "PR test",
    slug: `pr-${crypto.randomUUID()}`,
    key: `P${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-pr",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-pr",
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

async function createIssueWithPrUrl(
  organizationId: string,
  prUrl: string,
  token: string
): Promise<string> {
  const res = await fetch(
    `/workspaces/${organizationId}/issues`,
    {
      method: "POST",
      body: JSON.stringify({
        title: "PR test",
        repo: "owner/repo",
        branch: `branch-${crypto.randomUUID()}`,
      }),
    },
    token
  );
  const issue = await res.json();
  const id = issue.id as string;

  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
  await stub.setOrganizationId(organizationId);
  await stub.reconcileIssuePr(id, prUrl, "open", "pending");
  return id;
}

describe("pr API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("rejects getting PR status for an unknown issue", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/pr`,
      {},
      token
    );
    expect(res.status).toBe(404);
  });

  it("reconciling an unknown issue returns 404", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues/00000000-0000-0000-0000-000000000000/reconcile`,
      { method: "POST" },
      token
    );
    expect(res.status).toBe(404);
  });

  it("reconciling an issue without a prUrl returns 400", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "No PR",
          repo: "owner/repo",
          branch: `branch-${crypto.randomUUID()}`,
        }),
      },
      token
    );
    const issue = (await res.json()) as { id: string };

    const reconcile = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}/reconcile`,
      { method: "POST" },
      token
    );
    expect(reconcile.status).toBe(400);
  });

  it("reconciling a malformed prUrl returns 400", async () => {
    const id = await createIssueWithPrUrl(
      organizationId,
      "https://example.com/not-a-pr",
      token
    );
    const res = await fetch(
      `/workspaces/${organizationId}/issues/${id}/reconcile`,
      { method: "POST" },
      token
    );
    expect(res.status).toBe(400);
  });

  it("reconciling a non-GitHub prUrl returns 400", async () => {
    const id = await createIssueWithPrUrl(
      organizationId,
      "https://gitlab.com/owner/repo/-/merge_requests/1",
      token
    );
    const res = await fetch(
      `/workspaces/${organizationId}/issues/${id}/reconcile`,
      { method: "POST" },
      token
    );
    expect(res.status).toBe(400);
  });

  it("reconciling a GitHub prUrl with no installation returns 400", async () => {
    const id = await createIssueWithPrUrl(
      organizationId,
      "https://github.com/unknown-owner/unknown-repo/pull/1",
      token
    );
    const res = await fetch(
      `/workspaces/${organizationId}/issues/${id}/reconcile`,
      { method: "POST" },
      token
    );
    expect(res.status).toBe(400);
  });

  it("gets PR status for an issue", async () => {
    const id = await createIssueWithPrUrl(
      organizationId,
      "https://github.com/owner/repo/pull/1",
      token
    );
    const res = await fetch(
      `/workspaces/${organizationId}/issues/${id}/pr`,
      {},
      token
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      prUrl: string;
      prState: string;
      prCheckState: string;
      status: string;
    };
    expect(body.id).toBe(id);
    expect(body.prUrl).toBe("https://github.com/owner/repo/pull/1");
    expect(body.prState).toBe("open");
    expect(body.prCheckState).toBe("pending");
    expect(body.status).toBe("in_progress");
  });
});
