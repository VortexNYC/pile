import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { user as userTable } from "../global/schema.js";
import { createWorkspace } from "../global/workspaces.js";
import app from "../index.js";
import { createAuth } from "../platform/auth.js";
import { createAdminHeaders } from "../platform/test-auth.js";
import {
  buildIntakeMarkdown,
  intakePricingCustomFields,
  parseMoneyToCents,
  parseMonthlyTxCount,
} from "./intake.js";

async function seedWorkspace() {
  const db = createD1(env.D1);
  const now = new Date();
  await db
    .insert(userTable)
    .values({
      id: "user-intake",
      name: "Intake User",
      email: "intake-user@example.com",
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [userTable.email] });

  const setupHeaders = await createAdminHeaders(env, "user-intake");
  const workspace = await createWorkspace(db, env, setupHeaders, {
    name: "Intake test",
    slug: `intake-${crypto.randomUUID()}`,
    key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    ownerId: "user-intake",
  });

  const auth = await createAuth(env);
  const result = await auth.api.createApiKey({
    body: {
      userId: "user-intake",
      name: "test-admin",
      rateLimitEnabled: false,
      metadata: { organizationId: workspace!.id, permissions: "admin" },
      permissions: { workspace: ["admin"] },
    },
  });
  const parsed = z.object({ key: z.string() }).parse(result);
  return { organizationId: workspace!.id, token: parsed.key };
}

async function api(
  path: string,
  init: RequestInit = {},
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : undefined),
    ...(init.headers as Record<string, string> | undefined),
  };
  return app.fetch(
    new Request(`https://example.com${path}`, { ...init, headers }),
    env
  );
}

async function post(path: string, body: unknown, token?: string) {
  return api(path, { method: "POST", body: JSON.stringify(body) }, token);
}

describe("intake page", () => {
  it("serves the mobile intake shell", async () => {
    const res = await api("/intake");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Merchant intake");
    expect(body).toContain("/api/auth/sign-in/email");
    expect(body).toContain("/customer-statuses");
    expect(body).toContain('"/intake"');
    expect(body).toContain('accept="image/*"');
  });
});

