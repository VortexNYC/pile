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

describe("git identity API", () => {
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
      name: "Git identity tests",
      slug: `git-identity-${crypto.randomUUID()}`,
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

  it("creates, lists, and deletes a git identity", async () => {
    const createRes = await app.fetch(
      request(`/workspaces/${organizationId}/git/identities`, {
        method: "POST",
        token,
        body: JSON.stringify({
          repo: "VortexNYC/pile",
          name: "Vortex Agent",
          email: "agent@pile.nyc",
          githubUsername: "vortex-agent",
        }),
      }),
      env
    );
    expect(createRes.status).toBe(200);
    const created = await createRes.json<{
      id: string;
      repo: string;
      name: string;
      email: string;
    }>();
    expect(created.repo).toBe("VortexNYC/pile");

    const listRes = await app.fetch(
      request(`/workspaces/${organizationId}/git/identities`, { token }),
      env
    );
    expect(listRes.status).toBe(200);
    const list = await listRes.json<unknown[]>();
    expect(list).toHaveLength(1);

    const deleteRes = await app.fetch(
      request(`/workspaces/${organizationId}/git/identities/${created.id}`, {
        method: "DELETE",
        token,
      }),
      env
    );
    expect(deleteRes.status).toBe(204);

    const listAfterRes = await app.fetch(
      request(`/workspaces/${organizationId}/git/identities`, { token }),
      env
    );
    expect(listAfterRes.status).toBe(200);
    const after = await listAfterRes.json<unknown[]>();
    expect(after).toHaveLength(0);
  });
});
