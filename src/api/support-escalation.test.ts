import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import {
  apikey as apikeyTable,
  supportTickets,
  user as userTable,
} from "../global/schema.js";
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
      id: "user-1",
      name: "Test User",
      email: "user-1@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const headers = await createAdminHeaders(env, "user-1");
  const workspace = await createWorkspace(db, env, headers, {
    name: "Escalation test workspace",
    slug: `esc-test-${crypto.randomUUID()}`,
    key: `E${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-1",
  });

  return workspace!.id;
}

async function createAdminTokenRecord(organizationId: string) {
  const auth = createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-1",
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
  return { id: parsed.id, token: parsed.key };
}

describe("support-escalation API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    organizationId = await seedWorkspace();
    const record = await createAdminTokenRecord(organizationId);
    token = record.token;
  });

  function fetch(path: string, init: RequestInit = {}) {
    const request = new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    return app.fetch(request, env);
  }

  async function createCustomer(email: string) {
    const res = await fetch(`/workspaces/${organizationId}/support/customers`, {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { customer: { id: string } };
    return body.customer.id;
  }

  it("manages escalation rules", async () => {
    const create = await fetch(
      `/workspaces/${organizationId}/support/escalation-rules`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "bug from intercom",
          conditions: { keywords: ["bug"], channels: ["intercom"] },
          action: { type: "create_issue", status: "triage", priority: "high" },
        }),
      }
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { rule: { id: string } };

    const list = await fetch(
      `/workspaces/${organizationId}/support/escalation-rules`
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { rules: unknown[] };
    expect(listBody.rules.length).toBeGreaterThanOrEqual(1);

    const get = await fetch(
      `/workspaces/${organizationId}/support/escalation-rules/${created.rule.id}`
    );
    expect(get.status).toBe(200);

    const patch = await fetch(
      `/workspaces/${organizationId}/support/escalation-rules/${created.rule.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          conditions: { keywords: ["bug", "broken"], channels: ["intercom"] },
        }),
      }
    );
    expect(patch.status).toBe(200);

    const del = await fetch(
      `/workspaces/${organizationId}/support/escalation-rules/${created.rule.id}`,
      {
        method: "DELETE",
      }
    );
    expect(del.status).toBe(204);
  });

  it("creates an issue when a rule matches a new support ticket", async () => {
    const ruleRes = await fetch(
      `/workspaces/${organizationId}/support/escalation-rules`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "bug from api",
          conditions: { keywords: ["bug"], channels: ["api"] },
          action: { type: "create_issue", status: "triage", priority: "high" },
        }),
      }
    );
    expect(ruleRes.status).toBe(201);
    const customerId = await createCustomer("customer@example.com");

    const ticketRes = await fetch(
      `/workspaces/${organizationId}/support/tickets`,
      {
        method: "POST",
        body: JSON.stringify({
          customerId,
          title: "There is a bug in the app",
          sourceChannel: "api",
          message: {
            textContent: "The login button is broken",
            channel: "api",
          },
        }),
      }
    );
    expect(ticketRes.status).toBe(201);
    const ticketBody = (await ticketRes.json()) as {
      ticket: { id: string; issueId: string | null };
    };
    expect(ticketBody.ticket.issueId).toBeTruthy();

    const db = createD1(env.D1);
    const ticket = await db
      .select()
      .from(supportTickets)
      .where(eq(supportTickets.id, ticketBody.ticket.id))
      .get();
    expect(ticket?.issueId).toBe(ticketBody.ticket.issueId);
  });

  it("does not create an issue when no rule matches", async () => {
    const customerId = await createCustomer("customer2@example.com");

    const ticketRes = await fetch(
      `/workspaces/${organizationId}/support/tickets`,
      {
        method: "POST",
        body: JSON.stringify({
          customerId,
          title: "Just saying hello",
          sourceChannel: "api",
        }),
      }
    );
    expect(ticketRes.status).toBe(201);
    const ticketBody = (await ticketRes.json()) as {
      ticket: { issueId: string | null };
    };
    expect(ticketBody.ticket.issueId).toBeNull();
  });
});