describe("intake API", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    const seeded = await seedWorkspace();
    organizationId = seeded.organizationId;
    token = seeded.token;
  });

  it("rejects intake without auth", async () => {
    const res = await post(`/workspaces/${organizationId}/intake`, {
      businessName: "Bodega",
    });
    expect([401, 403]).toContain(res.status);
  });

  it("creates customer, contact, document, status and booking link", async () => {
    const statusRes = await post(
      `/workspaces/${organizationId}/customer-statuses`,
      { name: "New", position: 0 },
      token
    );
    const status = z.object({ id: z.string() }).parse(await statusRes.json());

    const res = await post(
      `/workspaces/${organizationId}/intake`,
      {
        intakeId: "visit-001",
        businessName: "Joe's Deli",
        address: "123 Main St",
        visitedAt: "2026-10-07T14:00:00Z",
        owner: {
          name: "Joe Owner",
          email: "joe@joesdeli.example",
          phone: "+1 555 0100",
          bestTime: "mornings",
        },
        meeting: {
          booked: true,
          at: "2026-10-09T15:00:00Z",
          bookingUrl: "https://cal.com/vortex/intro",
        },
        discovery: {
          businessType: "counter service",
          billingSystems: ["point-of-sale"],
          paymentMethods: ["card-present", "keyed"],
          hardware: "Square terminal",
          hardwareOwnership: "bundled",
        },
        pricing: {
          currentProcessor: "Square",
          underContract: false,
          monthlyCardVolume: "40000",
          cardMix: "mostly debit",
        },
        pain: { biggestComplaint: "fees are too high" },
        pipelineStatusId: status.id,
        nextStep: "statement handoff",
        repNotes: "real prospect",
        statementFiles: [
          {
            key: `${organizationId}/files/abc/page1.jpg`,
            url: `/workspaces/${organizationId}/files?key=${organizationId}%2Ffiles%2Fabc%2Fpage1.jpg`,
            name: "page1.jpg",
          },
        ],
      },
      token
    );
    expect(res.status).toBe(201);
    const result = z
      .object({
        customerId: z.string(),
        contactId: z.string(),
        documentId: z.string(),
        statusId: z.string(),
        bookingLinkId: z.string(),
        deduped: z.boolean(),
      })
      .parse(await res.json());
    expect(result.deduped).toBe(false);

    const customerRes = await api(
      `/workspaces/${organizationId}/customers/${result.customerId}`,
      {},
      token
    );
    const customer = z
      .object({
        name: z.string(),
        statusId: z.string().nullable(),
        externalId: z.string().nullable(),
      })
      .parse(await customerRes.json());
    expect(customer.name).toBe("Joe's Deli");
    expect(customer.statusId).toBe(status.id);
    expect(customer.externalId).toBe("visit-001");

    const docRes = await api(
      `/workspaces/${organizationId}/documents/${result.documentId}`,
      {},
      token
    );
    const doc = z
      .object({ content: z.string(), slug: z.string().nullable() })
      .parse(await docRes.json());
    expect(doc.slug).toBe("intake-visit-001");
    expect(doc.content).toContain("Joe's Deli");
    expect(doc.content).toContain("Square");
    expect(doc.content).toContain("fees are too high");
    expect(doc.content).toContain("cal.com/vortex/intro");
    expect(doc.content).toContain("page1.jpg");

    const linksRes = await api(
      `/workspaces/${organizationId}/external-links?entityType=customer&entityId=${result.customerId}`,
      {},
      token
    );
    const { links } = z
      .object({ links: z.array(z.object({ url: z.string() })) })
      .parse(await linksRes.json());
    expect(links.map((l) => l.url)).toContain("https://cal.com/vortex/intro");
  });

  it("dedupes a retried submit on intakeId", async () => {
    const body = {
      intakeId: "visit-retry",
      businessName: "Retry Cafe",
      owner: { email: "owner@retry.example", name: "Retry Owner" },
      meeting: { booked: false, bookingUrl: "https://cal.com/vortex/retry" },
    };
    const first = await post(
      `/workspaces/${organizationId}/intake`,
      body,
      token
    );
    expect(first.status).toBe(201);
    const firstResult = z
      .object({ customerId: z.string() })
      .parse(await first.json());
    const second = await post(
      `/workspaces/${organizationId}/intake`,
      body,
      token
    );
    expect(second.status).toBe(200);
    const result = z
      .object({ deduped: z.boolean(), customerId: z.string() })
      .parse(await second.json());
    expect(result.deduped).toBe(true);
    // The retry resolves to the same customer record — dedupe is by
    // identity (externalId), not just suppression of a second insert.
    expect(result.customerId).toBe(firstResult.customerId);

    const customersRes = await api(
      `/workspaces/${organizationId}/customers`,
      {},
      token
    );
    const { customers } = z
      .object({
        customers: z.array(z.object({ externalId: z.string().nullable() })),
      })
      .parse(await customersRes.json());
    expect(
      customers.filter((cust) => cust.externalId === "visit-retry")
    ).toHaveLength(1);
  });

  it("rejects statement files from another workspace", async () => {
    const res = await post(
      `/workspaces/${organizationId}/intake`,
      {
        businessName: "Foreign Files Co",
        statementFiles: [{ key: "other-org/files/abc/page1.jpg", url: "/x" }],
      },
      token
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown pipeline status", async () => {
    const res = await post(
      `/workspaces/${organizationId}/intake`,
      { businessName: "Bad Status Co", pipelineStatusId: "missing" },
      token
    );
    expect(res.status).toBe(400);
  });

  it("promotes pricing answers to custom fields and a revenue_estimate signal (PILE-654)", async () => {
    const res = await post(
      `/workspaces/${organizationId}/intake`,
      {
        intakeId: "visit-volume",
        businessName: "Volume Grocer",
        address: "9 Bedford Ave",
        pricing: {
          currentProcessor: "Square",
          underContract: true,
          contractEnd: "2027-03-01",
          earlyTerminationFee: "$300",
          monthlyCardVolume: "40k",
          averageTicket: "$28.50",
          transactionsPerDay: "60",
          cardMix: "mostly debit",
          channelMix: "mostly in-person tap/insert",
        },
      },
      token
    );
    expect(res.status).toBe(201);
    const result = z.object({ customerId: z.string() }).parse(await res.json());

    const customerRes = await api(
      `/workspaces/${organizationId}/customers/${result.customerId}`,
      {},
      token
    );
    const customer = z
      .object({
        customFields: z.record(z.string(), z.string()),
        priorityScore: z.number().nullable(),
      })
      .parse(await customerRes.json());
    expect(customer.customFields.monthly_card_volume_cents).toBe("4000000");
    expect(customer.customFields.avg_ticket_cents).toBe("2850");
    expect(customer.customFields.monthly_tx_count).toBe("1800");
    expect(customer.customFields.current_processor).toBe("Square");
    expect(customer.customFields.card_mix).toBe("mostly debit");
    expect(customer.customFields.channel_mix).toBe(
      "mostly in-person tap/insert"
    );
    expect(customer.customFields.contract_end).toBe("2027-03-01");
    expect(customer.customFields.etf_cents).toBe("30000");

    // The revenue_estimate signal persisted → the ranker picked up both
    // the signal and the ICP volume predicate, and the scores landed on
    // the customer row so the priorityScore list sort sees them.
    const sigRes = await api(
      `/workspaces/${organizationId}/customers/${result.customerId}/signals`,
      {},
      token
    );
    const sigBody = z
      .object({
        signals: z.array(
          z.object({
            type: z.string(),
            summary: z.string().nullable().optional(),
          })
        ),
        breakdown: z.object({
          priorityScore: z.number(),
          matchedIcpRules: z.array(z.string()),
          signalContributions: z.array(z.object({ type: z.string() })),
        }),
      })
      .parse(await sigRes.json());
    const revenue = sigBody.signals.find((s) => s.type === "revenue_estimate");
    expect(revenue?.summary).toContain("$40,000");
    expect(sigBody.breakdown.signalContributions.map((c) => c.type)).toContain(
      "revenue_estimate"
    );
    expect(sigBody.breakdown.matchedIcpRules).toContain(
      "icp-est-monthly-card-volume"
    );
    expect(customer.priorityScore).not.toBeNull();
    expect(customer.priorityScore).toBeGreaterThan(0);
  });

  it("keeps unparseable volume answers as raw fields without breaking submit (PILE-654)", async () => {
    const res = await post(
      `/workspaces/${organizationId}/intake`,
      {
        intakeId: "visit-fuzzy",
        businessName: "Fuzzy Numbers Co",
        pricing: {
          monthlyCardVolume: "40-50k seasonal",
          transactionsPerDay: "depends on weather",
        },
      },
      token
    );
    expect(res.status).toBe(201);
    const result = z.object({ customerId: z.string() }).parse(await res.json());

    const customerRes = await api(
      `/workspaces/${organizationId}/customers/${result.customerId}`,
      {},
      token
    );
    const customer = z
      .object({ customFields: z.record(z.string(), z.string()) })
      .parse(await customerRes.json());
    expect(customer.customFields.monthly_card_volume).toBe("40-50k seasonal");
    expect(customer.customFields.transactions_per_day).toBe(
      "depends on weather"
    );
    expect("monthly_card_volume_cents" in customer.customFields).toBe(false);

    const sigRes = await api(
      `/workspaces/${organizationId}/customers/${result.customerId}/signals`,
      {},
      token
    );
    const sigBody = z
      .object({ signals: z.array(z.object({ type: z.string() })) })
      .parse(await sigRes.json());
    expect(sigBody.signals.map((s) => s.type)).not.toContain(
      "revenue_estimate"
    );
  });
});

