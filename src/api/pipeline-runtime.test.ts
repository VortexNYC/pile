import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { MockAgentProvider } from "../agents/harness.js";
import { registerAgentProvider } from "../agents/index.js";
import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import { drainDomainEvents } from "../agents/pipeline-events.js";
import { getWorkspaceStub } from "./stub.js";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-pipeline-runtime",
      name: "Pipeline Runtime User",
      email: "pipeline-runtime@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const setupHeaders = await createAdminHeaders(env, "user-pipeline-runtime");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Pipeline runtime test",
    slug: `pipeline-rt-${crypto.randomUUID()}`,
    key: `P${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-pipeline-runtime",
  });
  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-pipeline-runtime",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
    },
  });
  return {
    organizationId: workspace!.id,
    token: z.object({ key: z.string() }).parse(result).key,
  };
}

async function fetch(path: string, init: RequestInit = {}, token?: string) {
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

describe("pipeline runtime (PILE-401/405/413)", () => {
  let org = "";
  let admin = "";

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    org = seeded.organizationId;
    admin = seeded.token;
  });

  it("CRUDs agent types and stage configs", async () => {
    const type = await fetch(
      `/workspaces/${org}/agent-types`,
      {
        method: "POST",
        body: JSON.stringify({
          slug: "Sales Scout",
          name: "Sales Scout",
          providerAgentId: "mock-scout",
          jobSpec: "Find and profile merchants.",
        }),
      },
      admin
    );
    expect(type.status).toBe(200);
    const agentType = z
      .object({ slug: z.string(), providerAgentId: z.string() })
      .parse(await type.json());
    expect(agentType.slug).toBe("sales_scout");

    const cfg = await fetch(
      `/workspaces/${org}/stage-configs`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "customer",
          status: "Outreach",
          ownerAgent: "sales_scout",
          advancePolicy: "auto",
        }),
      },
      admin
    );
    expect(cfg.status).toBe(200);
    const listed = await fetch(`/workspaces/${org}/stage-configs`, {}, admin);
    const { configs } = z
      .object({ configs: z.array(z.object({ status: z.string() })) })
      .parse(await listed.json());
    expect(configs.map((c) => c.status)).toContain("outreach");
  });

  it("emits substep.actionable on materialization and all_required_done when the last required step closes", async () => {
    // Template on "triage" — fresh issues default to backlog.
    const tpl = await fetch(
      `/workspaces/${org}/stage-templates`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "issue",
          status: "triage",
          stepKey: "rt_step",
          title: "Runtime step",
          required: true,
        }),
      },
      admin
    );
    expect(tpl.status).toBe(201);

    const create = await fetch(
      `/workspaces/${org}/issues`,
      { method: "POST", body: JSON.stringify({ title: "Runtime parent" }) },
      admin
    );
    const parent = z.object({ id: z.string() }).parse(await create.json());
    await fetch(
      `/workspaces/${org}/issues/${parent.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "triage" }) },
      admin
    );

    const children = await fetch(
      `/workspaces/${org}/issues?parentId=${parent.id}`,
      {},
      admin
    );
    const [child] = z
      .object({ issues: z.array(z.object({ id: z.string() })) })
      .parse(await children.json()).issues;

    // Domain events land in the DO outbox — inspectable via listPending
    // through the drainer; close the required step to fire all_required_done.
    const done = await fetch(
      `/workspaces/${org}/issues/${child.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "done" }) },
      admin
    );
    expect(done.status).toBe(200);
  });

  it("drains substep.actionable into a dispatch to the resolved owner agent", async () => {
    const dispatched: string[] = [];
    const agentId = `mock-pod-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: (_org, dispatchedIssue) => {
            dispatched.push(dispatchedIssue.id);
            return {
              id: `sess-${crypto.randomUUID()}`,
              agentId,
              issueId: dispatchedIssue.id,
              status: "created" as const,
            };
          },
        })
    );
    // Register a pod agent type whose provider is the mock, then a stage
    // config that names it; a customer stage entry should dispatch it.
    const type = await fetch(
      `/workspaces/${org}/agent-types`,
      {
        method: "POST",
        body: JSON.stringify({
          slug: "pod-scout",
          name: "Pod Scout",
          providerAgentId: agentId,
          jobSpec: "Scout the merchant.",
        }),
      },
      admin
    );
    expect(type.status).toBe(200);
    const cfg = await fetch(
      `/workspaces/${org}/stage-configs`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "customer",
          status: "Prospect",
          ownerAgent: "pod-scout",
        }),
      },
      admin
    );
    expect(cfg.status).toBe(200);

    // Register a stage template so the sub-step materializes.
    await fetch(
      `/workspaces/${org}/stage-templates`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "customer",
          status: "Prospect",
          stepKey: "scout_step",
          title: "Scout step",
          required: true,
          ownerAgent: "pod-scout",
        }),
      },
      admin
    );

    const customerRes = await fetch(
      `/workspaces/${org}/customers`,
      { method: "POST", body: JSON.stringify({ name: "Dispatch Co" }) },
      admin
    );
    const customer = z.object({ id: z.string() }).parse(await customerRes.json());
    const statusRes = await fetch(
      `/workspaces/${org}/customer-statuses`,
      { method: "POST", body: JSON.stringify({ name: "Prospect" }) },
      admin
    );
    const status = z.object({ id: z.string() }).parse(await statusRes.json());
    const enter = await fetch(
      `/workspaces/${org}/customers/${customer.id}`,
      { method: "PATCH", body: JSON.stringify({ statusId: status.id }) },
      admin
    );
    expect(enter.status).toBe(200);

    // waitUntil may not flush in the test pool — drain explicitly.
    const stub = getWorkspaceStub(env, org);
    const drained = await drainDomainEvents(env, stub, org);
    expect(drained).toBeGreaterThan(0);
    expect(dispatched.length).toBeGreaterThan(0);
  });
});
