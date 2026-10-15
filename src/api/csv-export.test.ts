import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { MockAgentProvider } from "../agents/harness.js";
import { registerAgentProvider } from "../agents/index.js";
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
      id: "user-csv",
      name: "CSV User",
      email: "csv-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-csv");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "CSV test",
    slug: `csv-${crypto.randomUUID()}`,
    key: `C${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-csv",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-csv",
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

describe("csv export", () => {
  it("exports the delegateId column and filters by delegate (PILE-417)", async () => {
    const { organizationId, token } = await seedWorkspace();
    const agentId = `mock-csv-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(agentId, () => new MockAgentProvider(agentId));

    const createRes = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({
          title: "Delegated export",
          delegateId: agentId,
        }),
      },
      token
    );
    expect(createRes.status).toBe(201);
    const issue = z.object({ id: z.string() }).parse(await createRes.json());

    const exportRes = await fetch(
      `/workspaces/${organizationId}/csv-exports`,
      {
        method: "POST",
        body: JSON.stringify({ entityType: "issues", delegateId: agentId }),
      },
      token
    );
    expect(exportRes.status).toBe(200);
    const csv = await exportRes.text();
    const [header, ...rows] = csv.trim().split("\n");
    expect(header).toContain("delegateId");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(issue.id);
    expect(rows[0]).toContain(agentId);
  });
});
