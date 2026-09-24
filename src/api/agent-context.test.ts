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
      name: "Context User",
      email: `${id}@example.com`,
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, id);
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Agent context test",
    slug: `agent-context-${crypto.randomUUID()}`,
    key: `A${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
  return { organizationId: workspace!.id, token: parsed.key };
}

function ctxFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`https://example.com${path}`, init);
  return app.fetch(request, env) as Promise<Response>;
}

const contextSchema = z.object({
  organizationId: z.string(),
  agentsMd: z.string(),
  rules: z.array(z.object({ name: z.string(), content: z.string() })),
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      content: z.string(),
    })
  ),
  updatedAt: z.string(),
});

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("workspace agent context", () => {
  it("serves the default AGENTS.md after workspace creation", async () => {
    const { organizationId, token } = await seedWorkspace("user-ctx-default");
    const res = await ctxFetch(
      `/workspaces/${organizationId}/agent-context`,
      { headers: auth(token) }
    );
    expect(res.status).toBe(200);
    const ctx = contextSchema.parse(await res.json());
    expect(ctx.agentsMd).toContain("Agent operating notes");
    expect(ctx.agentsMd).toContain("artifacts");
    expect(ctx.rules).toHaveLength(0);
    expect(ctx.skills).toHaveLength(0);
  });

  it("gets and puts context", async () => {
    const { organizationId, token } = await seedWorkspace("user-ctx-put");
    const put = await ctxFetch(
      `/workspaces/${organizationId}/agent-context`,
      {
        method: "PUT",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({
          agentsMd: "# Custom rules\n\nUse pnpm.",
          rules: [{ name: "pnpm-only", content: "Use pnpm only." }],
          skills: [
            {
              name: "triage",
              description: "Triage tickets",
              content: "---\nname: triage\n---\nTriage.",
            },
          ],
        }),
      }
    );
    expect(put.status).toBe(200);
    const ctx = contextSchema.parse(await put.json());
    expect(ctx.agentsMd).toBe("# Custom rules\n\nUse pnpm.");
    expect(ctx.rules[0].name).toBe("pnpm-only");
    expect(ctx.skills[0].name).toBe("triage");

    const get = await ctxFetch(
      `/workspaces/${organizationId}/agent-context`,
      { headers: auth(token) }
    );
    expect(contextSchema.parse(await get.json()).skills).toHaveLength(1);
  });

  it("serves rules and skills subroutes", async () => {
    const { organizationId, token } = await seedWorkspace("user-ctx-sub");
    await ctxFetch(`/workspaces/${organizationId}/agent-context`, {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({
        rules: [{ name: "r1", content: "rule one" }],
        skills: [{ name: "s1", description: "", content: "skill one" }],
      }),
    });

    const rules = await ctxFetch(
      `/workspaces/${organizationId}/agent-context/rules`,
      { headers: auth(token) }
    );
    expect(
      z
        .object({ rules: z.array(z.object({ name: z.string() })) })
        .parse(await rules.json())
        .rules.map((r) => r.name)
    ).toEqual(["r1"]);

    const skills = await ctxFetch(
      `/workspaces/${organizationId}/agent-context/skills`,
      { headers: auth(token) }
    );
    expect(
      z
        .object({ skills: z.array(z.object({ name: z.string() })) })
        .parse(await skills.json())
        .skills.map((s) => s.name)
    ).toEqual(["s1"]);
  });

  it("rejects unauthenticated and cross-workspace reads", async () => {
    const { organizationId } = await seedWorkspace("user-ctx-owner");
    const anon = await ctxFetch(`/workspaces/${organizationId}/agent-context`);
    expect(anon.status).toBe(401);

    const other = await seedWorkspace("user-ctx-other");
    const cross = await ctxFetch(
      `/workspaces/${organizationId}/agent-context`,
      { headers: auth(other.token) }
    );
    expect([401, 403, 404]).toContain(cross.status);
  });

  it("rejects invalid payloads", async () => {
    const { organizationId, token } = await seedWorkspace("user-ctx-bad");
    const res = await ctxFetch(
      `/workspaces/${organizationId}/agent-context`,
      {
        method: "PUT",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify({ rules: [{ name: "", content: "x" }] }),
      }
    );
    expect(res.status).toBe(400);
  });
});