describe("intake pricing field parsing (PILE-654)", () => {
  it("parses clean money/count answers and keeps lossy values raw", () => {
    expect(parseMoneyToCents("40000")).toBe(4_000_000);
    expect(parseMoneyToCents("$40k")).toBe(4_000_000);
    expect(parseMoneyToCents("$1,234.56")).toBe(123_456);
    expect(parseMoneyToCents("40-50k seasonal")).toBeNull();
    expect(parseMoneyToCents("depends")).toBeNull();
    expect(parseMoneyToCents(undefined)).toBeNull();

    expect(parseMonthlyTxCount("60")).toBe(1800);
    expect(parseMonthlyTxCount("12.5")).toBe(375);
    expect(parseMonthlyTxCount("varies")).toBeNull();
    expect(parseMonthlyTxCount(undefined)).toBeNull();

    const fields = intakePricingCustomFields({
      businessName: "X",
      pricing: {
        monthlyCardVolume: "40-50k",
        averageTicket: "$28.50",
        transactionsPerDay: "60",
        currentProcessor: " Square ",
      },
    });
    expect(fields.monthly_card_volume).toBe("40-50k");
    expect(fields.monthly_card_volume_cents).toBeUndefined();
    expect(fields.avg_ticket_cents).toBe("2850");
    expect(fields.monthly_tx_count).toBe("1800");
    expect(fields.current_processor).toBe("Square");
    expect(intakePricingCustomFields({ businessName: "Y" })).toEqual({});
  });
});

