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
  favorites: z
    .array(
      z.object({
        type: z.enum(["issue", "document"]),
        id: z.string(),
        title: z.string(),
        identifier: z.string().nullable().optional(),
        addedAt: z.string(),
      })
    )
    .nullable(),
  display: z
    .record(
      z.string(),
      z.object({
        sheetColors: z.record(z.string(), z.string()).optional(),
        density: z.enum(["comfortable", "compact"]).optional(),
        hiddenColumns: z.array(z.string()).optional(),
      })
    )
    .nullable(),
});

beforeAll(async () => {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-savedviews",
      name: "Saved Views User",
      email: "savedviews@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const headers = await createAdminHeaders(env, "user-savedviews");
  const workspace = await createWorkspace(db, env, headers, {
    name: "Saved views test",
    slug: `savedviews-${crypto.randomUUID()}`,
    ownerId: "user-savedviews",
  });
  organizationId = workspace!.id;

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-savedviews",
      name: "test-admin",
      metadata: { organizationId, permissions: "admin" },
      permissions: { workspace: ["admin"] },
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

describe("me/view-preferences display", () => {
  it("defaults display to null", async () => {
    const res = await req(`/workspaces/${organizationId}/me/view-preferences`);
    const body = prefsSchema.parse(await res.json());
    expect(body.display).toBeNull();
  });

  it("round-trips per-surface display prefs", async () => {
    const display = {
      customers: {
        sheetColors: { trades: "#22c55e", tech: "#3b82f6" },
        density: "compact" as const,
        hiddenColumns: ["phone", "location"],
      },
    };
    const put = await req(`/workspaces/${organizationId}/me/view-preferences`, {
      method: "PUT",
      body: JSON.stringify({ display }),
    });
    expect(put.status).toBe(200);
    const putBody = prefsSchema.parse(await put.json());
    expect(putBody.display).toEqual(display);

    const get = await req(`/workspaces/${organizationId}/me/view-preferences`);
    const getBody = prefsSchema.parse(await get.json());
    expect(getBody.display).toEqual(display);
  });

  it("leaves display alone when the PUT omits it", async () => {
    await req(`/workspaces/${organizationId}/me/view-preferences`, {
      method: "PUT",
      body: JSON.stringify({
        display: { customers: { density: "compact" } },
      }),
    });
    const res = await req(`/workspaces/${organizationId}/me/view-preferences`, {
      method: "PUT",
      body: JSON.stringify({ hiddenSurfaces: ["cycles"] }),
    });
    const body = prefsSchema.parse(await res.json());
    expect(body.display).toEqual({ customers: { density: "compact" } });
    expect(body.hiddenSurfaces).toEqual(["cycles"]);
  });

  it("leaves hiddenSurfaces and favorites alone when only display is sent", async () => {
    const res = await req(`/workspaces/${organizationId}/me/view-preferences`, {
      method: "PUT",
      body: JSON.stringify({
        display: { customers: { sheetColors: { trades: "#ef4444" } } },
      }),
    });
    const body = prefsSchema.parse(await res.json());
    expect(body.hiddenSurfaces).toEqual(["cycles"]);
    expect(body.display).toEqual({
      customers: { sheetColors: { trades: "#ef4444" } },
    });
  });

  it("clears display with null", async () => {
    const res = await req(`/workspaces/${organizationId}/me/view-preferences`, {
      method: "PUT",
      body: JSON.stringify({ display: null }),
    });
    expect(res.status).toBe(200);
    const body = prefsSchema.parse(await res.json());
    expect(body.display).toBeNull();
  });

  it("rejects an invalid density value", async () => {
    const res = await req(`/workspaces/${organizationId}/me/view-preferences`, {
      method: "PUT",
      body: JSON.stringify({
        display: { customers: { density: "ultra" } },
      }),
    });
    expect(res.status).toBe(400);
  });
});
