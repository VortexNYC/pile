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
      id: "user-1",
      name: "Test User",
      email: "user-1@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-1");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Support team test",
    slug: `support-team-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-1",
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-1",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

describe("support-team API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  function fetch(path: string, init: RequestInit = {}) {
    const request = new Request(`https://example.com${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    return app.fetch(request, env);
  }

  it("sets and reads agent status", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/support/users/user-1/status`,
      {
        method: "POST",
        body: JSON.stringify({
          status: "away",
          until: "2026-12-31T23:59:59.000Z",
        }),
      }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: { userId: string; status: string };
    };
    expect(body.status.userId).toBe("user-1");
    expect(body.status.status).toBe("away");
  });

  it("lists support agents", async () => {
    const res = await fetch(`/workspaces/${organizationId}/support/agents`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: { userId: string; openTickets: number }[];
    };
    expect(body.agents.length).toBeGreaterThanOrEqual(1);
    const agent = body.agents.find((a) => a.userId === "user-1");
    expect(agent).toBeDefined();
    expect(agent?.openTickets).toBe(0);
  });

  it("manages support tiers and members", async () => {
    const create = await fetch(`/workspaces/${organizationId}/support/tiers`, {
      method: "POST",
      body: JSON.stringify({ name: "Tier 1", level: 1 }),
    });
    expect(create.status).toBe(201);
    const tier = (await create.json()) as { tier: { id: string } };

    const list = await fetch(`/workspaces/${organizationId}/support/tiers`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { tiers: { id: string }[] };
    expect(listBody.tiers.some((t) => t.id === tier.tier.id)).toBe(true);

    const add = await fetch(
      `/workspaces/${organizationId}/support/tiers/${tier.tier.id}/members`,
      {
        method: "POST",
        body: JSON.stringify({ userId: "user-1" }),
      }
    );
    expect(add.status).toBe(201);

    const members = await fetch(
      `/workspaces/${organizationId}/support/tiers/${tier.tier.id}/members`
    );
    expect(members.status).toBe(200);
    const membersBody = (await members.json()) as {
      members: { userId: string }[];
    };
    expect(membersBody.members.some((m) => m.userId === "user-1")).toBe(true);
  });
});
