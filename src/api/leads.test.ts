import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { MockAgentProvider } from "../agents/harness.js";
import { registerAgentProvider } from "../agents/index.js";
import { createD1 } from "../global/db.js";
import { apikey as apikeyTable, user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";

const ORIGIN = "https://your-domain.com";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-leads",
      name: "Leads User",
      email: "leads-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const headers = await createAdminHeaders(env, "user-leads");
  const workspace = await createWorkspace(db, env, headers, {
    name: "Leads test workspace",
    slug: `leads-${crypto.randomUUID()}`,
    key: `L${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-leads",
  });
  return workspace!.id;
}

async function createAdminTokenRecord(organizationId: string) {
  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-leads",
      name: "test-admin",
      metadata: { organizationId, permissions: "admin" },
    },
  });
  const parsed = z.object({ id: z.string(), key: z.string() }).parse(result);
  const db = createD1(env.D1);
  await db
    .update(apikeyTable)
    .set({ rateLimitEnabled: false })
    .where(eq(apikeyTable.id, parsed.id));
  return { token: parsed.key };
}

describe("public leads", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    organizationId = await seedWorkspace();
    token = (await createAdminTokenRecord(organizationId)).token;
  });

  function authed(path: string, init: RequestInit = {}) {
    return app.fetch(
      new Request(`${ORIGIN}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
      }),
      env
    );
  }

  // PILE-427 acceptance: a new lead from the website form is auto-delegated
  // to the pipeline agent named by its rule, and the evaluation log shows
  // which rule matched.
  it("auto-delegates a website-form lead to the rule's agent", async () => {
    const agentId = `mock-scout-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(agentId, () => new MockAgentProvider(agentId, {}));

    const ruleRes = await authed(`/workspaces/${organizationId}/triage/rules`, {
      method: "POST",
      body: JSON.stringify({
        name: "website leads to scout",
        recordType: "lead",
        conditions: { sources: ["form"] },
        action: { type: "delegate", agentId, status: "triage" },
      }),
    });
    expect(ruleRes.status).toBe(201);
    const { rule } = (await ruleRes.json()) as { rule: { id: string } };

    const leadRes = await app.fetch(
      new Request(`${ORIGIN}/public/leads/${organizationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "owner@acme-bakery.com",
          fullName: "Ava Owner",
          company: "Acme Bakery",
          dealName: "Acme Bakery",
          message: "asking about pricing",
          source: "form",
        }),
      }),
      env
    );
    expect(leadRes.status).toBe(201);
    const lead = (await leadRes.json()) as {
      customerId: string;
      dealId?: string;
    };
    expect(lead.customerId).toBeTruthy();
    expect(lead.dealId).toBeTruthy();

    // The delegate action materialized an issue for the lead, stamped the
    // agent as delegate, linked it to the deal, and dispatched a lane.
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.getIssue(`triage:lead:${lead.customerId}`);
    expect(issue).toBeTruthy();
    expect(issue!.delegateId).toBe(agentId);
    // Dispatch already moved the working issue into progress.
    expect(issue!.status).toBe("in_progress");
    const linkedIssueIds = await stub.listDealIssueIds(lead.dealId!);
    expect(linkedIssueIds).toContain(issue!.id);
    const sessions = await stub.listAgentSessions({ issueId: issue!.id });
    expect(sessions[0]?.agentId).toBe(agentId);

    // The evaluation log names the matching rule.
    const evalRes = await authed(
      `/workspaces/${organizationId}/triage/evaluations?recordType=lead&recordId=${lead.customerId}`
    );
    const evals = (await evalRes.json()) as {
      evaluations: {
        ruleId: string | null;
        ruleName: string | null;
        outcome: string;
      }[];
    };
    expect(evals.evaluations[0]?.outcome).toBe("matched");
    expect(evals.evaluations[0]?.ruleId).toBe(rule.id);
    expect(evals.evaluations[0]?.ruleName).toBe("website leads to scout");
  });

  it("logs no_match when no lead rule matches the source", async () => {
    const leadRes = await app.fetch(
      new Request(`${ORIGIN}/public/leads/${organizationId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "someone@other.com",
          source: "partner-api",
        }),
      }),
      env
    );
    expect(leadRes.status).toBe(201);
    const lead = (await leadRes.json()) as { customerId: string };

    const evalRes = await authed(
      `/workspaces/${organizationId}/triage/evaluations?recordId=${lead.customerId}`
    );
    const evals = (await evalRes.json()) as {
      evaluations: { ruleId: string | null; outcome: string }[];
    };
    expect(evals.evaluations[0]?.outcome).toBe("no_match");
    expect(evals.evaluations[0]?.ruleId).toBeNull();
  });
});
