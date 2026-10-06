import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { member as memberTable, user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "./auth.js";
import { createAdminHeaders } from "./test-auth.js";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  const userId = `middleware-user-${crypto.randomUUID()}`;
  await db
    .insert(userTable)
    .values({
      id: userId,
      name: "Middleware User",
      email: `${userId}@example.com`,
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, userId);
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Middleware test",
    slug: `middleware-${crypto.randomUUID()}`,
    key: `M${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: userId,
  });

  const auth = await createAuth(env);
  const keyResult = await auth.api.createApiKey({
    body: {
      userId,
      name: "workspace-key",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "read" },
    },
  });
  const { key } = z.object({ key: z.string() }).parse(keyResult);
  return { organizationId: workspace!.id, userId, token: key };
}

function authedRequest(organizationId: string, token: string) {
  return app.fetch(
    new Request(`https://example.com/workspaces/${organizationId}/issues`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    env
  );
}

describe("workspaceAuthMiddleware", () => {
  let member: Awaited<ReturnType<typeof seedWorkspace>>;
  let removed: Awaited<ReturnType<typeof seedWorkspace>>;
  let foreign: Awaited<ReturnType<typeof seedWorkspace>>;

  beforeAll(async () => {
    // Distinct seeds per invariant: `removed` loses its member row, `member`
    // keeps it, and `foreign` supplies a key from a different workspace.
    [member, removed, foreign] = await Promise.all([
      seedWorkspace(),
      seedWorkspace(),
      seedWorkspace(),
    ]);
    const db = createD1(env.D1);
    await db
      .delete(memberTable)
      .where(
        and(
          eq(memberTable.organizationId, removed.organizationId),
          eq(memberTable.userId, removed.userId)
        )
      );
  }, 30000);

  it("accepts an API key while its backing user is a member", async () => {
    const res = await authedRequest(member.organizationId, member.token);
    expect(res.status).toBe(200);
  });

  it("rejects an API key once its backing user's membership is removed", async () => {
    const res = await authedRequest(removed.organizationId, removed.token);
    expect(res.status).toBe(403);
  });

  it("rejects an API key minted for a different workspace", async () => {
    const res = await authedRequest(member.organizationId, foreign.token);
    expect(res.status).toBe(403);
  });

  it("clamps an API key's permissions when its owner is demoted", async () => {
    const db = createD1(env.D1);
    const now = new Date();
    const userId = `demoted-${crypto.randomUUID()}`;
    await db.insert(userTable).values({
      id: userId,
      name: "Soon demoted",
      email: `${userId}@example.com`,
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
    const setupHeaders = await createAdminHeaders(env, userId);
    const workspace = await createWorkspace(db, env, setupHeaders, {
      name: "Demotion test",
      slug: `demotion-${crypto.randomUUID()}`,
      key: `D${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      ownerId: userId,
    });
    const organizationId = workspace!.id;

    const auth = await createAuth(env);
    const keyResult = await auth.api.createApiKey({
      body: {
        userId,
        name: "admin-key",
        rateLimitEnabled: false,
        metadata: { organizationId, permissions: "read,write,admin" },
      },
    });
    const { key } = z.object({ key: z.string() }).parse(keyResult);

    // Owner role carries admin: the key reaches an admin-gated route.
    const adminProbe = () =>
      app.fetch(
        new Request(
          `https://example.com/workspaces/${organizationId}/memberships`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ userId: "nobody" }),
          }
        ),
        env
      );
    expect((await adminProbe()).status).not.toBe(403);

    // Demote owner -> member; the minted admin scope stops working without
    // any key change.
    await db
      .update(memberTable)
      .set({ role: "member" })
      .where(
        and(
          eq(memberTable.organizationId, organizationId),
          eq(memberTable.userId, userId)
        )
      );
    expect((await adminProbe()).status).toBe(403);
  });
});
