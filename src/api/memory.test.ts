import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

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

async function seed() {
  const db = createD1(env.D1);
  const auth = await createAuth(env);
  const userId = `user-${crypto.randomUUID()}`;
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: userId,
      name: "Memory Owner",
      email: `${userId}@example.com`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, userId);
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Memory test",
    slug: `memory-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: userId,
  });
  if (!workspace) throw new Error("workspace not created");

  const adminResult = await auth.api.createApiKey({
    body: {
      userId,
      name: "test-admin",
      metadata: { organizationId: workspace.id, permissions: "admin" },
      permissions: { workspace: ["admin"] },
    },
  });
  const readResult = await auth.api.createApiKey({
    body: {
      userId,
      name: "test-read",
      metadata: { organizationId: workspace.id, permissions: "read" },
      permissions: { workspace: ["read"] },
    },
  });
  const keySchema = z.object({ key: z.string() });
  return {
    organizationId: workspace.id,
    adminToken: keySchema.parse(adminResult).key,
    readToken: keySchema.parse(readResult).key,
  };
}

const memorySchema = z.object({
  id: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  kind: z.string(),
  key: z.string().nullable(),
  fact: z.string(),
});

const listSchema = z.object({ memories: z.array(memorySchema) });

async function remember(
  organizationId: string,
  token: string,
  body: Record<string, unknown>
) {
  return fetch(
    `/workspaces/${organizationId}/memory`,
    { method: "POST", body: JSON.stringify(body) },
    token
  );
}

describe("workspace memory API (PILE-447)", () => {
  it(
    "remembers and recalls facts with entity/kind/search filters",
    { timeout: 30000 },
    async () => {
      const { organizationId, adminToken } = await seed();
      const res = await remember(organizationId, adminToken, {
        entityType: "merchant",
        entityId: "smith-st",
        kind: "coverage",
        fact: "swept Smith St corridor on 2026-10-19",
      });
      expect(res.status).toBe(200);
      const { id } = z.object({ id: z.string() }).parse(await res.json());

      const byEntity = await fetch(
        `/workspaces/${organizationId}/memory?entityType=merchant&entityId=smith-st&kind=coverage`,
        {},
        adminToken
      );
      const memories = listSchema.parse(await byEntity.json()).memories;
      expect(memories.map((m) => m.id)).toContain(id);

      const bySearch = await fetch(
        `/workspaces/${organizationId}/memory?search=${encodeURIComponent("Smith St")}`,
        {},
        adminToken
      );
      expect(
        listSchema.parse(await bySearch.json()).memories.map((m) => m.id)
      ).toContain(id);

      const wrongKind = await fetch(
        `/workspaces/${organizationId}/memory?kind=lesson`,
        {},
        adminToken
      );
      expect(
        listSchema.parse(await wrongKind.json()).memories.map((m) => m.id)
      ).not.toContain(id);
    }
  );

  it(
    "stores a caller key and looks it up by exact match",
    { timeout: 30000 },
    async () => {
      const { organizationId, adminToken } = await seed();
      const res = await remember(organizationId, adminToken, {
        entityType: "issue",
        entityId: "ISS-1",
        kind: "decision",
        key: "decision:auth-schema",
        fact: "sessions live in D1, not the DO",
      });
      expect(res.status).toBe(200);

      const recall = await fetch(
        `/workspaces/${organizationId}/memory?key=decision:auth-schema`,
        {},
        adminToken
      );
      const memories = listSchema.parse(await recall.json()).memories;
      expect(memories).toHaveLength(1);
      expect(memories[0].key).toBe("decision:auth-schema");
    }
  );

  it(
    "supersedes the prior fact when a key is rewritten",
    { timeout: 30000 },
    async () => {
      const { organizationId, adminToken } = await seed();
      for (const fact of ["v1: use sqlite", "v2: use d1 via drizzle"]) {
        const res = await remember(organizationId, adminToken, {
          entityType: "issue",
          entityId: "ISS-2",
          kind: "decision",
          key: "decision:storage",
          fact,
        });
        expect(res.status).toBe(200);
      }
      const recall = await fetch(
        `/workspaces/${organizationId}/memory?key=decision:storage`,
        {},
        adminToken
      );
      const memories = listSchema.parse(await recall.json()).memories;
      expect(memories).toHaveLength(1);
      expect(memories[0].fact).toBe("v2: use d1 via drizzle");
    }
  );

  it(
    "fetches a single memory by row id and 404s unknown ids",
    { timeout: 30000 },
    async () => {
      const { organizationId, adminToken } = await seed();
      const res = await remember(organizationId, adminToken, {
        entityType: "agent",
        entityId: "grok",
        kind: "preference",
        fact: "grok prefers bullet lists",
      });
      const { id } = z.object({ id: z.string() }).parse(await res.json());

      const got = await fetch(
        `/workspaces/${organizationId}/memory/${id}`,
        {},
        adminToken
      );
      expect(got.status).toBe(200);
      const { memory } = z
        .object({ memory: memorySchema })
        .parse(await got.json());
      expect(memory.id).toBe(id);

      const missing = await fetch(
        `/workspaces/${organizationId}/memory/${crypto.randomUUID()}`,
        {},
        adminToken
      );
      expect(missing.status).toBe(404);
    }
  );

  it(
    "lets a read-only key recall but not remember",
    { timeout: 30000 },
    async () => {
      const { organizationId, adminToken, readToken } = await seed();
      await remember(organizationId, adminToken, {
        entityType: "merchant",
        entityId: "smith-st",
        kind: "coverage",
        fact: "readable fact",
      });

      const list = await fetch(
        `/workspaces/${organizationId}/memory`,
        {},
        readToken
      );
      expect(list.status).toBe(200);
      expect(
        listSchema.parse(await list.json()).memories.length
      ).toBeGreaterThan(0);

      const write = await remember(organizationId, readToken, {
        entityType: "merchant",
        entityId: "smith-st",
        kind: "coverage",
        fact: "should fail",
      });
      expect(write.status).toBe(403);
    }
  );

  it(
    "mints a memory-scoped agent token that can recall but nothing else",
    { timeout: 30000 },
    async () => {
      const { organizationId, adminToken } = await seed();
      await remember(organizationId, adminToken, {
        entityType: "merchant",
        entityId: "smith-st",
        kind: "coverage",
        key: "shared:context",
        fact: "context the bot should read",
      });

      const mint = await fetch(
        `/workspaces/${organizationId}/tokens`,
        {
          method: "POST",
          body: JSON.stringify({
            name: "memory-bot",
            actorType: "agent",
            permissions: "memory:view",
          }),
        },
        adminToken
      );
      expect(mint.status).toBe(201);
      const { token, userId } = z
        .object({ token: z.string(), userId: z.string() })
        .parse(await mint.json());
      expect(userId.length).toBeGreaterThan(0);

      const recall = await fetch(
        `/workspaces/${organizationId}/memory?key=shared:context`,
        {},
        token
      );
      expect(recall.status).toBe(200);
      const memories = listSchema.parse(await recall.json()).memories;
      expect(memories).toHaveLength(1);

      const write = await remember(organizationId, token, {
        entityType: "merchant",
        entityId: "smith-st",
        kind: "coverage",
        fact: "denied",
      });
      expect(write.status).toBe(403);

      // The scope is memory-only — the workspace issue list stays closed.
      const issues = await fetch(
        `/workspaces/${organizationId}/issues`,
        {},
        token
      );
      expect(issues.status).toBe(403);
    }
  );
});
