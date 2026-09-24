import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

env.WEBHOOK_QUEUE = null as unknown as typeof env.WEBHOOK_QUEUE;

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

async function seedWorkspace(id: string) {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id,
      name: "Tenancy User",
      email: `${id}@example.com`,
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, id);
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: `Tenancy ${id}`,
    slug: `tenancy-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: id,
  });

  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: id,
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return {
    organizationId: workspace!.id,
    slug: workspace!.slug,
    token: parsed.key,
  };
}

function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`https://example.com${path}`, init);
  return app.fetch(request, env) as Promise<Response>;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const json = (token: string) => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

// Workspace A's resources that workspace B must never reach.

async function seedA() {
  const a = await seedWorkspace("user-tenancy-a");

  const contactRes = await apiFetch(
    `/workspaces/${a.organizationId}/support/customers`,
    {
      method: "POST",
      headers: json(a.token),
      body: JSON.stringify({ email: "customer@a.example.com" }),
    }
  );
  expect(contactRes.status).toBe(201);
  const { customer } = z
    .object({ customer: z.object({ id: z.string() }) })
    .parse(await contactRes.json());

  const ticketRes = await apiFetch(
    `/workspaces/${a.organizationId}/support/tickets`,
    {
      method: "POST",
      headers: json(a.token),
      body: JSON.stringify({
        customerId: customer.id,
        title: "A private ticket",
        sourceChannel: "api",
      }),
    }
  );
  expect(ticketRes.status).toBe(201);
  const { ticket } = z
    .object({ ticket: z.object({ id: z.string() }) })
    .parse(await ticketRes.json());

  const widgetRes = await apiFetch(
    `/workspaces/${a.organizationId}/support/widget-keys`,
    {
      method: "POST",
      headers: json(a.token),
      body: JSON.stringify({ name: "A widget" }),
    }
  );
  const { id: widgetKeyId } = z
    .object({ id: z.string() })
    .parse(await widgetRes.json());

  const pubKeyRes = await apiFetch(
    `/workspaces/${a.organizationId}/support/capture/public-keys`,
    {
      method: "POST",
      headers: json(a.token),
      body: JSON.stringify({ name: "A key" }),
    }
  );
  const pubKey = z
    .object({ id: z.string() })
    .or(z.object({ publicKey: z.object({ id: z.string() }) }))
    .parse(await pubKeyRes.json());
  const publicKeyId = "id" in pubKey ? pubKey.id : pubKey.publicKey.id;

  const linkRes = await apiFetch(
    `/workspaces/${a.organizationId}/support/capture-links`,
    {
      method: "POST",
      headers: json(a.token),
      body: JSON.stringify({ publicKeyId, name: "A link" }),
    }
  );
  const linkParsed = z
    .object({ id: z.string() })
    .or(z.object({ link: z.object({ id: z.string() }) }))
    .parse(await linkRes.json());
  const captureLinkId = "id" in linkParsed ? linkParsed.id : linkParsed.link.id;

  await apiFetch(`/workspaces/${a.organizationId}/agent-context`, {
    method: "PUT",
    headers: json(a.token),
    body: JSON.stringify({ agentsMd: "# A secret notes" }),
  });

  const teamsRes = await apiFetch(`/workspaces/${a.organizationId}/teams`, {
    headers: bearer(a.token),
  });
  const teams = z
    .object({ teams: z.array(z.object({ id: z.string() })) })
    .or(z.array(z.object({ id: z.string() })))
    .parse(await teamsRes.json());
  const teamId = Array.isArray(teams) ? teams[0].id : teams.teams[0].id;

  const issueRes = await apiFetch(`/workspaces/${a.organizationId}/issues`, {
    method: "POST",
    headers: json(a.token),
    body: JSON.stringify({ title: "A private issue", teamId }),
  });
  expect(issueRes.status).toBe(201);
  const issue = z
    .object({ id: z.string() })
    .or(z.object({ issue: z.object({ id: z.string() }) }))
    .parse(await issueRes.json());
  const issueId = "id" in issue ? issue.id : issue.issue.id;

  return { ...a, ticketId: ticket.id, widgetKeyId, captureLinkId, issueId };
}

