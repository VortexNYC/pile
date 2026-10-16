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
      id: "user-links",
      name: "Links User",
      email: "links-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-links");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Links test",
    slug: `links-${crypto.randomUUID()}`,
    key: `L${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-links",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-links",
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

const linkSchema = z.object({
  id: z.string(),
  fromType: z.string(),
  fromId: z.string(),
  toType: z.string(),
  toId: z.string(),
  kind: z.string(),
});

describe("entity links API (PILE-429)", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  async function createIssue(title: string) {
    const res = await fetch(
      `/workspaces/${organizationId}/issues`,
      { method: "POST", body: JSON.stringify({ title }) },
      token
    );
    expect(res.status).toBe(201);
    return z.object({ id: z.string() }).parse(await res.json());
  }

  it("persists the kind as sent and returns it on list", async () => {
    const from = await createIssue("Link source");
    const to = await createIssue("Link target");

    const res = await fetch(
      `/workspaces/${organizationId}/entities/issue/${from.id}/links`,
      {
        method: "POST",
        body: JSON.stringify({
          toType: "issue",
          toId: to.id,
          kind: "blocks",
        }),
      },
      token
    );
    expect(res.status).toBe(201);
    const created = z.object({ link: linkSchema }).parse(await res.json());
    expect(created.link.kind).toBe("blocks");
    expect(created.link.toId).toBe(to.id);

    const list = await fetch(
      `/workspaces/${organizationId}/entities/issue/${to.id}/links`,
      {},
      token
    );
    expect(list.status).toBe(200);
    const links = z
      .object({ links: z.array(linkSchema) })
      .parse(await list.json());
    expect(links.links.find((l) => l.id === created.link.id)?.kind).toBe(
      "blocks"
    );
  });

  it("rejects mis-keyed link payloads with a 400 instead of silently defaulting kind", async () => {
    const from = await createIssue("Strict source");
    const to = await createIssue("Strict target");

    // The PILE-429 bug — `linkType` used to be dropped and `kind`
    // silently defaulted to "relates".
    const miskeyed = await fetch(
      `/workspaces/${organizationId}/entities/issue/${from.id}/links`,
      {
        method: "POST",
        body: JSON.stringify({
          toType: "issue",
          toId: to.id,
          linkType: "blocks",
        }),
      },
      token
    );
    expect(miskeyed.status).toBe(400);

    // The field names the old docs advertised.
    const docFieldNames = await fetch(
      `/workspaces/${organizationId}/entities/issue/${from.id}/links`,
      {
        method: "POST",
        body: JSON.stringify({
          targetEntityType: "issue",
          targetEntityId: to.id,
        }),
      },
      token
    );
    expect(docFieldNames.status).toBe(400);
  });
});
