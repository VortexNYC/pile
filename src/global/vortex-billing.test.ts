import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../types/env.js";
import { createD1 } from "./db.js";
import { billingAccounts, organization } from "./schema.js";
import {
  createCheckoutSession,
  ensureBillingCustomer,
  submitUsageEvent,
} from "./vortex-billing.js";

const vortexEnv = {
  ...env,
  VORTEX_BILLING_API_URL: "https://api.vortex.test",
  VORTEX_BILLING_API_KEY: "vp_test_key",
  VORTEX_BILLING_MERCHANT_ID: "macc_test",
  VORTEX_BILLING_ENV: "sandbox",
  VORTEX_BILLING_METER_ID: "meter_pile_usage",
  VORTEX_BILLING_PRICE_ID: "bprice_paid_monthly",
} as AppEnv;

type CapturedRequest = {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
};

function captureFetch(
  respond: (req: CapturedRequest) => { status?: number; body: unknown }
): CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const body =
        typeof init.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : (init.body ?? null);
      calls.push({
        url,
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body,
      });
      const r = respond(calls[calls.length - 1]!);
      return new Response(JSON.stringify(r.body), {
        status: r.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  );
  return calls;
}

async function seedOrg(): Promise<string> {
  const db = createD1(env.D1);
  const id = `org_${crypto.randomUUID()}`;
  await db.insert(organization).values({
    id,
    name: "Vortex billing test",
    slug: `vortex-${crypto.randomUUID()}`,
  });
  return id;
}

async function linkAccount(
  organizationId: string,
  customerId = "bcust_1",
  billingAccountId: string | null = "bacc_1"
): Promise<void> {
  const db = createD1(env.D1);
  const ts = new Date().toISOString();
  await db.insert(billingAccounts).values({
    organizationId,
    vortexCustomerId: customerId,
    vortexBillingAccountId: billingAccountId,
    createdAt: ts,
    updatedAt: ts,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureBillingCustomer", () => {
  it("sends CustomerEnsureRequest with scope in query params, not the body", async () => {
    const calls = captureFetch(() => ({
      status: 200,
      body: {
        data: { customerId: "bcust_1", billingAccountId: "bacc_1" },
        requestId: "req_1",
      },
    }));
    const organizationId = await seedOrg();
    const db = createD1(env.D1);

    const customerId = await ensureBillingCustomer(
      vortexEnv,
      db,
      organizationId
    );
    expect(customerId).toBe("bcust_1");

    // ensure response carried the billing account → no /state fallback.
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    const url = new URL(req.url);
    expect(url.pathname).toBe("/v1/customers");
    expect(url.searchParams.get("environment")).toBe("sandbox");
    expect(url.searchParams.get("merchantAccountId")).toBe("macc_test");
    expect(req.method).toBe("PUT");
    expect(req.headers.get("Authorization")).toBe("Bearer vp_test_key");
    expect(req.headers.get("Idempotency-Key")).toBe(
      `pile-customer-${organizationId}`
    );
    expect(req.body).toEqual({
      name: organizationId,
      defaultCurrency: "USD",
      externalCustomerRef: organizationId,
      metadata: { source: "pile", orgId: organizationId },
    });

    const row = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.organizationId, organizationId))
      .get();
    expect(row?.vortexCustomerId).toBe("bcust_1");
    expect(row?.vortexBillingAccountId).toBe("bacc_1");
  });

  it("resolves the billing account from customer state when the ensure response omits it", async () => {
    const calls = captureFetch((req) => {
      if (req.url.includes("/state")) {
        return {
          status: 200,
          body: {
            data: { billingAccounts: [{ billingAccountId: "bacc_state" }] },
            requestId: "req_2",
          },
        };
      }
      return {
        status: 200,
        body: { data: { customerId: "bcust_2" }, requestId: "req_1" },
      };
    });
    const organizationId = await seedOrg();
    const db = createD1(env.D1);

    await ensureBillingCustomer(vortexEnv, db, organizationId);
    expect(calls).toHaveLength(2);
    const stateUrl = new URL(calls[1]!.url);
    expect(stateUrl.pathname).toBe("/v1/customers/bcust_2/state");
    expect(stateUrl.searchParams.get("environment")).toBe("sandbox");
    expect(stateUrl.searchParams.get("merchantAccountId")).toBe("macc_test");

    const row = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.organizationId, organizationId))
      .get();
    expect(row?.vortexBillingAccountId).toBe("bacc_state");
  });
});

