import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

const ADMIN_ID = "user-memory-admin";

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
      name: "Memory Admin",
      email: `${ADMIN_ID}@example.com`,
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.id] });

  const setupHeaders = await createAdminHeaders(env, ADMIN_ID);
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Memory routes test",
    slug: `memory-${crypto.randomUUID()}`,
    key: `M${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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

async function remember(
  seeded: Seeded,
  body: Record<string, unknown>
): Promise<string> {
  const res = await fetchJson(
    `/workspaces/${seeded.organizationId}/memory`,
    { method: "POST", body: JSON.stringify(body) },
    seeded.adminToken
  );
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}

describe("workspace memory routes", () => {
  let seeded: Seeded;

  beforeAll(async () => {
    seeded = await seedWorkspace();
  });

  it("PATCH /memory/{id} updates a fact in place and 404s on ghosts (PILE-628)", async () => {
    const id = await remember(seeded, {
      entityType: "agent",
      entityId: "patch-agent",
      kind: "lesson",
      fact: "draft fact",
    });
    const res = await fetchJson(
      `/workspaces/${seeded.organizationId}/memory/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ fact: "corrected fact", kind: "decision" }),
      },
      seeded.adminToken
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      memory: { id: string; fact: string; kind: string };
    }>();
    expect(body.memory.id).toBe(id);
    expect(body.memory.fact).toBe("corrected fact");
    expect(body.memory.kind).toBe("decision");

    const ghost = await fetchJson(
      `/workspaces/${seeded.organizationId}/memory/${crypto.randomUUID()}`,
      { method: "PATCH", body: JSON.stringify({ fact: "nope" }) },
      seeded.adminToken
    );
    expect(ghost.status).toBe(404);
  });

  it("DELETE /memory/{id} erases the fact and its superseded history (PILE-628)", async () => {
    await remember(seeded, {
      entityType: "customer",
      entityId: "del-cust",
      kind: "coverage",
      fact: "v1 fact",
    });
    const head = await remember(seeded, {
      entityType: "customer",
      entityId: "del-cust",
      kind: "coverage",
      fact: "v2 fact",
    });
    const res = await fetchJson(
      `/workspaces/${seeded.organizationId}/memory/${head}`,
      { method: "DELETE" },
      seeded.adminToken
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      deleted: boolean;
      id: string;
      deletedCount: number;
    }>();
    expect(body).toEqual({ deleted: true, id: head, deletedCount: 2 });

    // The fact is gone — recall returns nothing for the entity.
    const recall = await fetchJson(
      `/workspaces/${seeded.organizationId}/memory?entityType=customer&entityId=del-cust`,
      {},
      seeded.adminToken
    );
    expect(recall.status).toBe(200);
    expect((await recall.json<{ memories: unknown[] }>()).memories).toEqual([]);

    const ghost = await fetchJson(
      `/workspaces/${seeded.organizationId}/memory/${crypto.randomUUID()}`,
      { method: "DELETE" },
      seeded.adminToken
    );
    expect(ghost.status).toBe(404);
  });

  it("GET /memory/profile splits static vs dynamic facts (PILE-616)", async () => {
    await remember(seeded, {
      entityType: "repo",
      entityId: "prof-repo",
      kind: "convention",
      fact: "always pnpm, never npm",
    });
    await remember(seeded, {
      entityType: "repo",
      entityId: "prof-repo",
      kind: "outcome",
      fact: "lane finished the rebuild",
    });
    const res = await fetchJson(
      `/workspaces/${seeded.organizationId}/memory/profile?entityType=repo&entityId=prof-repo`,
      {},
      seeded.adminToken
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      entityType: string;
      entityId: string;
      staticFacts: Array<{ kind: string }>;
      dynamicFacts: Array<{ kind: string }>;
      byKind: Record<string, unknown[]>;
      summary: string;
    }>();
    expect(body.staticFacts.map((f) => f.kind)).toEqual(["convention"]);
    expect(body.dynamicFacts.map((f) => f.kind)).toEqual(["outcome"]);
    expect(body.byKind.convention).toHaveLength(1);
    expect(body.summary).toContain("### Static Profile (repo:prof-repo)");
    expect(body.summary).toContain("### Recent / Dynamic Context");
  });

  it("POST /memory/batch writes explicit items and extracts document facts (PILE-617)", async () => {
    const docRes = await fetchJson(
      `/workspaces/${seeded.organizationId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Runbook notes",
          contentFormat: "markdown",
          content:
            "## Decisions\n- wrangler always deploys with the prod account pinned",
        }),
      },
      seeded.adminToken
    );
    expect(docRes.status).toBe(201);
    const doc = await docRes.json<{ id: string }>();

    const res = await fetchJson(
      `/workspaces/${seeded.organizationId}/memory/batch`,
      {
        method: "POST",
        body: JSON.stringify({
          memories: [
            {
              entityType: "workspace",
              entityId: "batch-e2e",
              kind: "lesson",
              fact: "explicit e2e fact",
            },
          ],
          documentIds: [doc.id],
        }),
      },
      seeded.adminToken
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      ids: string[];
      count: number;
      extractedFromDocuments: number;
    }>();
    expect(body.count).toBe(2);
    expect(body.extractedFromDocuments).toBe(1);

    const recalled = await fetchJson(
      `/workspaces/${seeded.organizationId}/memory?entityType=document&entityId=${doc.id}`,
      {},
      seeded.adminToken
    );
    const rows = await recalled.json<{
      memories: Array<{ kind: string; fact: string }>;
    }>();
    expect(rows.memories.map((m) => m.kind)).toEqual(["decision"]);
    expect(rows.memories[0].fact).toContain("wrangler always deploys");
  });

  it("POST /memory/extract distills labeled facts from text (PILE-627)", async () => {
    const res = await fetchJson(
      `/workspaces/${seeded.organizationId}/memory/extract`,
      {
        method: "POST",
        body: JSON.stringify({
          text: "**Lesson:** never skip contract:check after touching generated files\n**Verification:** all probes returned 200",
          entityType: "workspace",
          entityId: "extract-e2e",
        }),
      },
      seeded.adminToken
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      ids: string[];
      facts: Array<{ id: string; kind: string; fact: string }>;
    }>();
    expect(body.ids).toHaveLength(2);
    expect(body.facts.map((f) => f.kind).toSorted()).toEqual([
      "lesson",
      "verification",
    ]);
  });
});
