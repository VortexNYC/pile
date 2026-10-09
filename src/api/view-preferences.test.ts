import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

let organizationId: string;
let token: string;

const prefsSchema = z.object({
  defaultViewId: z.string().nullable(),
  hiddenSurfaces: z.array(z.string()).nullable(),
});

beforeAll(async () => {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-viewprefs",
      name: "Prefs User",
      email: "viewprefs@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const headers = await createAdminHeaders(env, "user-viewprefs");
  const workspace = await createWorkspace(db, env, headers, {
    name: "View prefs test",
    slug: `viewprefs-${crypto.randomUUID()}`,
    ownerId: "user-viewprefs",
  });
  organizationId = workspace!.id;

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-viewprefs",
      name: "test-admin",
      metadata: { organizationId, permissions: "admin" },
    },
  });
  token = z.object({ key: z.string() }).parse(result).key;
});

async function req(path: string, init: RequestInit = {}) {
  return app.fetch(
    new Request(`https://example.com${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    }),
    env
  );
}

describe("view preferences", () => {
  it("round-trips hiddenSurfaces", async () => {
    const put = await req(`/workspaces/${organizationId}/me/view-preferences`, {
      method: "PUT",
      body: JSON.stringify({ hiddenSurfaces: ["cycles", "roadmaps"] }),
    });
    expect(put.status).toBe(200);
    const putBody = prefsSchema.parse(await put.json());
    expect(putBody.hiddenSurfaces).toEqual(["cycles", "roadmaps"]);

    const get = await req(`/workspaces/${organizationId}/me/view-preferences`);
    const getBody = prefsSchema.parse(await get.json());
    expect(getBody.hiddenSurfaces).toEqual(["cycles", "roadmaps"]);
    expect(getBody.defaultViewId).toBeNull();
  });

  it("clears hiddenSurfaces with an empty array", async () => {
    await req(`/workspaces/${organizationId}/me/view-preferences`, {
      method: "PUT",
      body: JSON.stringify({ hiddenSurfaces: [] }),
    });
    const get = await req(`/workspaces/${organizationId}/me/view-preferences`);
    const body = prefsSchema.parse(await get.json());
    expect(body.hiddenSurfaces).toEqual([]);
  });

  it("leaves hiddenSurfaces alone when the PUT omits it", async () => {
    await req(`/workspaces/${organizationId}/me/view-preferences`, {
      method: "PUT",
      body: JSON.stringify({ hiddenSurfaces: ["sessions"] }),
    });
    const res = await req(`/workspaces/${organizationId}/me/view-preferences`, {
      method: "PUT",
      body: JSON.stringify({ defaultViewId: null }),
    });
    const body = prefsSchema.parse(await res.json());
    expect(body.hiddenSurfaces).toEqual(["sessions"]);
  });
});