describe("cross-tenant isolation", () => {
  it("B's token gets 403 on every /workspaces/A/* path", async () => {
    const a = await seedA();
    const b = await seedWorkspace("user-tenancy-b");

    const paths = [
      `/workspaces/${a.organizationId}/issues`,
      `/workspaces/${a.organizationId}/issues/${a.issueId}`,
      `/workspaces/${a.organizationId}/support/tickets`,
      `/workspaces/${a.organizationId}/support/tickets/${a.ticketId}`,
      `/workspaces/${a.organizationId}/support/tickets/${a.ticketId}/artifacts`,
      `/workspaces/${a.organizationId}/support/widget-keys`,
      `/workspaces/${a.organizationId}/support/capture-links`,
      `/workspaces/${a.organizationId}/agent-context`,
      `/workspaces/${a.organizationId}/agent-context/rules`,
      `/workspaces/${a.organizationId}/agent-context/skills`,
      `/workspaces/${a.organizationId}/teams`,
      `/workspaces/${a.organizationId}/support/customers`,
    ];

    for (const path of paths) {
      const res = await apiFetch(path, { headers: bearer(b.token) });
      expect([401, 403], `B token must not read ${path}`).toContain(res.status);
    }
  });

  it("A's resource ids return 404 when queried through B's own org scope", async () => {
    const a = await seedA();
    const b = await seedWorkspace("user-tenancy-b2");

    // Middleware lets B through (it is B's org) — the queries must still
    // scope by organizationId or they leak.
    const probes = [
      `/workspaces/${b.organizationId}/issues/${a.issueId}`,
      `/workspaces/${b.organizationId}/support/tickets/${a.ticketId}`,
      `/workspaces/${b.organizationId}/support/tickets/${a.ticketId}/artifacts`,
      `/workspaces/${b.organizationId}/support/widget-keys/${a.widgetKeyId}`,
    ];

    for (const path of probes) {
      const res = await apiFetch(path, { headers: bearer(b.token) });
      expect(
        [403, 404],
        `A's resource id under B's org must not resolve: ${path} -> ${res.status}`
      ).toContain(res.status);
    }
  });

  it("B sees none of A's rows in list endpoints under B's own org", async () => {
    const a = await seedA();
    const b = await seedWorkspace("user-tenancy-b3");

    const tickets = await apiFetch(
      `/workspaces/${b.organizationId}/support/tickets`,
      { headers: bearer(b.token) }
    );
    const ticketBody = z
      .object({ tickets: z.array(z.object({ id: z.string() })) })
      .parse(await tickets.json());
    expect(ticketBody.tickets.map((t) => t.id)).not.toContain(a.ticketId);

    const widgetKeys = await apiFetch(
      `/workspaces/${b.organizationId}/support/widget-keys`,
      { headers: bearer(b.token) }
    );
    const keysBody = z
      .object({ widgetKeys: z.array(z.object({ id: z.string() })) })
      .parse(await widgetKeys.json());
    expect(keysBody.widgetKeys.map((k) => k.id)).not.toContain(a.widgetKeyId);

    const ctx = await apiFetch(
      `/workspaces/${b.organizationId}/agent-context`,
      { headers: bearer(b.token) }
    );
    const ctxBody = z.object({ agentsMd: z.string() }).parse(await ctx.json());
    expect(ctxBody.agentsMd).not.toContain("A secret notes");
  });

  it("anonymous callers get 401 on workspace-scoped routes", async () => {
    const a = await seedA();

    const paths = [
      `/workspaces/${a.organizationId}/issues`,
      `/workspaces/${a.organizationId}/support/tickets`,
      `/workspaces/${a.organizationId}/support/tickets/${a.ticketId}`,
      `/workspaces/${a.organizationId}/agent-context`,
      `/workspaces/${a.organizationId}/support/widget-keys`,
    ];

    for (const path of paths) {
      const res = await apiFetch(path);
      expect(res.status, `anon must not read ${path}`).toBe(401);
    }
  });

  it("workspace metadata routes do not leak workspace internals anonymously", async () => {
    const a = await seedA();

    const byId = await apiFetch(`/workspaces/${a.organizationId}`);
    const bySlug = await apiFetch(`/workspaces/slug/${a.slug}`);
    console.log(
      `anon GET /workspaces/{id} -> ${byId.status}; /workspaces/slug/{slug} -> ${bySlug.status}`
    );

    // These routes sit outside the org-scoped middleware glob. If they
    // currently answer anonymously they only expose name/slug — but we pin
    // the behavior so it cannot silently widen.
    for (const res of [byId, bySlug]) {
      if (res.status === 200) {
        const body = (await res.json()) as Record<string, unknown>;
        expect(body).not.toHaveProperty("ownerId");
        expect(body).not.toHaveProperty("key");
        expect(body).not.toHaveProperty("members");
        expect(body).not.toHaveProperty("apiKeys");
      }
    }
  });
});
