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
      id: "user-deals",
      name: "Deals User",
      email: "deals-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-deals");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Deals test",
    slug: `deals-${crypto.randomUUID()}`,
    key: `D${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-deals",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-deals",
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
    ...(init.headers as Record<string, string> | undefined),
    ...(token ? { Authorization: `Bearer ${token}` } : undefined),
  };
  return app.fetch(
    new Request(`https://example.com${path}`, { ...init, headers }),
    env
  );
}

describe("deals", () => {
  let organizationId = "";
  let token = "";
  let customerId = "";

  beforeAll(async () => {
    ({ organizationId, token } = await seedWorkspace());
    const res = await fetch(
      `/workspaces/${organizationId}/customers`,
      { method: "POST", body: JSON.stringify({ name: "Acme" }) },
      token
    );
    customerId = (await res.json()).id;
  });

  it("creates, lists, updates, and deletes deals", async () => {
    const create = await fetch(
      `/workspaces/${organizationId}/deals`,
      {
        method: "POST",
        body: JSON.stringify({
          customerId,
          name: "Acme renewal",
          stage: "qualified",
          amountCents: 120_000_00,
          currency: "USD",
        }),
      },
      token
    );
    expect(create.status).toBe(201);
    const { deal } = await create.json();
    expect(deal.stage).toBe("qualified");
    expect(deal.amountCents).toBe(12_000_000);
    expect(deal.contactIds).toEqual([]);

    const list = await fetch(
      `/workspaces/${organizationId}/deals?customerId=${customerId}`,
      {},
      token
    );
    const { deals } = await list.json();
    expect(deals.map((d: { id: string }) => d.id)).toContain(deal.id);

    const patch = await fetch(
      `/workspaces/${organizationId}/deals/${deal.id}`,
      { method: "PATCH", body: JSON.stringify({ stage: "won" }) },
      token
    );
    const updated = (await patch.json()).deal;
    expect(updated.stage).toBe("won");
    expect(updated.closedAt).toBeTruthy();

    const reopen = await fetch(
      `/workspaces/${organizationId}/deals/${deal.id}`,
      { method: "PATCH", body: JSON.stringify({ stage: "negotiation" }) },
      token
    );
    expect((await reopen.json()).deal.closedAt).toBeNull();

    const del = await fetch(
      `/workspaces/${organizationId}/deals/${deal.id}`,
      { method: "DELETE" },
      token
    );
    expect((await del.json()).ok).toBe(true);
    const gone = await fetch(
      `/workspaces/${organizationId}/deals/${deal.id}`,
      {},
      token
    );
    expect(gone.status).toBe(404);
  });

  it("links deals to contacts", async () => {
    const create = await fetch(
      `/workspaces/${organizationId}/deals`,
      {
        method: "POST",
        body: JSON.stringify({
          customerId,
          name: "Contact deal",
          stage: "lead",
          contactIds: ["contact-a", "contact-b"],
        }),
      },
      token
    );
    const { deal } = await create.json();
    expect(deal.contactIds.sort()).toEqual(["contact-a", "contact-b"]);

    const patch = await fetch(
      `/workspaces/${organizationId}/deals/${deal.id}`,
      { method: "PATCH", body: JSON.stringify({ contactIds: ["contact-c"] }) },
      token
    );
    expect((await patch.json()).deal.contactIds).toEqual(["contact-c"]);
  });
});
