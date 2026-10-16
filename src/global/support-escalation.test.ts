import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createAdminHeaders } from "../platform/test-auth.js";
import { createD1 } from "./db.js";
import {
  supportTickets as supportTicketsTable,
  user as userTable,
} from "./schema.js";
import { createCustomer } from "./support-contacts.js";
import {
  createEscalationRule,
  type EscalationAction,
  maybeEscalate,
} from "./support-escalation.js";
import { createTicket } from "./support-tickets.js";
import { createTeam } from "./teams.js";
import { createWorkspace } from "./workspaces.js";

// PILE-321 — an escalation rule that binds a team but names no repo still
// produces a repo-backed issue via the team's defaultRepo, so a dispatched
// lane clones a repo instead of returning a spec-only package.

const ownerId = "user-esc-global";
let organizationId = "";
let defaultedTeamId = "";
const teamRepo = "VortexNYC/esc-team-default";

beforeAll(async () => {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: ownerId,
      name: "Escalation Global",
      email: `${ownerId}@example.com`,
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });
  const headers = await createAdminHeaders(env, ownerId);
  const workspace = await createWorkspace(db, env, headers, {
    name: "Escalation global",
    slug: `esc-global-${crypto.randomUUID()}`,
    ownerId,
  });
  organizationId = workspace!.id;
  const team = await createTeam(db, env, new Headers(), {
    organizationId,
    key: "ESG",
    name: "Escalation global team",
    ownerId,
    defaultRepo: teamRepo,
  });
  defaultedTeamId = team.id;
});

async function escalate(keyword: string, action: EscalationAction) {
  const db = createD1(env.D1);
  await createEscalationRule(db, {
    organizationId,
    name: `rule-${crypto.randomUUID()}`,
    // A unique keyword per test keeps earlier rules from matching first.
    conditions: { keywords: [keyword] },
    action,
  });
  const customer = await createCustomer(db, {
    organizationId,
    email: `${crypto.randomUUID()}@example.com`,
  });
  const ticket = await createTicket(db, {
    organizationId,
    customerId: customer.id,
    title: "customer report",
    sourceChannel: "api",
    status: "todo",
    externalSource: "api",
  });
  return maybeEscalate(env, db, organizationId, ticket, {
    text: keyword,
    channel: "api",
  });
}

describe("maybeEscalate team defaultRepo (PILE-321)", () => {
  it("fills a missing action repo from the team's defaultRepo", async () => {
    const issue = await escalate("panic-alpha", {
      type: "create_issue",
      teamId: defaultedTeamId,
    });
    expect(issue?.repo).toBe(teamRepo);
  });

  it("keeps an explicit action repo over the team default", async () => {
    const issue = await escalate("panic-beta", {
      type: "create_issue",
      teamId: defaultedTeamId,
      repo: "VortexNYC/explicit-repo",
    });
    expect(issue?.repo).toBe("VortexNYC/explicit-repo");
  });

  it("stays repo-less when the action binds no team", async () => {
    const issue = await escalate("panic-gamma", { type: "create_issue" });
    expect(issue?.repo).toBeNull();
  });
});

describe("triage precedence over escalation (PILE-427)", () => {
  it("a matched triage rule owns the ticket and escalation stands down", async () => {
    const db = createD1(env.D1);
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const keyword = `triage-wins-${crypto.randomUUID().slice(0, 8)}`;
    await stub.createTriageRule(
      {
        name: "ticket triage",
        recordType: "support_ticket",
        conditions: JSON.stringify({ keywords: [keyword] }),
        action: JSON.stringify({ type: "set_status", status: "snoozed" }),
      },
      { actorId: "user-esc-global" }
    );
    await createEscalationRule(db, {
      organizationId,
      name: `esc-${keyword}`,
      conditions: { keywords: [keyword] },
      action: { type: "create_issue" },
    });
    const customer = await createCustomer(db, {
      organizationId,
      email: `${crypto.randomUUID()}@example.com`,
    });
    const ticket = await createTicket(db, {
      organizationId,
      customerId: customer.id,
      title: "ticket title",
      sourceChannel: "api",
      status: "todo",
      externalSource: "api",
    });
    const issue = await maybeEscalate(env, db, organizationId, ticket, {
      text: keyword,
      channel: "api",
    });
    // The set_status triage rule matched and owned the record — no
    // escalation issue was materialized and the ticket moved to snoozed.
    expect(issue).toBeNull();
    const refreshed = await db
      .select()
      .from(supportTicketsTable)
      .where(eq(supportTicketsTable.id, ticket.id))
      .get();
    expect(refreshed?.status).toBe("snoozed");
    expect(refreshed?.issueId).toBeNull();
    const evals = await stub.listTriageEvaluations({ recordId: ticket.id });
    expect(evals[0]?.outcome).toBe("matched");
  });
});