describe("buildIntakeMarkdown", () => {
  it("renders checklist sections and omits empty fields", () => {
    const md = buildIntakeMarkdown({
      businessName: "Taco Truck",
      discovery: { businessType: "counter service" },
      pricing: { currentProcessor: "Clover", underContract: true },
    });
    expect(md).toContain("# Taco Truck — visit intake");
    expect(md).toContain("## Discovery");
    expect(md).toContain("**Business type:** counter service");
    expect(md).toContain("**Current processor:** Clover");
    expect(md).toContain("**Under contract:** yes");
    expect(md).not.toContain("**Contract end:**");
    expect(md).toContain("- none captured");
  });
});

describe("triage rules on customer create (PILE-427)", () => {
  let organizationId: string;
  let token: string;

  beforeAll(async () => {
    ({ organizationId, token } = await seedWorkspace());
  });

  it("delegates a new intake customer per its rule", async () => {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const agentId = `mock-cust-${crypto.randomUUID().slice(0, 8)}`;
    const { registerAgentProvider, MockAgentProvider } =
      await import("../agents/index.js").then(async (m) => ({
        registerAgentProvider: m.registerAgentProvider,
        MockAgentProvider: (await import("../agents/harness.js"))
          .MockAgentProvider,
      }));
    registerAgentProvider(agentId, () => new MockAgentProvider(agentId, {}));
    await stub.createTriageRule(
      {
        name: "customers to profiler",
        recordType: "customer",
        conditions: "{}",
        action: JSON.stringify({ type: "delegate", agentId }),
      },
      { actorId: "user-intake" }
    );

    const res = await api(
      `/workspaces/${organizationId}/intake`,
      {
        method: "POST",
        body: JSON.stringify({ businessName: "Triage Bodega" }),
      },
      token
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { customerId: string };
    const issue = await stub.getIssue(`triage:customer:${body.customerId}`);
    expect(issue?.delegateId).toBe(agentId);
    const evals = await stub.listTriageEvaluations({
      recordType: "customer",
      recordId: body.customerId,
    });
    expect(evals[0]?.outcome).toBe("matched");
  });
});