describe("submitUsageEvent", () => {
  it("posts UsageEventCreateRequest — exactly the required fields plus metadata", async () => {
    const organizationId = await seedOrg();
    await linkAccount(organizationId, "bcust_9", "bacc_9");
    const calls = captureFetch(() => ({
      status: 201,
      body: { data: {}, requestId: "req_1" },
    }));
    const db = createD1(env.D1);

    await submitUsageEvent(vortexEnv, db, organizationId, {
      resource: "issues",
      action: "create",
    });

    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    const url = new URL(req.url);
    expect(url.pathname).toBe("/v1/usage-events");
    expect(url.searchParams.get("environment")).toBe("sandbox");
    expect(url.searchParams.get("merchantAccountId")).toBe("macc_test");
    expect(req.method).toBe("POST");

    const body = req.body as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(
      [
        "customerId",
        "billingAccountId",
        "meterId",
        "eventName",
        "quantity",
        "occurredAt",
        "idempotencyKey",
        "metadata",
      ].toSorted()
    );
    expect(body).toMatchObject({
      customerId: "bcust_9",
      billingAccountId: "bacc_9",
      meterId: "meter_pile_usage",
      eventName: "usage",
      quantity: 1,
      metadata: { resource: "issues", action: "create" },
    });
    expect(typeof body.occurredAt).toBe("string");
    expect(req.headers.get("Idempotency-Key")).toBe(body.idempotencyKey);
    // forbidden-by-schema fields must not appear anywhere
    expect(body).not.toHaveProperty("environment");
    expect(body).not.toHaveProperty("merchantAccountId");
  });

  it("skips the event when no billingAccountId is resolvable", async () => {
    const organizationId = await seedOrg();
    await linkAccount(organizationId, "bcust_10", null);
    const calls = captureFetch(() => ({
      status: 200,
      body: { data: {}, requestId: "req_1" },
    }));
    const db = createD1(env.D1);

    await submitUsageEvent(vortexEnv, db, organizationId, {
      resource: "issues",
      action: "create",
    });

    // it probed customer state for an account but never posted the event
    expect(calls.some((c) => c.url.includes("/state"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/usage-events"))).toBe(false);
  });
});

describe("createCheckoutSession", () => {
  it("sends customerExternalId + lineItems and returns the hosted checkoutUrl", async () => {
    const organizationId = await seedOrg();
    await linkAccount(organizationId, "bcust_9", "bacc_9");
    const calls = captureFetch(() => ({
      status: 201,
      body: {
        data: {
          checkoutSessionId: "cs_1",
          checkoutUrl: "https://pay.vortex.test/checkout/cs_1?token=t_1",
        },
        requestId: "req_1",
      },
    }));
    const db = createD1(env.D1);

    const checkoutUrl = await createCheckoutSession(
      vortexEnv,
      db,
      organizationId
    );
    expect(checkoutUrl).toBe("https://pay.vortex.test/checkout/cs_1?token=t_1");

    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    const url = new URL(req.url);
    expect(url.pathname).toBe("/v1/checkout/sessions");
    expect(url.searchParams.get("environment")).toBe("sandbox");
    expect(url.searchParams.get("merchantAccountId")).toBe("macc_test");
    expect(req.method).toBe("POST");
    expect(req.headers.get("Idempotency-Key")).toMatch(/^pile-checkout-/);

    const body = req.body as Record<string, unknown>;
    expect(body).toEqual({
      mode: "subscription",
      customerExternalId: organizationId,
      billingAccountId: "bacc_9",
      lineItems: [{ priceId: "bprice_paid_monthly", quantity: 1 }],
      metadata: { source: "pile", orgId: organizationId },
    });
    expect(body).not.toHaveProperty("customerId");
    expect(body).not.toHaveProperty("items");
    expect(body).not.toHaveProperty("environment");
    expect(body).not.toHaveProperty("merchantAccountId");
  });
});
