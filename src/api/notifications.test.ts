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
      id: "user-notifications",
      name: "Notifications User",
      email: "notifications-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-notifications");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Notifications test",
    slug: `notifications-${crypto.randomUUID()}`,
    key: `N${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-notifications",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-notifications",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

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

const prefsSchema = z.object({
  inApp: z.boolean(),
  webhook: z.boolean(),
  email: z.boolean(),
  emailExplicit: z.boolean(),
  mutedTypes: z.array(z.string()).nullable(),
  updatedAt: z.string(),
});

describe("notification preferences API", () => {
  let organizationId: string;
  let token: string;
  const prefsPath = () =>
    `/workspaces/${organizationId}/notification-preferences`;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("returns unset defaults when the member has no prefs row", async () => {
    const res = await fetch(prefsPath(), {}, token);
    expect(res.status).toBe(200);
    const prefs = prefsSchema.parse(await res.json());
    expect(prefs.inApp).toBe(true);
    expect(prefs.email).toBe(false);
    expect(prefs.emailExplicit).toBe(false);
    expect(prefs.mutedTypes).toBeNull();
  });

  it("keeps email unset when a write only touches other fields", async () => {
    const res = await fetch(
      prefsPath(),
      {
        method: "PUT",
        body: JSON.stringify({ mutedTypes: ["issue_updated"] }),
      },
      token
    );
    expect(res.status).toBe(200);
    const prefs = prefsSchema.parse(await res.json());
    // The write did not pass `email`, so the member keeps the
    // default-on directed-email behavior rather than an implicit opt-out.
    expect(prefs.emailExplicit).toBe(false);
    expect(prefs.mutedTypes).toEqual(["issue_updated"]);
  });

  it("marks email explicit once the caller chooses it", async () => {
    const res = await fetch(
      prefsPath(),
      { method: "PUT", body: JSON.stringify({ email: false }) },
      token
    );
    expect(res.status).toBe(200);
    const prefs = prefsSchema.parse(await res.json());
    expect(prefs.email).toBe(false);
    expect(prefs.emailExplicit).toBe(true);

    const enabled = await fetch(
      prefsPath(),
      { method: "PUT", body: JSON.stringify({ email: true }) },
      token
    );
    const enabledPrefs = prefsSchema.parse(await enabled.json());
    expect(enabledPrefs.email).toBe(true);
    expect(enabledPrefs.emailExplicit).toBe(true);
  });
});
