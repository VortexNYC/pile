import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { createAdminHeaders } from "../platform/test-auth.js";
import { createD1 } from "./db.js";
import { user as userTable } from "./schema.js";
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
