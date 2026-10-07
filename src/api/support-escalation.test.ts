import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { MockAgentProvider } from "../agents/harness.js";
import { registerAgentProvider } from "../agents/index.js";
import { createD1 } from "../global/db.js";
import {
  apikey as apikeyTable,
  supportChannels,
  supportTicketEvents,
  supportTicketMessages,
  supportTickets,
  user as userTable,
} from "../global/schema.js";
import { getCustomerById } from "../global/support-contacts.js";
import { replyLaneResultToTicket } from "../global/support-escalation.js";
import { maybeEscalate } from "../global/support-escalation.js";
import { createTicket, getTicketById } from "../global/support-tickets.js";
import { createTeam } from "../global/teams.js";
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
  const auth = await createAuth(env);
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

  it("creates only one escalated issue under concurrent escalation calls", async () => {
    const db = createD1(env.D1);
    const ruleRes = await fetch(
      `/workspaces/${organizationId}/support/escalation-rules`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "concurrent bug",
          conditions: { keywords: ["bug"], channels: ["api"] },
          action: { type: "create_issue", status: "triage", priority: "high" },
        }),
      }
    );
    expect(ruleRes.status).toBe(201);

    const customerId = await createCustomer("concurrent@example.com");
    const customer = await getCustomerById(db, organizationId, customerId);

    const ticket = await createTicket(db, {
      organizationId,
      customerId,
      title: "bug in login",
      sourceChannel: "api",
      priority: "high",
      status: "todo",
      externalSource: "api",
    });

    const ctx = {
      text: "Login is broken",
      customer,
      source: "api" as const,
      channel: "api" as const,
    };

    const [first, second] = await Promise.all([
      maybeEscalate(env, db, organizationId, ticket, ctx),
      maybeEscalate(env, db, organizationId, ticket, ctx),
    ]);

    expect(first?.id).toBeTruthy();
    expect(second?.id).toBe(first?.id);

    const refreshed = await getTicketById(db, organizationId, ticket.id);
    expect(refreshed?.issueId).toBe(first?.id);

    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issues = await stub.listIssues({});
    expect(issues.filter((i) => i.title === ticket.title)).toHaveLength(1);

    const linkEvents = await db
      .select()
      .from(supportTicketEvents)
      .where(eq(supportTicketEvents.ticketId, ticket.id))
      .all();
    expect(linkEvents.filter((e) => e.type === "link_added")).toHaveLength(1);
  });

  it("dispatches a lane when the rule action names an agentId", async () => {
    const db = createD1(env.D1);
    const agentId = `mock-esc-${crypto.randomUUID().slice(0, 8)}`;
    registerAgentProvider(agentId, () => new MockAgentProvider(agentId, {}));
    const ruleRes = await fetch(
      `/workspaces/${organizationId}/support/escalation-rules`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "dispatch lane on escalate",
          conditions: { keywords: ["crash"], channels: ["api"] },
          action: {
            type: "create_issue",
            agentId,
            repo: "VortexNYC/pile",
          },
        }),
      }
    );
    expect(ruleRes.status).toBe(201);

    const customerId = await createCustomer("lane@example.com");
    const ticketRes = await fetch(
      `/workspaces/${organizationId}/support/tickets`,
      {
        method: "POST",
        body: JSON.stringify({
          customerId,
          title: "app crash on save",
          sourceChannel: "api",
          message: { textContent: "crash", channel: "api" },
        }),
      }
    );
    const ticketBody = (await ticketRes.json()) as {
      ticket: { id: string; issueId: string | null };
    };
    expect(ticketBody.ticket.issueId).toBeTruthy();

    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.getIssue(ticketBody.ticket.issueId!);
    expect(issue?.repo).toBe("VortexNYC/pile");
    const sessions = await stub.listAgentSessions({
      issueId: issue!.id,
    });
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions[0]?.agentId).toBe(agentId);
    void db;
  });

  // PILE-321 — a rule that binds a team but names no repo still produces a
  // repo-backed lane via the team's defaultRepo.
  it("applies the team's defaultRepo when the rule action sets only a teamId", async () => {
    const db = createD1(env.D1);
    const team = await createTeam(db, env, new Headers(), {
      organizationId,
      key: `ED${crypto.randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      name: "Escalation default",
      ownerId: "user-1",
      defaultRepo: "VortexNYC/esc-default",
    });
    const agentId = `mock-esc-${crypto.randomUUID().slice(0, 8)}`;
    let seenRepo: string | null | undefined;
    registerAgentProvider(
      agentId,
      () =>
        new MockAgentProvider(agentId, {
          dispatch: (_org, dispatchedIssue) => {
            seenRepo = dispatchedIssue.repo;
            return {
              id: `esc-${crypto.randomUUID()}`,
              agentId,
              issueId: dispatchedIssue.id,
              status: "created" as const,
            };
          },
        })
    );
    const ruleRes = await fetch(
      `/workspaces/${organizationId}/support/escalation-rules`,
      {
        method: "POST",
        body: JSON.stringify({
          name: "escalate via team default",
          conditions: { keywords: ["panic"], channels: ["api"] },
          action: { type: "create_issue", agentId, teamId: team.id },
        }),
      }
    );
    expect(ruleRes.status).toBe(201);

    const customerId = await createCustomer("defaulted@example.com");
    const ticketRes = await fetch(
      `/workspaces/${organizationId}/support/tickets`,
      {
        method: "POST",
        body: JSON.stringify({
          customerId,
          title: "panic on checkout",
          sourceChannel: "api",
          message: { textContent: "panic", channel: "api" },
        }),
      }
    );
    const ticketBody = (await ticketRes.json()) as {
      ticket: { issueId: string | null };
    };
    expect(ticketBody.ticket.issueId).toBeTruthy();

    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const issue = await stub.getIssue(ticketBody.ticket.issueId!);
    expect(issue?.repo).toBe("VortexNYC/esc-default");
    const sessions = await stub.listAgentSessions({ issueId: issue!.id });
    expect(sessions[0]?.agentId).toBe(agentId);
    expect(seenRepo).toBe("VortexNYC/esc-default");
    void db;
  });

  it("posts the lane result back to the escalated ticket thread once", async () => {
    const db = createD1(env.D1);
    const customerId = await createCustomer("reply@example.com");
    await db.insert(supportChannels).values({
      id: crypto.randomUUID(),
      organizationId,
      type: "api",
      name: "api-channel",
      isActive: true,
      config: "{}",
    });
    const ticket = await createTicket(db, {
      organizationId,
      customerId,
      title: "reply ticket",
      sourceChannel: "api",
      priority: "medium",
      status: "todo",
      externalSource: "api",
    });
    const sessionId = crypto.randomUUID();
    const issueId = `escalation:${ticket.id}`;
    await db
      .update(supportTickets)
      .set({ issueId })
      .where(eq(supportTickets.id, ticket.id));

    await replyLaneResultToTicket(
      env,
      db,
      organizationId,
      issueId,
      sessionId,
      "Fixed in commit abc123"
    );

    const ticketMessages = () =>
      db
        .select()
        .from(supportTicketMessages)
        .innerJoin(
          supportTicketEvents,
          eq(supportTicketMessages.eventId, supportTicketEvents.id)
        )
        .where(eq(supportTicketEvents.ticketId, ticket.id))
        .all();

    const messages = await ticketMessages();
    const outbound = messages.filter(
      (m) =>
        m.support_ticket_messages.direction === "outbound" &&
        m.support_ticket_messages.textContent === "Fixed in commit abc123"
    );
    expect(outbound).toHaveLength(1);

    // Idempotent — a second terminal signal for the same session
    // must not double-post.
    await replyLaneResultToTicket(
      env,
      db,
      organizationId,
      issueId,
      sessionId,
      "Fixed in commit abc123"
    );
    const after = await ticketMessages();
    expect(
      after.filter(
        (m) =>
          m.support_ticket_messages.direction === "outbound" &&
          m.support_ticket_messages.textContent === "Fixed in commit abc123"
      )
    ).toHaveLength(1);
  });
});
