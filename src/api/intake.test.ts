import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
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
  parseStatementMetricsFromText,
  pppLoanCustomFields,
  pppLoanEstimates,
  quoteRequestCustomFields,
  quoteRequestName,
  vortexMerchantCustomFields,
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

describe("vortex quote-requests sync (PILE-655)", () => {
  let organizationId: string;
  let token: string;

  const syncResultSchema = z.object({
    synced: z.number(),
    created: z.number(),
    updated: z.number(),
    customers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        externalId: z.string().nullable(),
        estMonthlyVolumeCents: z.number().nullable(),
        score: z.number().nullable(),
      })
    ),
  });

  function workspaceStub() {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    return stub;
  }

  beforeAll(async () => {
    ({ organizationId, token } = await seedWorkspace());
  });

  it("imports inline quote requests as customers with volume fields, contacts, lead deals and a revenue_estimate signal", async () => {
    const res = await post(
      `/workspaces/${organizationId}/intake/quote-requests/sync`,
      {
        quoteRequests: [
          {
            id: "qr-001",
            businessName: "Calculator Corner Deli",
            contactEmail: "Owner@CornerDeli.example",
            contactName: "Cora Owner",
            contactPhone: "+1 555 0142",
            monthlyVolumeCents: 4_000_000,
            avgTicketCents: 2850,
            currentProcessor: "Square",
            effectiveRateBps: 290,
            estimatedAnnualSavingsCents: 120_000,
            notes: "asked about handhelds",
            createdAt: new Date().toISOString(),
          },
          {
            // No business name — falls back to the email local part.
            id: "qr-002",
            contactEmail: "lonely@nowhere.example",
          },
        ],
      },
      token
    );
    expect(res.status).toBe(200);
    const body = syncResultSchema.parse(await res.json());
    expect(body.synced).toBe(2);
    expect(body.created).toBe(2);
    expect(body.updated).toBe(0);

    const first = body.customers[0]!;
    expect(first.name).toBe("Calculator Corner Deli");
    expect(first.externalId).toBe("vortex-quote:qr-001");
    expect(first.estMonthlyVolumeCents).toBe(4_000_000);
    expect(first.score).not.toBeNull();
    expect(first.score).toBeGreaterThan(0);
    expect(body.customers[1]!.name).toBe("lonely");
    expect(body.customers[1]!.estMonthlyVolumeCents).toBeNull();

    const customerRes = await api(
      `/workspaces/${organizationId}/customers/${first.id}`,
      {},
      token
    );
    const customer = z
      .object({
        name: z.string(),
        externalId: z.string().nullable(),
        processor: z.string().nullable(),
        source: z.string().nullable(),
        customFields: z.record(z.string(), z.string()),
      })
      .parse(await customerRes.json());
    expect(customer.externalId).toBe("vortex-quote:qr-001");
    expect(customer.processor).toBe("Square");
    expect(customer.source).toBe("vortex_quote_calculator");
    expect(customer.customFields.estMonthlyVolumeCents).toBe("4000000");
    expect(customer.customFields.averageTicketCents).toBe("2850");
    expect(customer.customFields.currentProcessor).toBe("Square");
    expect(customer.customFields.effectiveRateBps).toBe("290");
    expect(customer.customFields.estimatedAnnualSavingsCents).toBe("120000");
    expect(customer.customFields.vortexQuoteRequestId).toBe("qr-001");
    expect(customer.customFields.inboundSource).toBe("vortex_quote_calculator");

    // Contact upserted on the customer — normalized lowercase email.
    const stub = workspaceStub();
    const contacts = await stub.listContacts(first.id);
    const emails = contacts.filter((ct) => ct.channel === "email");
    expect(emails).toHaveLength(1);
    expect(emails[0]!.value).toBe("owner@cornerdeli.example");
    expect(contacts.some((ct) => ct.channel === "phone")).toBe(true);

    // Lead-stage deal opened for the inbound merchant.
    const deals = await stub.listDeals();
    const customerDeals = deals.filter((d) => d.customerId === first.id);
    expect(customerDeals).toHaveLength(1);
    expect(customerDeals[0]!.stage).toBe("lead");
    expect(customerDeals[0]!.externalId).toBe("vortex-quote:qr-001");

    // The reported volume ranked: revenue_estimate signal + persisted score.
    const sigRes = await api(
      `/workspaces/${organizationId}/customers/${first.id}/signals`,
      {},
      token
    );
    const sigBody = z
      .object({
        signals: z.array(
          z.object({
            type: z.string(),
            summary: z.string().nullable().optional(),
            source: z.string().optional(),
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
    expect(revenue?.source).toBe("vortex_quote_calculator");
    expect(revenue?.summary).toContain("$40,000");
    expect(sigBody.breakdown.signalContributions.map((c) => c.type)).toContain(
      "revenue_estimate"
    );
    expect(sigBody.breakdown.matchedIcpRules).toContain(
      "icp-est-monthly-card-volume"
    );
  });

  it("re-sync updates the same customer instead of duplicating (externalId + email dedupe)", async () => {
    const first = await post(
      `/workspaces/${organizationId}/intake/quote-requests/sync`,
      {
        quoteRequests: [
          {
            id: "qr-repeat",
            businessName: "Repeat Retail",
            contactEmail: "repeat@retail.example",
            monthlyVolumeCents: 2_000_000,
            currentProcessor: "Clover",
          },
        ],
      },
      token
    );
    expect(first.status).toBe(200);
    const firstBody = syncResultSchema.parse(await first.json());
    expect(firstBody.created).toBe(1);
    const customerId = firstBody.customers[0]!.id;

    // Second sync: same quote-request id with refreshed figures, plus a
    // *new* id for the same merchant email — both must resolve to the one
    // customer row instead of minting duplicates.
    const second = await post(
      `/workspaces/${organizationId}/intake/quote-requests/sync`,
      {
        quoteRequests: [
          {
            id: "qr-repeat",
            businessName: "Repeat Retail",
            contactEmail: "repeat@retail.example",
            monthlyVolumeCents: 5_000_000,
          },
          {
            id: "qr-repeat-2",
            contactEmail: "REPEAT@retail.example",
          },
        ],
      },
      token
    );
    expect(second.status).toBe(200);
    const secondBody = syncResultSchema.parse(await second.json());
    expect(secondBody.synced).toBe(2);
    expect(secondBody.created).toBe(0);
    expect(secondBody.updated).toBe(2);
    expect(secondBody.customers.map((cust) => cust.id)).toEqual([
      customerId,
      customerId,
    ]);

    const customerRes = await api(
      `/workspaces/${organizationId}/customers/${customerId}`,
      {},
      token
    );
    const customer = z
      .object({
        externalId: z.string().nullable(),
        customFields: z.record(z.string(), z.string()),
      })
      .parse(await customerRes.json());
    expect(customer.externalId).toBe("vortex-quote:qr-repeat");
    // Latest figures win on the always-upserted custom fields.
    expect(customer.customFields.estMonthlyVolumeCents).toBe("5000000");

    const stub = workspaceStub();
    const contacts = await stub.listContacts(customerId);
    expect(contacts.filter((ct) => ct.channel === "email")).toHaveLength(1);

    const deals = await stub.listDeals();
    const customerDeals = deals.filter((d) => d.customerId === customerId);
    expect(customerDeals).toHaveLength(1);
    expect(customerDeals[0]!.stage).toBe("lead");
  });

  it("pulls quote requests from the Vortex API when an operator key is supplied", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        seen.push({
          url,
          auth: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({
          quoteRequests: [
            {
              id: "qr-remote-1",
              merchantName: "Remote Merchant Co",
              contactEmail: "remote@merchant.example",
              contactPhone: "5550100",
              monthlyVolumeCents: 2_500_000,
              avgTicketCents: 6200,
              currentProcessor: "Toast",
            },
          ],
        });
      }
    );
    try {
      const res = await post(
        `/workspaces/${organizationId}/intake/quote-requests/sync`,
        {
          vortexOperatorKey: "op-key-123",
        },
        token
      );
      expect(res.status).toBe(200);
      const body = syncResultSchema.parse(await res.json());
      expect(body.synced).toBe(1);
      expect(body.created).toBe(1);
      expect(body.customers[0]!.name).toBe("Remote Merchant Co");
      expect(body.customers[0]!.externalId).toBe("vortex-quote:qr-remote-1");
      expect(body.customers[0]!.estMonthlyVolumeCents).toBe(2_500_000);
      expect(body.customers[0]!.score).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(
      "https://api.vortex.nyc/v1/operator/quote-requests"
    );
    expect(seen[0]!.auth).toBe("Bearer op-key-123");
  });

  it("returns 400 when neither inline quoteRequests nor an operator key is provided", async () => {
    const res = await post(
      `/workspaces/${organizationId}/intake/quote-requests/sync`,
      {},
      token
    );
    expect(res.status).toBe(400);
  });
});

describe("quote-request helpers (PILE-655)", () => {
  it("names merchants from business/contact/email fallbacks", () => {
    expect(quoteRequestName({ id: "a", businessName: "  Deli Co  " })).toBe(
      "Deli Co"
    );
    expect(quoteRequestName({ id: "b", merchantName: "Merchant LLC" })).toBe(
      "Merchant LLC"
    );
    expect(quoteRequestName({ id: "c", companyName: "Company Inc" })).toBe(
      "Company Inc"
    );
    expect(quoteRequestName({ id: "d", contactName: "Sam Shop" })).toBe(
      "Sam Shop"
    );
    expect(
      quoteRequestName({ id: "e", contactEmail: "owner@shop.example" })
    ).toBe("owner");
    expect(quoteRequestName({ id: "f" })).toBe("Quote request f");
  });

  it("writes finite volume fields and skips junk numbers", () => {
    const fields = quoteRequestCustomFields({
      id: "qr-x",
      monthlyVolumeCents: 4_000_000,
      avgTicketCents: 2850,
      effectiveRateBps: 290,
      estimatedAnnualSavingsCents: 120_000,
      currentProcessor: " Square ",
    });
    expect(fields.estMonthlyVolumeCents).toBe("4000000");
    expect(fields.averageTicketCents).toBe("2850");
    expect(fields.effectiveRateBps).toBe("290");
    expect(fields.estimatedAnnualSavingsCents).toBe("120000");
    expect(fields.currentProcessor).toBe("Square");
    expect(fields.vortexQuoteRequestId).toBe("qr-x");
    expect(fields.inboundSource).toBe("vortex_quote_calculator");

    const empty = quoteRequestCustomFields({ id: "qr-y" });
    expect(empty).toEqual({
      vortexQuoteRequestId: "qr-y",
      inboundSource: "vortex_quote_calculator",
    });
    const junk = quoteRequestCustomFields({
      id: "qr-z",
      monthlyVolumeCents: Number.NaN,
    });
    expect("estMonthlyVolumeCents" in junk).toBe(false);
  });
});

describe("vortex merchant-statement sync (PILE-656)", () => {
  let organizationId: string;
  let token: string;

  const syncResultSchema = z.object({
    synced: z.number(),
    created: z.number(),
    updated: z.number(),
    customers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        externalMerchantRef: z.string(),
        measuredMonthlyVolumeCents: z.number().nullable(),
        effectiveRateBps: z.number().nullable(),
        score: z.number().nullable(),
      })
    ),
  });

  function workspaceStub() {
    return env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
  }

  beforeAll(async () => {
    ({ organizationId, token } = await seedWorkspace());
  });

  it("joins measured TPV onto an existing customer by contact email, writes customFields, stamps the intake doc, and ranks a strength-100 revenue_estimate", async () => {
    // Seed a merchant the way the field team does — a visit intake with
    // an owner email and an intake document.
    const intakeRes = await post(
      `/workspaces/${organizationId}/intake`,
      {
        intakeId: "visit-tpv",
        businessName: "Measured Corner Deli",
        owner: { name: "Meg Owner", email: "owner@measured.example" },
      },
      token
    );
    expect(intakeRes.status).toBe(201);
    const intakeResult = z
      .object({ customerId: z.string() })
      .parse(await intakeRes.json());

    const res = await post(
      `/workspaces/${organizationId}/intake/vortex-merchants/sync`,
      {
        merchants: [
          {
            externalMerchantRef: "vm_123",
            businessName: "Measured Corner Deli",
            contactEmail: "OWNER@measured.example",
            monthlyVolumeCents: 6_000_000,
            totalFeesCents: 171_000,
            effectiveRateBps: 285,
            avgTicketCents: 4_000,
            transactionCount: 1_500,
            statementPeriod: "2026-09",
            processor: "Square",
          },
          {
            // No match anywhere — a brand-new Vortex merchant joins the
            // book as a fresh customer.
            externalMerchantRef: "vm_999",
            businessName: "Brand New Spot",
            monthlyVolumeCents: 2_000_000,
          },
        ],
      },
      token
    );
    expect(res.status).toBe(200);
    const body = syncResultSchema.parse(await res.json());
    expect(body.synced).toBe(2);
    expect(body.updated).toBe(1);
    expect(body.created).toBe(1);

    const joined = body.customers[0]!;
    expect(joined.id).toBe(intakeResult.customerId);
    expect(joined.externalMerchantRef).toBe("vm_123");
    expect(joined.measuredMonthlyVolumeCents).toBe(6_000_000);
    expect(joined.effectiveRateBps).toBe(285);
    expect(joined.score).not.toBeNull();
    expect(joined.score).toBeGreaterThan(0);

    const created = body.customers[1]!;
    expect(created.name).toBe("Brand New Spot");

    // customFields carry the measured figure under every key the rest of
    // the system reads, incl. the canonical PILE-654 volume key.
    const customerRes = await api(
      `/workspaces/${organizationId}/customers/${joined.id}`,
      {},
      token
    );
    const customer = z
      .object({
        externalId: z.string().nullable(),
        processor: z.string().nullable(),
        customFields: z.record(z.string(), z.string()),
        priorityScore: z.number().nullable(),
      })
      .parse(await customerRes.json());
    // The intake-issued externalId (the intakeId) is kept — the join key
    // lives in customFields instead of clobbering it.
    expect(customer.externalId).toBe("visit-tpv");
    expect(customer.processor).toBe("Square");
    expect(customer.customFields.externalMerchantRef).toBe("vm_123");
    expect(customer.customFields.measuredMonthlyVolumeCents).toBe("6000000");
    expect(customer.customFields.estMonthlyVolumeCents).toBe("6000000");
    expect(customer.customFields.monthly_card_volume_cents).toBe("6000000");
    expect(customer.customFields.totalFeesCents).toBe("171000");
    expect(customer.customFields.effectiveRateBps).toBe("285");
    expect(customer.customFields.averageTicketCents).toBe("4000");
    expect(customer.customFields.statementPeriod).toBe("2026-09");
    expect(customer.customFields.volumeSource).toBe("vortex_first_party_tpv");
    expect(customer.priorityScore).toBe(joined.score);

    // The linked intake document got the join key too.
    const stub = workspaceStub();
    const [doc] = await stub.listDocuments({ slug: "intake-visit-tpv" });
    expect(doc).toBeDefined();
    expect(doc!.content).toContain("**Vortex merchant ref:** vm_123");

    // The created merchant carries the vortex-merchant externalId.
    const createdRes = await api(
      `/workspaces/${organizationId}/customers/${created.id}`,
      {},
      token
    );
    const createdCustomer = z
      .object({
        externalId: z.string().nullable(),
        source: z.string().nullable(),
        customFields: z.record(z.string(), z.string()),
      })
      .parse(await createdRes.json());
    expect(createdCustomer.externalId).toBe("vortex-merchant:vm_999");
    expect(createdCustomer.source).toBe("vortex_merchant_statement");
    expect(createdCustomer.customFields.externalMerchantRef).toBe("vm_999");

    // Strength-100 measured signal drove the rank, and the ICP volume
    // rule fired off the canonical field.
    const sigRes = await api(
      `/workspaces/${organizationId}/customers/${joined.id}/signals`,
      {},
      token
    );
    const sigBody = z
      .object({
        signals: z.array(
          z.object({
            type: z.string(),
            source: z.string().optional(),
            strength: z.number().optional(),
            summary: z.string().nullable().optional(),
          })
        ),
        breakdown: z.object({
          matchedIcpRules: z.array(z.string()),
          signalContributions: z.array(z.object({ type: z.string() })),
        }),
      })
      .parse(await sigRes.json());
    const revenue = sigBody.signals.find((s) => s.type === "revenue_estimate");
    expect(revenue?.source).toBe("vortex_merchant_statement");
    expect(revenue?.strength).toBe(100);
    expect(revenue?.summary).toBe(
      "Measured card volume $60,000/mo (effective rate 2.85%)"
    );
    expect(sigBody.breakdown.signalContributions.map((c) => c.type)).toContain(
      "revenue_estimate"
    );
    expect(sigBody.breakdown.matchedIcpRules).toContain(
      "icp-est-monthly-card-volume"
    );
  });

  it("re-sync matches on the join key and refreshes figures; a name-only row joins by case-insensitive business name", async () => {
    // First pass mints the merchant + its join key.
    const first = await post(
      `/workspaces/${organizationId}/intake/vortex-merchants/sync`,
      {
        merchants: [
          {
            externalMerchantRef: "vm_resync",
            businessName: "Resync Retail",
            contactEmail: "resync@retail.example",
            monthlyVolumeCents: 2_000_000,
          },
        ],
      },
      token
    );
    expect(first.status).toBe(200);
    const firstBody = syncResultSchema.parse(await first.json());
    expect(firstBody.created).toBe(1);
    const customerId = firstBody.customers[0]!.id;

    // Second pass: same ref with fresh figures (customFields join key),
    // plus a different ref for the same business name — the name match
    // joins it onto the same customer instead of duplicating.
    const second = await post(
      `/workspaces/${organizationId}/intake/vortex-merchants/sync`,
      {
        merchants: [
          {
            externalMerchantRef: "vm_resync",
            monthlyVolumeCents: 5_500_000,
            effectiveRateBps: 310,
          },
          {
            externalMerchantRef: "vm_resync_alias",
            businessName: "resync retail",
            monthlyVolumeCents: 5_500_000,
          },
        ],
      },
      token
    );
    expect(second.status).toBe(200);
    const secondBody = syncResultSchema.parse(await second.json());
    expect(secondBody.synced).toBe(2);
    expect(secondBody.created).toBe(0);
    expect(secondBody.updated).toBe(2);
    expect(secondBody.customers.map((c) => c.id)).toEqual([
      customerId,
      customerId,
    ]);

    const customerRes = await api(
      `/workspaces/${organizationId}/customers/${customerId}`,
      {},
      token
    );
    const customer = z
      .object({ customFields: z.record(z.string(), z.string()) })
      .parse(await customerRes.json());
    expect(customer.customFields.measuredMonthlyVolumeCents).toBe("5500000");
    expect(customer.customFields.monthly_card_volume_cents).toBe("5500000");
    expect(customer.customFields.effectiveRateBps).toBe("310");
    // The latest write wins the single join-key slot.
    expect(customer.customFields.externalMerchantRef).toBe("vm_resync_alias");

    // An explicit customerId pin beats every fuzzy key.
    const pinned = await post(
      `/workspaces/${organizationId}/intake/vortex-merchants/sync`,
      {
        merchants: [
          {
            externalMerchantRef: "vm_other",
            customerId,
            businessName: "Completely Different Name",
            monthlyVolumeCents: 1_000_000,
          },
        ],
      },
      token
    );
    const pinnedBody = syncResultSchema.parse(await pinned.json());
    expect(pinnedBody.customers[0]!.id).toBe(customerId);
    expect(pinnedBody.updated).toBe(1);
    expect(pinnedBody.created).toBe(0);
  });

  it("pulls merchant statements from the Vortex API when an operator key is supplied", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        seen.push({
          url,
          auth: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({
          merchants: [
            {
              externalMerchantRef: "vm_remote",
              businessName: "Remote Statement Co",
              contactEmail: "remote@statement.example",
              monthlyVolumeCents: 3_500_000,
              effectiveRateBps: 260,
              processor: "Toast",
            },
          ],
        });
      }
    );
    try {
      const res = await post(
        `/workspaces/${organizationId}/intake/vortex-merchants/sync`,
        { vortexOperatorKey: "op-key-456" },
        token
      );
      expect(res.status).toBe(200);
      const body = syncResultSchema.parse(await res.json());
      expect(body.synced).toBe(1);
      expect(body.created).toBe(1);
      expect(body.customers[0]!.name).toBe("Remote Statement Co");
      expect(body.customers[0]!.externalMerchantRef).toBe("vm_remote");
      expect(body.customers[0]!.measuredMonthlyVolumeCents).toBe(3_500_000);
      expect(body.customers[0]!.score).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(
      "https://api.vortex.nyc/v1/operator/merchant-statements"
    );
    expect(seen[0]!.auth).toBe("Bearer op-key-456");
  });

  it("returns 400 when neither inline merchants nor an operator key is provided", async () => {
    const res = await post(
      `/workspaces/${organizationId}/intake/vortex-merchants/sync`,
      {},
      token
    );
    expect(res.status).toBe(400);
  });
});

