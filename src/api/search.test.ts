import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

const ADMIN_ID = "user-search-admin";

interface Seeded {
  organizationId: string;
  adminToken: string;
}

async function createKey(userId: string, organizationId: string) {
  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId,
      name: `test-${userId}`,
      rateLimitEnabled: false,
      metadata: {
        organizationId,
        permissions: "admin",
      },
      permissions: {
        workspace: ["admin"],
      },
    },
  });
  return z.object({ key: z.string() }).parse(result).key;
}

async function seedWorkspace(): Promise<Seeded> {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: ADMIN_ID,
      name: "Search Admin",
      email: `${ADMIN_ID}@example.com`,
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.id] });

  const setupHeaders = await createAdminHeaders(env, ADMIN_ID);
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Search test",
    slug: `search-${crypto.randomUUID()}`,
    key: `S${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: ADMIN_ID,
  });
  const organizationId = workspace!.id;
  return {
    organizationId,
    adminToken: await createKey(ADMIN_ID, organizationId),
  };
}

async function fetchJson(
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : undefined),
    ...(init.headers as Record<string, string> | undefined),
  };
  return app.fetch(
    new Request(`https://example.com${path}`, { ...init, headers }),
    env
  );
}

describe("workspace search", () => {
  let seeded: Seeded;

  beforeAll(async () => {
    seeded = await seedWorkspace();
  });

  it("returns issueIds, documentIds, and memoryIds (PILE-618/629)", async () => {
    const marker = crypto.randomUUID().slice(0, 8);
    const issueRes = await fetchJson(
      `/workspaces/${seeded.organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({ title: `Quixotic zebroid-${marker} rollout` }),
      },
      seeded.adminToken
    );
    expect(issueRes.status).toBe(201);
    const issue = await issueRes.json<{ id: string; identifier: string }>();

    const memoryRes = await fetchJson(
      `/workspaces/${seeded.organizationId}/memory`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "agent",
          entityId: "search-agent",
          kind: "lesson",
          fact: `zebroid-${marker} sweeps need idempotency keys`,
        }),
      },
      seeded.adminToken
    );
    expect(memoryRes.status).toBe(200);
    const { id: memoryId } = await memoryRes.json<{ id: string }>();

    const res = await fetchJson(
      `/workspaces/${seeded.organizationId}/search`,
      {
        method: "POST",
        body: JSON.stringify({ query: `zebroid-${marker}` }),
      },
      seeded.adminToken
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      issueIds: string[];
      documentIds: string[];
      memoryIds: string[];
      results: {
        type: string;
        id: string;
        identifier: string | null;
        title: string;
        snippet: string;
        score: number;
      }[];
    }>();
    expect(body.issueIds).toContain(issue.id);
    expect(body.documentIds).toEqual([]);
    expect(body.memoryIds).toContain(memoryId);

    // VTX-758 — hydrated results carry title/snippet/score.
    const issueHit = body.results.find(
      (r) => r.type === "issue" && r.id === issue.id
    );
    expect(issueHit).toBeDefined();
    expect(issueHit?.identifier).toBe(issue.identifier);
    expect(issueHit?.title).toContain(`zebroid-${marker}`);
    expect(typeof issueHit?.score).toBe("number");

    const memoryHit = body.results.find(
      (r) => r.type === "memory" && r.id === memoryId
    );
    expect(memoryHit).toBeDefined();
    expect(memoryHit?.snippet).toContain(`zebroid-${marker}`);
  });
});
