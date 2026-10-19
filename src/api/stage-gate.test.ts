import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

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
      id: "user-stage-gate",
      name: "Stage Gate User",
      email: "stage-gate-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-stage-gate");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Stage gate test",
    slug: `stage-gate-${crypto.randomUUID()}`,
    key: `S${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-stage-gate",
  });

  const auth = await createAuth(env);
  const makeKey = async (name: string, permissions: string) => {
    const result = await auth.api.createApiKey({
      body: {
        userId: "user-stage-gate",
        name,
        rateLimitEnabled: false,
        metadata: { organizationId: workspace!.id, permissions },
        permissions: {
          workspace: permissions.split(",").map((p) => p.trim()),
        },
      },
    });
    return z.object({ key: z.string() }).parse(result).key;
  };
  return {
    organizationId: workspace!.id,
    adminToken: await makeKey("test-admin", "admin"),
    memberToken: await makeKey("test-member", "read,write"),
  };
}

async function fetch(
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<Response> {
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

const issueSchema = z.object({
  id: z.string(),
  identifier: z.string().nullable(),
  status: z.string(),
  resolution: z.string().nullable(),
  resolutionReason: z.string().nullable(),
});

const blockingSchema = z.object({
  details: z.object({
    blockingSubSteps: z.array(
      z.object({
        id: z.string(),
        identifier: z.string().nullable(),
        stepKey: z.string().nullable(),
        ownerAgent: z.string().nullable(),
        parentIssueId: z.string(),
      })
    ),
  }),
});

async function createIssue(token: string, org: string, title: string) {
  const res = await fetch(
    `/workspaces/${org}/issues`,
    { method: "POST", body: JSON.stringify({ title }) },
    token
  );
  expect(res.status).toBe(201);
  return issueSchema.parse(await res.json());
}

async function childrenOf(token: string, org: string, parentId: string) {
  const res = await fetch(
    `/workspaces/${org}/issues?parentId=${parentId}`,
    {},
    token
  );
  expect(res.status).toBe(200);
  return z
    .object({
      issues: z.array(
        issueSchema.extend({
          parentId: z.string().nullable(),
          stepKey: z.string().nullable(),
          required: z.boolean(),
          ownerAgent: z.string().nullable(),
        })
      ),
    })
    .parse(await res.json()).issues;
}

describe("stage gate (PILE-412)", () => {
  let organizationId = "";
  let admin = "";
  let member = "";

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    admin = seeded.adminToken;
    member = seeded.memberToken;
  });

  it("refuses a status change with open required sub-steps, listing them; optional steps never block", async () => {
    for (const step of [
      { stepKey: "req_step", title: "Required step", required: true },
      { stepKey: "opt_step", title: "Optional step", required: false },
    ]) {
      const res = await fetch(
        `/workspaces/${organizationId}/stage-templates`,
        {
          method: "POST",
          body: JSON.stringify({
            entityType: "issue",
            status: "in_progress",
            ownerAgent: "scout",
            ...step,
          }),
        },
        admin
      );
      expect(res.status).toBe(201);
    }

    const parent = await createIssue(admin, organizationId, "Gated deal");
    const enter = await fetch(
      `/workspaces/${organizationId}/issues/${parent.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "in_progress" }) },
      admin
    );
    expect(enter.status).toBe(200);

    const children = await childrenOf(admin, organizationId, parent.id);
    expect(children.map((c) => c.stepKey).toSorted()).toEqual([
      "opt_step",
      "req_step",
    ]);
    const required = children.find((c) => c.stepKey === "req_step")!;

    // Open required sub-step blocks; the 409 names it.
    const blocked = await fetch(
      `/workspaces/${organizationId}/issues/${parent.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "done" }) },
      admin
    );
    expect(blocked.status).toBe(409);
    const body = blockingSchema.parse(await blocked.json());
    expect(body.details.blockingSubSteps).toEqual([
      expect.objectContaining({
        id: required.id,
        stepKey: "req_step",
        ownerAgent: "scout",
        parentIssueId: parent.id,
      }),
    ]);

    // Completing only the optional step still blocks.
    const optional = children.find((c) => c.stepKey === "opt_step")!;
    const doneOptional = await fetch(
      `/workspaces/${organizationId}/issues/${optional.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "done" }) },
      admin
    );
    expect(doneOptional.status).toBe(200);
    const stillBlocked = await fetch(
      `/workspaces/${organizationId}/issues/${parent.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "done" }) },
      admin
    );
    expect(stillBlocked.status).toBe(409);

    // Completing the required step unblocks.
    const doneRequired = await fetch(
      `/workspaces/${organizationId}/issues/${required.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "done", resolution: "resolved" }),
      },
      admin
    );
    expect(doneRequired.status).toBe(200);
    const advance = await fetch(
      `/workspaces/${organizationId}/issues/${parent.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "done" }) },
      admin
    );
    expect(advance.status).toBe(200);
  });

  it("treats skipped-with-reason as done, rejects reasonless skips, and keeps plain cancels blocking", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/stage-templates`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "issue",
          status: "todo",
          stepKey: "gate_step",
          title: "Gate step",
          required: true,
        }),
      },
      admin
    );
    expect(res.status).toBe(201);

    const parent = await createIssue(admin, organizationId, "Skip deal");
    await fetch(
      `/workspaces/${organizationId}/issues/${parent.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "todo" }) },
      admin
    );
    const [step] = await childrenOf(admin, organizationId, parent.id);
    expect(step.stepKey).toBe("gate_step");

    // Skipping without a reason is rejected.
    const noReason = await fetch(
      `/workspaces/${organizationId}/issues/${step.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "canceled", resolution: "skipped" }),
      },
      admin
    );
    expect(noReason.status).toBe(400);

    // A plain cancel (non-skipped resolution) still blocks the parent.
    const canceled = await fetch(
      `/workspaces/${organizationId}/issues/${step.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "canceled",
          resolution: "not_planned",
        }),
      },
      admin
    );
    expect(canceled.status).toBe(200);
    const stillBlocked = await fetch(
      `/workspaces/${organizationId}/issues/${parent.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "done" }) },
      admin
    );
    expect(stillBlocked.status).toBe(409);

    // Skipped-with-reason unblocks.
    const skipped = await fetch(
      `/workspaces/${organizationId}/issues/${step.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "canceled",
          resolution: "skipped",
          resolutionReason: "Merchant has no physical storefront",
        }),
      },
      admin
    );
    expect(skipped.status).toBe(200);
    const skippedIssue = issueSchema.parse(await skipped.json());
    expect(skippedIssue.resolutionReason).toBe(
      "Merchant has no physical storefront"
    );
    const advance = await fetch(
      `/workspaces/${organizationId}/issues/${parent.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "done" }) },
      admin
    );
    expect(advance.status).toBe(200);
  });

  it("lets an admin override with a reason and records it in history + audit; non-admins get 403", async () => {
    // "triage" deliberately — fresh issues default to backlog, and a
    // template on the default status would contaminate every parent in the
    // shared workspace.
    const res = await fetch(
      `/workspaces/${organizationId}/stage-templates`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "issue",
          status: "triage",
          stepKey: "override_step",
          title: "Override step",
          required: true,
        }),
      },
      admin
    );
    expect(res.status).toBe(201);

    const parent = await createIssue(admin, organizationId, "Override deal");
    const enter = await fetch(
      `/workspaces/${organizationId}/issues/${parent.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "triage" }) },
      admin
    );
    expect(enter.status).toBe(200);
    const children = await childrenOf(admin, organizationId, parent.id);
    expect(children).toHaveLength(1);

    // A member sees the gate (409) but cannot override (403).
    const memberBlocked = await fetch(
      `/workspaces/${organizationId}/issues/${parent.id}`,
      { method: "PATCH", body: JSON.stringify({ status: "done" }) },
      member
    );
    expect(memberBlocked.status).toBe(409);
    const memberOverride = await fetch(
      `/workspaces/${organizationId}/issues/${parent.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "done",
          stageGateOverride: { reason: "member bypass attempt" },
        }),
      },
      member
    );
    expect(memberOverride.status).toBe(403);

    const override = await fetch(
      `/workspaces/${organizationId}/issues/${parent.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "done",
          stageGateOverride: { reason: "Founder approved early close" },
        }),
      },
      admin
    );
    expect(override.status).toBe(200);

    const historyRes = await fetch(
      `/workspaces/${organizationId}/issues/${parent.id}/history`,
      {},
      admin
    );
    expect(historyRes.status).toBe(200);
    const { history } = z
      .object({
        history: z.array(
          z.object({
            field: z.string(),
            fromValue: z.string().nullable(),
            toValue: z.string().nullable(),
          })
        ),
      })
      .parse(await historyRes.json());
    const overrideEntry = history.find(
      (h) => h.field === "stage_gate_override"
    );
    expect(overrideEntry).toBeDefined();
    expect(overrideEntry!.toValue).toBe("Founder approved early close");
    expect(overrideEntry!.fromValue).toContain(
      children[0].identifier ?? children[0].id
    );

    const auditRes = await fetch(
      `/workspaces/${organizationId}/audit-log?action=issue.stage_gate_override&entityId=${parent.id}`,
      {},
      admin
    );
    expect(auditRes.status).toBe(200);
    const { entries } = z
      .object({
        entries: z.array(
          z.object({
            action: z.string(),
            actorId: z.string().nullable(),
            changes: z
              .object({
                overrideReason: z.object({ to: z.string() }),
                blockingSubSteps: z.object({ from: z.array(z.string()) }),
              })
              .nullable(),
          })
        ),
      })
      .parse(await auditRes.json());
    expect(entries).toHaveLength(1);
    expect(entries[0].changes?.overrideReason.to).toBe(
      "Founder approved early close"
    );
  });

  it("gates the customer status transition on linked deal issues' open required sub-steps", async () => {
    // Seed the default pipeline (entityType customer) — Prospect's required
    // steps materialize under the linked deal issue.
    const seed = await fetch(
      `/workspaces/${organizationId}/stage-templates/seed`,
      { method: "POST" },
      admin
    );
    expect(seed.status).toBe(200);

    const issue = await createIssue(admin, organizationId, "Deal — Acme");
    const customerRes = await fetch(
      `/workspaces/${organizationId}/customers`,
      { method: "POST", body: JSON.stringify({ name: "Acme" }) },
      admin
    );
    expect(customerRes.status).toBe(201);
    const customer = z
      .object({ id: z.string() })
      .parse(await customerRes.json());
    const link = await fetch(
      `/workspaces/${organizationId}/entities/customer/${customer.id}/links`,
      {
        method: "POST",
        body: JSON.stringify({ toType: "issue", toId: issue.id }),
      },
      admin
    );
    expect(link.status).toBe(201);

    const mkStatus = async (name: string) => {
      const res = await fetch(
        `/workspaces/${organizationId}/customer-statuses`,
        { method: "POST", body: JSON.stringify({ name }) },
        admin
      );
      expect(res.status).toBe(201);
      return z.object({ id: z.string() }).parse(await res.json()).id;
    };
    const prospect = await mkStatus("Prospect");
    const outreach = await mkStatus("Outreach");

    const enter = await fetch(
      `/workspaces/${organizationId}/customers/${customer.id}`,
      { method: "PATCH", body: JSON.stringify({ statusId: prospect }) },
      admin
    );
    expect(enter.status).toBe(200);

    // Leaving Prospect with its required steps open is refused.
    const blocked = await fetch(
      `/workspaces/${organizationId}/customers/${customer.id}`,
      { method: "PATCH", body: JSON.stringify({ statusId: outreach }) },
      admin
    );
    expect(blocked.status).toBe(409);
    const body = blockingSchema.parse(await blocked.json());
    expect(body.details.blockingSubSteps.map((s) => s.stepKey)).toContain(
      "sourced"
    );

    // Admin override advances the stage.
    const override = await fetch(
      `/workspaces/${organizationId}/customers/${customer.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          statusId: outreach,
          stageGateOverride: { reason: "Manual re-qualification" },
        }),
      },
      admin
    );
    expect(override.status).toBe(200);

    // The override landed on the deal issue's activity.
    const historyRes = await fetch(
      `/workspaces/${organizationId}/issues/${issue.id}/history`,
      {},
      admin
    );
    const { history } = z
      .object({ history: z.array(z.object({ field: z.string() })) })
      .parse(await historyRes.json());
    expect(history.some((h) => h.field === "stage_gate_override")).toBe(true);
  });

  it("gates deal stage transitions the same way", async () => {
    const res = await fetch(
      `/workspaces/${organizationId}/stage-templates`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "deal",
          status: "qualified",
          stepKey: "deal_qual_step",
          title: "Qualification step",
          required: true,
        }),
      },
      admin
    );
    expect(res.status).toBe(201);

    const customerRes = await fetch(
      `/workspaces/${organizationId}/customers`,
      { method: "POST", body: JSON.stringify({ name: "Deal Co" }) },
      admin
    );
    const customer = z
      .object({ id: z.string() })
      .parse(await customerRes.json());
    const dealRes = await fetch(
      `/workspaces/${organizationId}/deals`,
      {
        method: "POST",
        body: JSON.stringify({ customerId: customer.id, name: "Deal Co" }),
      },
      admin
    );
    expect(dealRes.status).toBe(201);
    const deal = z
      .object({ deal: z.object({ id: z.string() }) })
      .parse(await dealRes.json()).deal;

    const issue = await createIssue(admin, organizationId, "Deal Co parent");
    const link = await fetch(
      `/workspaces/${organizationId}/entities/deal/${deal.id}/links`,
      {
        method: "POST",
        body: JSON.stringify({ toType: "issue", toId: issue.id }),
      },
      admin
    );
    expect(link.status).toBe(201);

    const enter = await fetch(
      `/workspaces/${organizationId}/deals/${deal.id}`,
      { method: "PATCH", body: JSON.stringify({ stage: "qualified" }) },
      admin
    );
    expect(enter.status).toBe(200);

    const blocked = await fetch(
      `/workspaces/${organizationId}/deals/${deal.id}`,
      { method: "PATCH", body: JSON.stringify({ stage: "proposal" }) },
      admin
    );
    expect(blocked.status).toBe(409);

    const override = await fetch(
      `/workspaces/${organizationId}/deals/${deal.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          stage: "proposal",
          stageGateOverride: { reason: "Qualified by call" },
        }),
      },
      admin
    );
    expect(override.status).toBe(200);
  });
});