describe("statement transcription (PILE-656)", () => {
  let organizationId: string;
  let token: string;
  let customerId: string;

  const resultSchema = z.object({
    customerId: z.string(),
    metrics: z.object({
      monthlyVolumeCents: z.number().nullable(),
      totalFeesCents: z.number().nullable(),
      effectiveRateBps: z.number().nullable(),
      processor: z.string().nullable(),
    }),
    score: z.number().nullable(),
  });

  beforeAll(async () => {
    ({ organizationId, token } = await seedWorkspace());
    const res = await post(
      `/workspaces/${organizationId}/intake`,
      { intakeId: "visit-ocr", businessName: "Statement Snap Deli" },
      token
    );
    const body = z.object({ customerId: z.string() }).parse(await res.json());
    customerId = body.customerId;
  });

  it("extracts volume, fees, effective rate and processor from statement text, writes fields and ranks a revenue_estimate", async () => {
    const text = [
      "SQUARE MERCHANT STATEMENT",
      "Statement Period: 2026-09-01 to 2026-09-30",
      "Total Volume: $48,231.19",
      "Total Fees: $1,402.17",
      "Effective Rate: 2.91%",
      "Transactions: 1,692",
    ].join("\n");

    const res = await post(
      `/workspaces/${organizationId}/intake/${customerId}/transcribe-statement`,
      { extractedText: text, statementPeriod: "2026-09" },
      token
    );
    expect(res.status).toBe(200);
    const body = resultSchema.parse(await res.json());
    expect(body.customerId).toBe(customerId);
    expect(body.metrics.monthlyVolumeCents).toBe(4_823_119);
    expect(body.metrics.totalFeesCents).toBe(140_217);
    expect(body.metrics.effectiveRateBps).toBe(291);
    expect(body.metrics.processor).toBe("Square");
    expect(body.score).not.toBeNull();
    expect(body.score).toBeGreaterThan(0);

    const customerRes = await api(
      `/workspaces/${organizationId}/customers/${customerId}`,
      {},
      token
    );
    const customer = z
      .object({
        processor: z.string().nullable(),
        customFields: z.record(z.string(), z.string()),
      })
      .parse(await customerRes.json());
    expect(customer.customFields.estMonthlyVolumeCents).toBe("4823119");
    expect(customer.customFields.monthly_card_volume_cents).toBe("4823119");
    expect(customer.customFields.totalFeesCents).toBe("140217");
    expect(customer.customFields.effectiveRateBps).toBe("291");
    expect(customer.customFields.statementSource).toBe("statement_ocr");
    expect(customer.customFields.statementPeriod).toBe("2026-09");
    expect(customer.processor).toBe("Square");

    const sigRes = await api(
      `/workspaces/${organizationId}/customers/${customerId}/signals`,
      {},
      token
    );
    const sigBody = z
      .object({
        signals: z.array(
          z.object({
            type: z.string(),
            source: z.string().optional(),
            strength: z.number().optional(),
            summary: z.string().nullable().optional(),
          })
        ),
        breakdown: z.object({
          matchedIcpRules: z.array(z.string()),
        }),
      })
      .parse(await sigRes.json());
    const revenue = sigBody.signals.find((s) => s.type === "revenue_estimate");
    expect(revenue?.source).toBe("statement_ocr");
    expect(revenue?.strength).toBe(95);
    expect(revenue?.summary).toContain("$48,231");
    expect(revenue?.summary).toContain("2.91%");
    expect(sigBody.breakdown.matchedIcpRules).toContain(
      "icp-est-monthly-card-volume"
    );
  });

  it("reads a statement photo through Workers AI vision and normalizes the JSON reply", async () => {
    const calls: { model: string; inputs: Record<string, unknown> }[] = [];
    const original = env.AI;
    env.AI = {
      run: async (model: string, inputs: unknown) => {
        calls.push({ model, inputs: inputs as Record<string, unknown> });
        return {
          response: JSON.stringify({
            monthly_volume_cents: 7_500_000,
            total_fees_cents: 210_000,
            effective_rate_bps: 280,
            processor: "Toast",
          }),
        };
      },
    } as typeof env.AI;
    try {
      const res = await post(
        `/workspaces/${organizationId}/intake/${customerId}/transcribe-statement`,
        { imageBase64: "aW1hZ2VieXRlcw==" },
        token
      );
      expect(res.status).toBe(200);
      const body = resultSchema.parse(await res.json());
      expect(body.metrics.monthlyVolumeCents).toBe(7_500_000);
      expect(body.metrics.totalFeesCents).toBe(210_000);
      expect(body.metrics.effectiveRateBps).toBe(280);
      expect(body.metrics.processor).toBe("Toast");
      expect(body.score).toBeGreaterThan(0);
    } finally {
      env.AI = original;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!.model).toBe("@cf/meta/llama-3.2-11b-vision-instruct");
    expect(calls[0]!.inputs.image).toBe("aW1hZ2VieXRlcw==");
  });

  it("loads the image from an R2 attachmentKey and falls back to the text parser on a prose AI reply", async () => {
    const key = `${organizationId}/files/stmts/page1.jpg`;
    await env.ATTACHMENTS_BUCKET.put(
      key,
      new Uint8Array([0xff, 0xd8, 0xff, 0x01])
    );

    const original = env.AI;
    env.AI = {
      run: async () => ({
        // The model ignored the JSON instruction — the regex reader
        // still pulls the labelled figures out of its prose.
        response:
          "This statement shows Total Volume $30,000 with Total Fees $930.00 at an Effective Rate: 3.10% from Clover.",
      }),
    } as typeof env.AI;
    try {
      const res = await post(
        `/workspaces/${organizationId}/intake/${customerId}/transcribe-statement`,
        { attachmentKey: key },
        token
      );
      expect(res.status).toBe(200);
      const body = resultSchema.parse(await res.json());
      expect(body.metrics.monthlyVolumeCents).toBe(3_000_000);
      expect(body.metrics.totalFeesCents).toBe(93_000);
      expect(body.metrics.effectiveRateBps).toBe(310);
      expect(body.metrics.processor).toBe("Clover");
    } finally {
      env.AI = original;
    }
  });

  it("keeps an explicitly supplied volume without touching extraction", async () => {
    const calls: unknown[] = [];
    const original = env.AI;
    env.AI = {
      run: async (model: string, inputs: unknown) => {
        calls.push({ model, inputs });
        return { response: "{}" };
      },
    } as typeof env.AI;
    try {
      const res = await post(
        `/workspaces/${organizationId}/intake/${customerId}/transcribe-statement`,
        {
          monthlyVolumeCents: 1_234_500,
          extractedText: "Total Volume: $999,999.99",
          processor: "Helcim",
        },
        token
      );
      expect(res.status).toBe(200);
      const body = resultSchema.parse(await res.json());
      expect(body.metrics.monthlyVolumeCents).toBe(1_234_500);
      expect(body.metrics.processor).toBe("Helcim");
    } finally {
      env.AI = original;
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects attachments outside the workspace prefix, missing customers, and empty extractions", async () => {
    const foreign = await post(
      `/workspaces/${organizationId}/intake/${customerId}/transcribe-statement`,
      { attachmentKey: "other-org/files/x.jpg" },
      token
    );
    expect(foreign.status).toBe(400);

    const missing = await post(
      `/workspaces/${organizationId}/intake/no-such-customer/transcribe-statement`,
      { extractedText: "Total Volume: $10,000" },
      token
    );
    expect(missing.status).toBe(404);

    const nothing = await post(
      `/workspaces/${organizationId}/intake/${customerId}/transcribe-statement`,
      {},
      token
    );
    expect(nothing.status).toBe(400);
  });
});

describe("sba ppp/7a loan import (PILE-659)", () => {
  let organizationId: string;
  let token: string;

  const importResultSchema = z.object({
    imported: z.number(),
    created: z.number(),
    updated: z.number(),
    customers: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        loanAmountCents: z.number().nullable(),
        estMonthlyPayrollCents: z.number().nullable(),
        estMonthlyVolumeCents: z.number().nullable(),
        jobsReported: z.number().nullable(),
        score: z.number().nullable(),
      })
    ),
  });

  beforeAll(async () => {
    ({ organizationId, token } = await seedWorkspace());
  });

  it("imports PPP loans, derives payroll→revenue estimates, writes fields and ranks a revenue_estimate", async () => {
    const res = await post(
      `/workspaces/${organizationId}/intake/ppp-loans/import`,
      {
        loans: [
          {
            loanId: "ppp-1001",
            businessName: "Loan Bodega LLC",
            address: "500 Fulton St",
            city: "Brooklyn",
            state: "NY",
            zip: "11201",
            loanAmountCents: 25_000_000,
            jobsReported: 12,
            naicsCode: "722511",
            approvalDate: "2021-03-15",
            loanType: "ppp",
          },
          {
            // Dollars spelling + no loanId.
            businessName: "NoId Coffee",
            loanAmountDollars: 50_000,
            jobsReported: 5,
          },
          {
            // 7(a) loans aren't payroll-sized — the amount lands but no
            // payroll/volume derivation.
            loanId: "7a-2001",
            businessName: "Seven A Shop",
            loanAmountCents: 10_000_000,
            loanType: "7a",
          },
        ],
      },
      token
    );
    expect(res.status).toBe(200);
    const body = importResultSchema.parse(await res.json());
    expect(body.imported).toBe(3);
    expect(body.created).toBe(3);
    expect(body.updated).toBe(0);

    // $250,000 loan ÷ 2.5 = $100,000/mo payroll; ÷0.30 = $333,333/mo.
    const bodega = body.customers[0]!;
    expect(bodega.loanAmountCents).toBe(25_000_000);
    expect(bodega.estMonthlyPayrollCents).toBe(10_000_000);
    expect(bodega.estMonthlyVolumeCents).toBe(33_333_333);
    expect(bodega.jobsReported).toBe(12);
    expect(bodega.score).not.toBeNull();
    expect(bodega.score).toBeGreaterThan(0);

    const coffee = body.customers[1]!;
    expect(coffee.loanAmountCents).toBe(5_000_000);
    expect(coffee.estMonthlyPayrollCents).toBe(2_000_000);
    expect(coffee.estMonthlyVolumeCents).toBe(6_666_667);

    const sevenA = body.customers[2]!;
    expect(sevenA.loanAmountCents).toBe(10_000_000);
    expect(sevenA.estMonthlyPayrollCents).toBeNull();
    expect(sevenA.estMonthlyVolumeCents).toBeNull();

    const customerRes = await api(
      `/workspaces/${organizationId}/customers/${bodega.id}`,
      {},
      token
    );
    const customer = z
      .object({
        externalId: z.string().nullable(),
        source: z.string().nullable(),
        address: z.string().nullable(),
        customFields: z.record(z.string(), z.string()),
      })
      .parse(await customerRes.json());
    expect(customer.externalId).toBe("sba-ppp:ppp-1001");
    expect(customer.source).toBe("sba_ppp");
    expect(customer.address).toBe("500 Fulton St, Brooklyn, NY, 11201");
    expect(customer.customFields.pppLoanAmountCents).toBe("25000000");
    expect(customer.customFields.estMonthlyPayrollCents).toBe("10000000");
    expect(customer.customFields.estMonthlyVolumeCents).toBe("33333333");
    expect(customer.customFields.monthly_card_volume_cents).toBe("33333333");
    expect(customer.customFields.jobsReported).toBe("12");
    expect(customer.customFields.naicsCode).toBe("722511");
    expect(customer.customFields.inboundSource).toBe("sba_ppp");

    const sigRes = await api(
      `/workspaces/${organizationId}/customers/${bodega.id}/signals`,
      {},
      token
    );
    const sigBody = z
      .object({
        signals: z.array(
          z.object({
            type: z.string(),
            source: z.string().optional(),
            strength: z.number().optional(),
            summary: z.string().nullable().optional(),
          })
        ),
        breakdown: z.object({
          matchedIcpRules: z.array(z.string()),
          signalContributions: z.array(z.object({ type: z.string() })),
        }),
      })
      .parse(await sigRes.json());
    const revenue = sigBody.signals.find((s) => s.type === "revenue_estimate");
    expect(revenue?.source).toBe("sba_ppp");
    expect(revenue?.strength).toBe(75);
    expect(revenue?.summary).toBe(
      "SBA PPP loan $250,000 (12 jobs) → est. revenue ≈ $333,333/mo"
    );
    expect(sigBody.breakdown.signalContributions.map((c) => c.type)).toContain(
      "revenue_estimate"
    );
    expect(sigBody.breakdown.matchedIcpRules).toContain(
      "icp-est-monthly-card-volume"
    );

    // The 7(a) row signals on the loan amount alone.
    const sevenASigRes = await api(
      `/workspaces/${organizationId}/customers/${sevenA.id}/signals`,
      {},
      token
    );
    const sevenABody = z
      .object({
        signals: z.array(
          z.object({
            type: z.string(),
            summary: z.string().nullable().optional(),
          })
        ),
      })
      .parse(await sevenASigRes.json());
    const sevenARevenue = sevenABody.signals.find(
      (s) => s.type === "revenue_estimate"
    );
    expect(sevenARevenue?.summary).toBe("SBA 7(a) loan $100,000");
  });

  it("dedupes re-imports on the sba-ppp externalId and name+address", async () => {
    const first = await post(
      `/workspaces/${organizationId}/intake/ppp-loans/import`,
      {
        loans: [
          {
            loanId: "ppp-3000",
            businessName: "Duplex Diner",
            address: "77 Nostrand Ave",
            loanAmountCents: 12_500_000,
            jobsReported: 8,
          },
        ],
      },
      token
    );
    expect(first.status).toBe(200);
    const firstBody = importResultSchema.parse(await first.json());
    expect(firstBody.created).toBe(1);
    const customerId = firstBody.customers[0]!.id;

    const second = await post(
      `/workspaces/${organizationId}/intake/ppp-loans/import`,
      {
        loans: [
          // Same loanId — externalId dedupe.
          {
            loanId: "ppp-3000",
            businessName: "Duplex Diner",
            loanAmountCents: 12_500_000,
            jobsReported: 8,
          },
          // Same business + street, no id — name/address dedupe.
          {
            businessName: "DUPLEX DINER",
            address: "77 Nostrand Avenue",
            loanAmountCents: 12_500_000,
            jobsReported: 9,
          },
        ],
        // Custom ratio: payroll is half of revenue.
        payrollToRevenueRatio: 0.5,
      },
      token
    );
    expect(second.status).toBe(200);
    const secondBody = importResultSchema.parse(await second.json());
    expect(secondBody.imported).toBe(2);
    expect(secondBody.created).toBe(0);
    expect(secondBody.updated).toBe(2);
    expect(secondBody.customers.map((c) => c.id)).toEqual([
      customerId,
      customerId,
    ]);

    // $125,000 ÷ 2.5 = $50,000 payroll; ÷0.5 = $100,000/mo.
    const customerRes = await api(
      `/workspaces/${organizationId}/customers/${customerId}`,
      {},
      token
    );
    const customer = z
      .object({
        externalId: z.string().nullable(),
        customFields: z.record(z.string(), z.string()),
      })
      .parse(await customerRes.json());
    expect(customer.externalId).toBe("sba-ppp:ppp-3000");
    expect(customer.customFields.estMonthlyPayrollCents).toBe(
      "5_000_000".replace(/_/g, "")
    );
    expect(customer.customFields.monthly_card_volume_cents).toBe("10000000");
    expect(customer.customFields.jobsReported).toBe("9");
  });
});

