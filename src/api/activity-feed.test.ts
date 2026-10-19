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
      id: "user-activity",
      name: "Activity User",
      email: "activity-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-activity");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Activity test",
    slug: `activity-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-activity",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-activity",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
      permissions: { workspace: ["admin"] },
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

type ActivityItem = {
  kind: string;
  entityType: string;
  entityId: string;
  action: string;
  createdAt: string;
};

describe("workspace activity feed", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("rejects unauthenticated requests", async () => {
    const res = await fetch(`/workspaces/${organizationId}/activity`);
    expect([401, 403]).toContain(res.status);
  });

  it("returns issue history in the unified feed", async () => {
    const createRes = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({ title: "Feed source issue" }),
      },
      token
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json<{ id: string }>();

    const res = await fetch(
      `/workspaces/${organizationId}/activity`,
      {},
      token
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ activity: ActivityItem[] }>();
    expect(body.activity.length).toBeGreaterThan(0);
    const issueEntry = body.activity.find(
      (a) => a.entityType === "issue" && a.entityId === created.id
    );
    expect(issueEntry).toBeDefined();
  });

  it("filters by entityType", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/activity?entityType=session`,
      {},
      token
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ activity: ActivityItem[] }>();
    for (const item of body.activity) {
      expect(item.entityType).toBe("session");
    }
  });
});
