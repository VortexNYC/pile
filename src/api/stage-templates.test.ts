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
      id: "user-stage-templates",
      name: "Stage Templates User",
      email: "stage-templates-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-stage-templates");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Stage templates test",
    slug: `stage-templates-${crypto.randomUUID()}`,
    key: `S${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-stage-templates",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-stage-templates",
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
    ...(init.headers as Record<string, string> | undefined),
    ...(token ? { Authorization: `Bearer ${token}` } : undefined),
  };
  return app.fetch(
    new Request(`https://example.com${path}`, { ...init, headers }),
    env
  );
}

const templateSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  entityType: z.enum(["issue", "deal", "customer"]),
  status: z.string(),
  stepKey: z.string(),
  title: z.string(),
  required: z.boolean(),
  ownerAgent: z.string().nullable(),
  condition: z
    .object({
      field: z.string(),
      equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
    })
    .nullable(),
  position: z.number(),
  teamId: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

describe("stage templates", () => {
  let organizationId = "";
  let token = "";

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("CRUDs a template with normalized keys", async () => {
    const created = await fetch(
      `/workspaces/${organizationId}/stage-templates`,
      {
        method: "POST",
        body: JSON.stringify({
          entityType: "customer",
          status: "Onboarding & go-live",
          stepKey: "Kickoff Call",
          title: "Kickoff call",
          required: false,
          ownerAgent: "integrator",
          condition: { field: "has_pbx" },
        }),
      },
      token
    );
    expect(created.status).toBe(201);
    const { template } = z
      .object({ template: templateSchema })
      .parse(await created.json());
    // status/stepKey normalize to slug keys at write.
    expect(template.status).toBe("onboarding_go_live");
    expect(template.stepKey).toBe("kickoff_call");
    expect(template.required).toBe(false);
    expect(template.ownerAgent).toBe("integrator");
    expect(template.condition).toEqual({ field: "has_pbx" });

    const list = await fetch(
      `/workspaces/${organizationId}/stage-templates?entityType=customer&status=onboarding_go_live`,
      {},
      token
    );
    expect(list.status).toBe(200);
    const { templates } = z
      .object({ templates: z.array(templateSchema) })
      .parse(await list.json());
    expect(templates.some((t) => t.id === template.id)).toBe(true);

    const updated = await fetch(
      `/workspaces/${organizationId}/stage-templates/${template.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          title: "Kickoff call (scheduled)",
          required: true,
        }),
      },
      token
    );
    expect(updated.status).toBe(200);
    const patched = z
      .object({ template: templateSchema })
      .parse(await updated.json());
    expect(patched.template.title).toBe("Kickoff call (scheduled)");
    expect(patched.template.required).toBe(true);

    const deleted = await fetch(
      `/workspaces/${organizationId}/stage-templates/${template.id}`,
      { method: "DELETE" },
      token
    );
    expect(deleted.status).toBe(200);
    const gone = await fetch(
      `/workspaces/${organizationId}/stage-templates/${template.id}`,
      {},
      token
    );
    expect(gone.status).toBe(404);
  });

  it("seeds the 7 pipeline stages idempotently", async () => {
    const first = await fetch(
      `/workspaces/${organizationId}/stage-templates/seed`,
      { method: "POST" },
      token
    );
    expect(first.status).toBe(200);
    const seeded = z
      .object({ templates: z.array(templateSchema), skipped: z.number() })
      .parse(await first.json());
    expect(seeded.templates.length).toBe(22);
    expect(seeded.skipped).toBe(0);
    const statuses = new Set(seeded.templates.map((t) => t.status));
    expect([...statuses].sort()).toEqual(
      [
        "application_underwriting",
        "contracting",
        "discovery",
        "onboarding_go_live",
        "outreach",
        "prospect",
        "proposal",
      ].sort()
    );

    // Second seed is a no-op — operator edits survive.
    const second = await fetch(
      `/workspaces/${organizationId}/stage-templates/seed`,
      { method: "POST" },
      token
    );
    const reseeded = z
      .object({ templates: z.array(templateSchema), skipped: z.number() })
      .parse(await second.json());
    expect(reseeded.templates.length).toBe(0);
    expect(reseeded.skipped).toBe(22);
  });

  it("materializes sub-steps under a deal issue when the customer's status enters a stage", async () => {
    // The deal is the parent issue linked to the customer; the merchant's
    // stage is the customer status (name).
    const issueRes = await fetch(
      `/workspaces/${organizationId}/issues`,
      {
        method: "POST",
        body: JSON.stringify({ title: "Deal — Acme Bakery" }),
      },
      token
    );
    expect(issueRes.status).toBe(201);
    const issue = z.object({ id: z.string() }).parse(await issueRes.json());

    const statusRes = await fetch(
      `/workspaces/${organizationId}/customer-statuses`,
      { method: "POST", body: JSON.stringify({ name: "Prospect" }) },
      token
    );
    expect(statusRes.status).toBe(201);
    const status = z.object({ id: z.string() }).parse(await statusRes.json());

    const customerRes = await fetch(
      `/workspaces/${organizationId}/customers`,
      { method: "POST", body: JSON.stringify({ name: "Acme Bakery" }) },
      token
    );
    expect(customerRes.status).toBe(201);
    const customer = z
      .object({ id: z.string() })
      .parse(await customerRes.json());

    const linkRes = await fetch(
      `/workspaces/${organizationId}/entities/customer/${customer.id}/links`,
      {
        method: "POST",
        body: JSON.stringify({ toType: "issue", toId: issue.id }),
      },
      token
    );
    expect(linkRes.status).toBe(201);

    // Move the deal into Prospect — seeds were installed by the prior test.
    const move = await fetch(
      `/workspaces/${organizationId}/customers/${customer.id}`,
      { method: "PATCH", body: JSON.stringify({ statusId: status.id }) },
      token
    );
    expect(move.status).toBe(200);

    const childrenRes = await fetch(
      `/workspaces/${organizationId}/issues?parentId=${issue.id}`,
      {},
      token
    );
    expect(childrenRes.status).toBe(200);
    const { issues: children } = z
      .object({
        issues: z.array(
          z.object({
            id: z.string(),
            parentId: z.string().nullable(),
            stepKey: z.string().nullable(),
            required: z.boolean(),
            ownerAgent: z.string().nullable(),
            status: z.string(),
          })
        ),
      })
      .parse(await childrenRes.json());
    const byStep = new Map(children.map((c) => [c.stepKey, c]));
    expect([...byStep.keys()].sort()).toEqual(
      [
        "contact_found",
        "field_visit",
        "profiled",
        "ready_for_outreach",
        "sourced",
      ].sort()
    );
    expect(byStep.get("sourced")).toMatchObject({
      required: true,
      ownerAgent: "scout",
      status: "todo",
    });
    expect(byStep.get("field_visit")).toMatchObject({
      required: false,
      ownerAgent: "field_dispatcher",
    });

    // Re-entering the stage does not duplicate sub-steps.
    const other = await fetch(
      `/workspaces/${organizationId}/customer-statuses`,
      { method: "POST", body: JSON.stringify({ name: "Outreach" }) },
      token
    );
    const otherStatus = z.object({ id: z.string() }).parse(await other.json());
    await fetch(
      `/workspaces/${organizationId}/customers/${customer.id}`,
      { method: "PATCH", body: JSON.stringify({ statusId: otherStatus.id }) },
      token
    );
    const backToProspect = await fetch(
      `/workspaces/${organizationId}/customers/${customer.id}`,
      { method: "PATCH", body: JSON.stringify({ statusId: status.id }) },
      token
    );
    expect(backToProspect.status).toBe(200);
    const again = await fetch(
      `/workspaces/${organizationId}/issues?parentId=${issue.id}`,
      {},
      token
    );
    const { issues: childrenAgain } = z
      .object({ issues: z.array(z.object({ stepKey: z.string().nullable() })) })
      .parse(await again.json());
    const prospectSteps = childrenAgain.filter((c) =>
      [
        "sourced",
        "profiled",
        "contact_found",
        "field_visit",
        "ready_for_outreach",
      ].includes(c.stepKey ?? "")
    );
    expect(prospectSteps.length).toBe(5);
  });
});
