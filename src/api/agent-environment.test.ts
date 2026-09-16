import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { organization, user as userTable } from "../global/schema.js";
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

describe("agent environment API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: "user-env",
        name: "Env User",
        email: "user-env@example.com",
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, "user-env");
    const workspace = await createWorkspace(db, env, headers, {
      name: "Agent env tests",
      slug: `agent-env-${crypto.randomUUID()}`,
      ownerId: "user-env",
    });
    organizationId = workspace!.id;
    await db
      .update(organization)
      .set({
        metadata: JSON.stringify({ key: workspace?.key ?? null }),
      })
      .where(eq(organization.id, organizationId));
    const auth = createAuth(env);
    const result = await auth.api.createApiKey({
      body: {
        userId: "user-env",
        name: "test-admin",
        metadata: { organizationId, permissions: "admin" },
      },
    });
    token = z.object({ key: z.string() }).parse(result).key;
  });

  it("stores AGENTS.md, skills, and rules and rejects other paths", async () => {
    const put = await app.fetch(
      request(`/workspaces/${organizationId}/agent/environment`, {
        method: "PUT",
        token,
        body: JSON.stringify({
          path: "AGENTS.md",
          content: "# Pile\nUse pnpm.",
        }),
      }),
      env
    );
    expect(put.status).toBe(200);

    const skill = await app.fetch(
      request(`/workspaces/${organizationId}/agent/environment`, {
        method: "PUT",
        token,
        body: JSON.stringify({
          path: "skills/review.md",
          content: "Review the diff.",
        }),
      }),
      env
    );
    expect(skill.status).toBe(200);

    const rejected = await app.fetch(
      request(`/workspaces/${organizationId}/agent/environment`, {
        method: "PUT",
        token,
        body: JSON.stringify({
          path: "../secrets.md",
          content: "nope",
        }),
      }),
      env
    );
    expect(rejected.status).toBe(400);

    const listed = await app.fetch(
      request(`/workspaces/${organizationId}/agent/environment`, { token }),
      env
    );
    expect(listed.status).toBe(200);
    const body = await listed.json<{ files: Array<{ path: string }> }>();
    expect(body.files.map((f) => f.path)).toEqual([
      "AGENTS.md",
      "skills/review.md",
    ]);

    const got = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/environment/file?path=AGENTS.md`,
        { token }
      ),
      env
    );
    expect(got.status).toBe(200);
    const file = await got.json<{ content: string }>();
    expect(file.content).toContain("Use pnpm.");

    const deleted = await app.fetch(
      request(
        `/workspaces/${organizationId}/agent/environment/file?path=skills%2Freview.md`,
        { method: "DELETE", token }
      ),
      env
    );
    expect(deleted.status).toBe(204);
  });
});
