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
      id: "user-triage",
      name: "Triage User",
      email: "triage-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const headers = await createAdminHeaders(env, "user-triage");
  const workspace = await createWorkspace(db, env, headers, {
    name: "Triage test workspace",
    slug: `triage-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-triage",
  });
  return workspace!.id;
}

async function createAdminTokenRecord(organizationId: string) {
  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-triage",
      name: "test-admin",
      metadata: { organizationId, permissions: "admin" },
      permissions: { workspace: ["admin"] },
    },
  });
  const parsed = z.object({ id: z.string(), key: z.string() }).parse(result);
  const db = createD1(env.D1);
  await db
    .update(apikeyTable)
    .set({ rateLimitEnabled: false })
    .where(eq(apikeyTable.id, parsed.id));
  return { id: parsed.id, token: parsed.key };
}

function getStub(organizationId: string) {
  return env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
}

describe("triage rules API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    organizationId = await seedWorkspace();
    token = (await createAdminTokenRecord(organizationId)).token;
  });

  function fetch(path: string, init: RequestInit = {}) {
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

  it("manages rules via the API", async () => {
    const create = await fetch(`/workspaces/${organizationId}/triage/rules`, {
      method: "POST",
      body: JSON.stringify({
        name: "web leads to scout",
        recordType: "lead",
        conditions: { sources: ["form"] },
        action: { type: "delegate", agentId: "scout" },
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      rule: { id: string; recordType: string };
    };
    expect(created.rule.recordType).toBe("lead");

    const list = await fetch(
      `/workspaces/${organizationId}/triage/rules?recordType=lead`
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { rules: { id: string }[] };
    expect(listBody.rules.some((r) => r.id === created.rule.id)).toBe(true);

    const patch = await fetch(
      `/workspaces/${organizationId}/triage/rules/${created.rule.id}`,
      { method: "PATCH", body: JSON.stringify({ sortOrder: 5 }) }
    );
    expect(patch.status).toBe(200);
    expect(
      ((await patch.json()) as { rule: { sortOrder: number } }).rule.sortOrder
    ).toBe(5);

    const del = await fetch(
      `/workspaces/${organizationId}/triage/rules/${created.rule.id}`,
      { method: "DELETE" }
    );
    expect(del.status).toBe(204);
    const gone = await fetch(
      `/workspaces/${organizationId}/triage/rules/${created.rule.id}`
    );
    expect(gone.status).toBe(404);
  });

  it("delegates an issue on match and logs the evaluation", async () => {
    const agentId = `mock-triage-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(agentId, () => new MockAgentProvider(agentId, {}));
    const ruleRes = await fetch(`/workspaces/${organizationId}/triage/rules`, {
      method: "POST",
      body: JSON.stringify({
        name: "urgent issues to agent",
        recordType: "issue",
        conditions: { priorities: ["urgent"] },
        action: { type: "delegate", agentId, status: "in_progress" },
      }),
    });
    expect(ruleRes.status).toBe(201);
    const { rule } = (await ruleRes.json()) as { rule: { id: string } };

    const issueRes = await fetch(`/workspaces/${organizationId}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "urgent outage", priority: "urgent" }),
    });
    expect(issueRes.status).toBe(201);
    const issue = (await issueRes.json()) as {
      id: string;
      delegateId: string | null;
      status: string;
    };
    expect(issue.delegateId).toBe(agentId);
    expect(issue.status).toBe("in_progress");

    const evalRes = await fetch(
      `/workspaces/${organizationId}/triage/evaluations?recordId=${issue.id}`
    );
    const evals = (await evalRes.json()) as {
      evaluations: {
        ruleId: string | null;
        ruleName: string | null;
        outcome: string;
        detail: { issueId?: string; sessionId?: string } | null;
      }[];
    };
    expect(evals.evaluations).toHaveLength(1);
    const entry = evals.evaluations[0]!;
    expect(entry.outcome).toBe("matched");
    expect(entry.ruleId).toBe(rule.id);
    expect(entry.detail?.issueId).toBe(issue.id);
    expect(entry.detail?.sessionId).toBeTruthy();
  });

  it("logs no_match when a record matches no rule", async () => {
    const issueRes = await fetch(`/workspaces/${organizationId}/issues`, {
      method: "POST",
      body: JSON.stringify({ title: "routine issue", priority: "low" }),
    });
    expect(issueRes.status).toBe(201);
    const issue = (await issueRes.json()) as { id: string };

    const evalRes = await fetch(
      `/workspaces/${organizationId}/triage/evaluations?recordType=issue&recordId=${issue.id}`
    );
    const evals = (await evalRes.json()) as {
      evaluations: { ruleId: string | null; outcome: string }[];
    };
    expect(evals.evaluations[0]?.outcome).toBe("no_match");
    expect(evals.evaluations[0]?.ruleId).toBeNull();
  });

  it("first matching rule wins by sortOrder", async () => {
    const first = await fetch(`/workspaces/${organizationId}/triage/rules`, {
      method: "POST",
      body: JSON.stringify({
        name: "first match",
        recordType: "deal",
        sortOrder: 0,
        conditions: {},
        action: { type: "set_status", status: "qualified" },
      }),
    });
    const second = await fetch(`/workspaces/${organizationId}/triage/rules`, {
      method: "POST",
      body: JSON.stringify({
        name: "second match",
        recordType: "deal",
        sortOrder: 1,
        conditions: {},
        action: { type: "set_status", status: "won" },
      }),
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstRule = (await first.json()) as { rule: { id: string } };

    const customerRes = await fetch(
      `/workspaces/${organizationId}/support/customers`,
      { method: "POST", body: JSON.stringify({ email: "first-match@x.com" }) }
    );
    const { customer } = (await customerRes.json()) as {
      customer: { id: string };
    };
    const dealRes = await fetch(`/workspaces/${organizationId}/deals`, {
      method: "POST",
      body: JSON.stringify({ customerId: customer.id, name: "First deal" }),
    });
    expect(dealRes.status).toBe(201);
    const { deal } = (await dealRes.json()) as {
      deal: { id: string; stage: string };
    };
    expect(deal.stage).toBe("qualified");

    const evalRes = await fetch(
      `/workspaces/${organizationId}/triage/evaluations?recordId=${deal.id}`
    );
    const evals = (await evalRes.json()) as {
      evaluations: { ruleId: string | null; outcome: string }[];
    };
    expect(evals.evaluations[0]?.ruleId).toBe(firstRule.rule.id);
    expect(evals.evaluations[0]?.outcome).toBe("matched");

    const stub = getStub(organizationId);
    await stub.setOrganizationId(organizationId);
    await stub.deleteTriageRule(firstRule.rule.id, {});
    expect(evals.evaluations[0]?.ruleId).toBe(firstRule.rule.id);
  });
});
