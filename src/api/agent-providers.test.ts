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

describe("agent provider catalog API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const db = createD1(env.D1);
    const now = new Date();
    await db
      .insert(userTable)
      .values({
        id: "user-catalog",
        name: "Catalog User",
        email: "user-catalog@example.com",
        emailVerified: false,
        image: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [userTable.email] });
    const headers = await createAdminHeaders(env, "user-catalog");
    const workspace = await createWorkspace(db, env, headers, {
      name: "Catalog tests",
      slug: `agent-catalog-${crypto.randomUUID()}`,
      ownerId: "user-catalog",
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
        userId: "user-catalog",
        name: "test-admin",
        metadata: { organizationId, permissions: "admin" },
      },
    });
    token = z.object({ key: z.string() }).parse(result).key;
  });

  it("lists agents with hosted vs BYO fields", async () => {
    const res = await app.fetch(
      request(`/workspaces/${organizationId}/agent/providers/catalog`, {
        token,
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      providers: Array<{
        id: string;
        modes: Array<{ id: string; fields: Array<{ key: string }> }>;
      }>;
    }>();
    const codex = body.providers.find((provider) => provider.id === "codex");
    expect(codex?.modes.map((mode) => mode.id)).toEqual(["hosted", "byo"]);
  });

  it("saves Codex hosted when mode and token are present", async () => {
    const res = await app.fetch(
      request(`/workspaces/${organizationId}/agent/providers/codex`, {
        method: "PUT",
        token,
        body: JSON.stringify({ mode: "hosted", token: "sk-test" }),
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json<{
      hasToken: boolean;
      config: { mode?: string; environment?: { type?: string } };
    }>();
    expect(body.hasToken).toBe(true);
    expect(body.config.mode).toBe("hosted");
    expect(body.config.environment?.type).toBe("openai_hosted");
  });

  it("rejects Cursor BYO without the machine name", async () => {
    const res = await app.fetch(
      request(`/workspaces/${organizationId}/agent/providers/cursor`, {
        method: "PUT",
        token,
        body: JSON.stringify({
          mode: "byo",
          token: "cursor-key",
          config: { env: { type: "machine" } },
        }),
      }),
      env
    );
    expect(res.status).toBe(400);
  });
});
