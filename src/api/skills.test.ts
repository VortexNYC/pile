import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

const ORIGIN = "https://your-domain.com";

function request(
  path: string,
  init: RequestInit & { token?: string } = {}
): Request {
  const headers = new Headers(init.headers);
  if (init.token) {
    headers.set("Authorization", `Bearer ${init.token}`);
  }
  if (["POST", "PATCH", "PUT", "DELETE"].includes(init.method ?? "GET")) {
    headers.set("Origin", ORIGIN);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
  }
  return new Request(`http://localhost${path}`, {
    ...init,
    headers,
  });
}

describe("Workspace skills API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
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
    const headers = await createAdminHeaders(env, "user-1");
    const workspace = await createWorkspace(db, env, headers, {
      name: "Skills tests",
      slug: `skills-api-${crypto.randomUUID()}`,
      ownerId: "user-1",
    });
    organizationId = workspace!.id;
    const auth = createAuth(env);
    const result = await auth.api.createApiKey({
      body: {
        userId: "user-1",
        name: "test-admin",
        metadata: { organizationId, permissions: "admin" },
      },
    });
    token = z.object({ key: z.string() }).parse(result).key;
  });

  it("creates, lists, gets, and deletes skills", async () => {
    const createRes = await app.fetch(
      request(`/workspaces/${organizationId}/skills`, {
        method: "POST",
        token,
        body: JSON.stringify({
          name: "Pile conventions",
          content: "# Pile conventions\n\nUse pnpm.",
          scope: "workspace",
        }),
      }),
      env
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json<{
      id: string;
      name: string;
      scope: string;
    }>();
    expect(created.name).toBe("Pile conventions");

    const listRes = await app.fetch(
      request(`/workspaces/${organizationId}/skills`, { token }),
      env
    );
    expect(listRes.status).toBe(200);
    const list = await listRes.json<{ skills: unknown[] }>();
    expect(list.skills).toHaveLength(1);

    const getRes = await app.fetch(
      request(`/workspaces/${organizationId}/skills/${created.id}`, { token }),
      env
    );
    expect(getRes.status).toBe(200);
    const got = await getRes.json<{ id: string; content: string }>();
    expect(got.content).toContain("Use pnpm.");

    const deleteRes = await app.fetch(
      request(`/workspaces/${organizationId}/skills/${created.id}`, {
        method: "DELETE",
        token,
      }),
      env
    );
    expect(deleteRes.status).toBe(204);

    const getAfterRes = await app.fetch(
      request(`/workspaces/${organizationId}/skills/${created.id}`, { token }),
      env
    );
    expect(getAfterRes.status).toBe(404);
  });
});