describe("statement + loan helper units (PILE-656/PILE-659)", () => {
  it("parseStatementMetricsFromText reads labelled figures and tolerates junk", () => {
    const parsed = parseStatementMetricsFromText(
      [
        "CLOVER MERCHANT SERVICES",
        "Total Volume: $48,231.19",
        "Total Fees: $1,402.17",
        "Effective Rate: 2.91%",
      ].join("\n")
    );
    expect(parsed).toEqual({
      monthlyVolumeCents: 4_823_119,
      totalFeesCents: 140_217,
      effectiveRateBps: 291,
      processor: "Clover",
    });

    const gross = parseStatementMetricsFromText(
      "Monthly Volume $22,500\nGross Sales $22,500"
    );
    expect(gross.monthlyVolumeCents).toBe(2_250_000);

    const empty = parseStatementMetricsFromText("no figures here");
    expect(empty).toEqual({
      monthlyVolumeCents: null,
      totalFeesCents: null,
      effectiveRateBps: null,
      processor: null,
    });
  });

  it("vortexMerchantCustomFields writes measured figures under every canonical key", () => {
    const fields = vortexMerchantCustomFields({
      externalMerchantRef: "vm_x",
      monthlyVolumeCents: 6_000_000,
      totalFeesCents: 171_000,
      effectiveRateBps: 285,
      statementPeriod: "2026-09",
    });
    expect(fields.externalMerchantRef).toBe("vm_x");
    expect(fields.measuredMonthlyVolumeCents).toBe("6000000");
    expect(fields.estMonthlyVolumeCents).toBe("6000000");
    expect(fields.monthly_card_volume_cents).toBe("6000000");
    expect(fields.totalFeesCents).toBe("171000");
    expect(fields.effectiveRateBps).toBe("285");
    expect(fields.statementPeriod).toBe("2026-09");
    expect(fields.volumeSource).toBe("vortex_first_party_tpv");

    const junk = vortexMerchantCustomFields({
      externalMerchantRef: "vm_y",
      monthlyVolumeCents: Number.NaN,
    });
    expect("measuredMonthlyVolumeCents" in junk).toBe(false);
  });

  it("pppLoanEstimates reverses the 2.5x payroll sizing and skips 7(a)", () => {
    expect(
      pppLoanEstimates({ loanAmountCents: 25_000_000, loanType: "ppp" })
    ).toEqual({
      estMonthlyPayrollCents: 10_000_000,
      estMonthlyVolumeCents: 33_333_333,
    });
    expect(
      pppLoanEstimates({
        loanAmountCents: 25_000_000,
        payrollToRevenueRatio: 0.5,
      })
    ).toEqual({
      estMonthlyPayrollCents: 10_000_000,
      estMonthlyVolumeCents: 20_000_000,
    });
    expect(
      pppLoanEstimates({ loanAmountCents: 10_000_000, loanType: "7a" })
    ).toEqual({ estMonthlyPayrollCents: null, estMonthlyVolumeCents: null });
    expect(pppLoanEstimates({ loanAmountCents: null })).toEqual({
      estMonthlyPayrollCents: null,
      estMonthlyVolumeCents: null,
    });

    const fields = pppLoanCustomFields(
      {
        businessName: "X",
        loanId: "ppp-1",
        loanAmountDollars: 50_000,
        jobsReported: 5,
        naicsCode: "722511",
        loanType: "ppp",
      },
      0.3
    );
    expect(fields.pppLoanAmountCents).toBe("5000000");
    expect(fields.estMonthlyPayrollCents).toBe("2000000");
    expect(fields.monthly_card_volume_cents).toBe("6666667");
    expect(fields.jobsReported).toBe("5");
    expect(fields.inboundSource).toBe("sba_ppp");
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
