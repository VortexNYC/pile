import { eq } from "drizzle-orm";

import type { AppEnv } from "../types/env.js";
import type { D1Client } from "./db.js";
import { billingAccounts } from "./schema.js";

export function billingConfigured(env: AppEnv): boolean {
  return Boolean(
    env.VORTEX_BILLING_API_URL &&
    env.VORTEX_BILLING_API_KEY &&
    env.VORTEX_BILLING_MERCHANT_ID
  );
}

/**
 * Vortex scopes every /v1 route by `environment` + `merchantAccountId` as
 * REQUIRED QUERY PARAMETERS — never body fields. The request schemas are
 * `additionalProperties: false`, so sending them in the body 400s, and
 * omitting them from the query 400s on missing required params.
 */
function scopeQuery(env: AppEnv): string {
  return new URLSearchParams({
    environment: env.VORTEX_BILLING_ENV ?? "production",
    merchantAccountId: env.VORTEX_BILLING_MERCHANT_ID ?? "",
  }).toString();
}

function authHeaders(
  env: AppEnv,
  idempotencyKey?: string
): Record<string, string> {
  return {
    Authorization: `Bearer ${env.VORTEX_BILLING_API_KEY}`,
    "Content-Type": "application/json",
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined),
  };
}

/** All Vortex responses wrap the resource in `{ data, requestId }`. */
type VortexEnvelope = { data?: Record<string, unknown> };

function stringField(
  data: Record<string, unknown>,
  key: string
): string | null {
  const v = data[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Pull a billingAccountId out of a Vortex `data` payload. The spec types
 * `data` as a freeform object (ApiWriteEnvelope), so probe the shapes the
 * customer/state payloads actually use: a flat id, a `defaultBillingAccountId`
 * alias, a `billingAccounts[]` collection, or a nested `billingAccount`.
 */
function billingAccountIdFrom(
  data: Record<string, unknown> | undefined
): string | null {
  if (!data) {
    return null;
  }
  const flat =
    stringField(data, "billingAccountId") ??
    stringField(data, "defaultBillingAccountId");
  if (flat) {
    return flat;
  }
  const list = data.billingAccounts;
  if (Array.isArray(list)) {
    for (const item of list) {
      if (item && typeof item === "object") {
        const id = stringField(
          item as Record<string, unknown>,
          "billingAccountId"
        );
        if (id) {
          return id;
        }
      }
    }
  }
  const nested = data.billingAccount;
  if (nested && typeof nested === "object") {
    return stringField(nested as Record<string, unknown>, "billingAccountId");
  }
  return null;
}

function customerIdFrom(
  data: Record<string, unknown> | undefined
): string | null {
  if (!data) {
    return null;
  }
  const flat = stringField(data, "customerId");
  if (flat) {
    return flat;
  }
  const nested = data.customer;
  if (nested && typeof nested === "object") {
    return stringField(nested as Record<string, unknown>, "customerId");
  }
  return null;
}

/**
 * Resolve the customer's billing account. The live spec has NO
 * /v1/customers/{id}/billing-accounts collection — the ensure-upsert
 * auto-provisions one, and `GET /v1/customers/{id}/state` is the
 * customer-scoped read that exposes billing state. Returns null when no
 * account is resolvable yet.
 */
async function ensureBillingAccountId(
  env: AppEnv,
  customerId: string,
  organizationId: string
): Promise<string | null> {
  const res = await fetch(
    `${env.VORTEX_BILLING_API_URL}/v1/customers/${customerId}/state?${scopeQuery(env)}`,
    { headers: authHeaders(env) }
  );
  if (!res.ok) {
    console.warn("vortex customer state lookup failed", {
      organizationId,
      customerId,
      status: res.status,
    });
    return null;
  }
  const body = (await res.json()) as VortexEnvelope;
  return billingAccountIdFrom(body.data);
}

/**
 * Provision the Vortex billing customer keyed by Pile org id
 * (externalCustomerRef is the join key). PUT /v1/customers is an
 * ensure-upsert — repeat calls return the same customer. Returns
 * the Vortex customerId, or null when billing envs aren't configured.
 */
export async function ensureBillingCustomer(
  env: AppEnv,
  db: D1Client,
  organizationId: string
): Promise<string | null> {
  const existing = await db
    .select({
      vortexCustomerId: billingAccounts.vortexCustomerId,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.organizationId, organizationId))
    .get();
  if (existing?.vortexCustomerId) {
    return existing.vortexCustomerId;
  }
  if (!billingConfigured(env)) {
    return null;
  }

  // PUT /v1/customers is the ensure-upsert (CustomerEnsureRequest): dedupes
  // on externalCustomerRef first, returns the same customerId on repeat calls.
  // environment + merchantAccountId ride the query string — the body schema
  // rejects them.
  const res = await fetch(
    `${env.VORTEX_BILLING_API_URL}/v1/customers?${scopeQuery(env)}`,
    {
      method: "PUT",
      headers: authHeaders(env, `pile-customer-${organizationId}`),
      body: JSON.stringify({
        name: organizationId,
        defaultCurrency: "USD",
        externalCustomerRef: organizationId,
        metadata: { source: "pile", orgId: organizationId },
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`vortex customers: ${res.status}`);
  }
  const body = (await res.json()) as VortexEnvelope;
  const customerId = customerIdFrom(body.data);
  if (!customerId) {
    throw new Error("vortex customers: empty customerId");
  }

  // The ensure response may carry the auto-provisioned billing account;
  // otherwise resolve it from customer state so usage events can satisfy
  // the required billingAccountId.
  const billingAccountId =
    billingAccountIdFrom(body.data) ??
    (await ensureBillingAccountId(env, customerId, organizationId));

  const ts = new Date().toISOString();
  await db
    .insert(billingAccounts)
    .values({
      organizationId,
      vortexCustomerId: customerId,
      vortexBillingAccountId: billingAccountId,
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: billingAccounts.organizationId,
      set: {
        vortexCustomerId: customerId,
        vortexBillingAccountId: billingAccountId,
        updatedAt: ts,
      },
    });
  return customerId;
}

/**
 * Re-provision the billing link when the persisted customerId is stale —
 * Vortex returns 404 "billing customer X not found" for ids that were
 * provisioned under a different merchant/api-key scope (credentials rotate,
 * sandbox orgs get recreated). A PUT /v1/customers ensure-upsert keyed on
 * externalCustomerRef returns the real customer, which we persist over the
 * stale link.
 */
async function relinkBillingCustomer(
  env: AppEnv,
  db: D1Client,
  organizationId: string
): Promise<{ vortexCustomerId: string; vortexBillingAccountId: string | null } | null> {
  const res = await fetch(
    `${env.VORTEX_BILLING_API_URL}/v1/customers?${scopeQuery(env)}`,
    {
      method: "PUT",
      headers: authHeaders(env, `pile-relink-${organizationId}`),
      body: JSON.stringify({
        name: organizationId,
        defaultCurrency: "USD",
        externalCustomerRef: organizationId,
        metadata: { source: "pile", orgId: organizationId },
      }),
    }
  );
  if (!res.ok) {
    return null;
  }
  const body = (await res.json()) as VortexEnvelope;
  const customerId = customerIdFrom(body.data);
  if (!customerId) {
    return null;
  }
  const billingAccountId =
    billingAccountIdFrom(body.data) ??
    (await ensureBillingAccountId(env, customerId, organizationId));
  await db
    .update(billingAccounts)
    .set({
      vortexCustomerId: customerId,
      vortexBillingAccountId: billingAccountId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(billingAccounts.organizationId, organizationId));
  return { vortexCustomerId: customerId, vortexBillingAccountId: billingAccountId };
}

/**
 * Create a Vortex checkout session for a subscription to the configured plan
 * price. Returns the hosted checkout URL, or null when the org isn't linked
 * or the call fails — callers fall back to a static upgrade URL.
 */
export async function createCheckoutSession(
  env: AppEnv,
  db: D1Client,
  organizationId: string
): Promise<string | null> {
  const priceId = env.VORTEX_BILLING_PRICE_ID;
  if (!billingConfigured(env) || !priceId) {
    return null;
  }
  const account = await db
    .select({
      vortexCustomerId: billingAccounts.vortexCustomerId,
      vortexBillingAccountId: billingAccounts.vortexBillingAccountId,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.organizationId, organizationId))
    .get();
  if (!account?.vortexCustomerId) {
    return null;
  }
  const sendCheckout = (customerId: string, billingAccountId: string | null) =>
    fetch(
      `${env.VORTEX_BILLING_API_URL}/v1/checkout/sessions?${scopeQuery(env)}`,
      {
        method: "POST",
        headers: authHeaders(
          env,
          `pile-checkout-${organizationId}-${crypto.randomUUID()}`
        ),
        // Runtime-verified against api.vortex.nyc (PILE-166): the live
        // validator wants `customerId` + `items` — the spec's
        // `customerExternalId`/`lineItems` are rejected with a bare 400.
        body: JSON.stringify({
          mode: "subscription",
          customerId,
          billingAccountId: billingAccountId ?? undefined,
          items: [{ priceId, quantity: 1 }],
          metadata: { source: "pile", orgId: organizationId },
        }),
      }
    );

  let res = await sendCheckout(
    account.vortexCustomerId,
    account.vortexBillingAccountId
  );
  if (res.status === 404) {
    // Stale customer link (provisioned under a different merchant/key) —
    // ensure-upsert returns the real customer; retry once with it.
    const relinked = await relinkBillingCustomer(env, db, organizationId);
    if (!relinked) {
      return null;
    }
    res = await sendCheckout(
      relinked.vortexCustomerId,
      relinked.vortexBillingAccountId
    );
  }
  if (!res.ok) {
    return null;
  }
  const body = (await res.json()) as VortexEnvelope;
  // checkoutUrl is a bearer secret returned only on the create response.
  const data = body.data;
  if (!data) {
    return null;
  }
  const flat = stringField(data, "checkoutUrl");
  if (flat) {
    return flat;
  }
  for (const key of ["session", "checkoutSession"]) {
    const nested = data[key];
    if (nested && typeof nested === "object") {
      const url = stringField(nested as Record<string, unknown>, "checkoutUrl");
      if (url) {
        return url;
      }
    }
  }
  return null;
}

/**
 * Submit one metered usage event to Vortex's /v1/usage-events. Fire-and-forget
 * — callers pass executionCtx so the request outlives the response. No-ops
 * unless billing envs + a meter id are configured and the org has a linked
 * Vortex customer. Each call is a distinct event (Vortex dedups on
 * idempotencyKey; a fresh UUID per event is correct since our local counter
 * already dedups the operation).
 */
export async function submitUsageEvent(
  env: AppEnv,
  db: D1Client,
  organizationId: string,
  metadata: Record<string, string>
): Promise<void> {
  if (!billingConfigured(env) || !env.VORTEX_BILLING_METER_ID) {
    return;
  }
  const account = await db
    .select({
      vortexCustomerId: billingAccounts.vortexCustomerId,
      vortexBillingAccountId: billingAccounts.vortexBillingAccountId,
    })
    .from(billingAccounts)
    .where(eq(billingAccounts.organizationId, organizationId))
    .get();
  if (!account?.vortexCustomerId) {
    return;
  }
  // Billing account can lag customer link (rows written before account
  // resolution existed) — resolve lazily and persist.
  let billingAccountId = account.vortexBillingAccountId;
  if (!billingAccountId) {
    billingAccountId = await ensureBillingAccountId(
      env,
      account.vortexCustomerId,
      organizationId
    );
    if (billingAccountId) {
      await db
        .update(billingAccounts)
        .set({
          vortexBillingAccountId: billingAccountId,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(billingAccounts.organizationId, organizationId));
    }
  }
  // billingAccountId is a REQUIRED field on UsageEventCreateRequest — an
  // event without it can never be accepted, so skip with a log rather than
  // send a guaranteed-400 body.
  if (!billingAccountId) {
    console.warn("vortex usage-events skipped: no billingAccountId", {
      organizationId,
      customerId: account.vortexCustomerId,
    });
    return;
  }
  const idempotencyKey = `pile-usage-${crypto.randomUUID()}`;
  const res = await fetch(
    `${env.VORTEX_BILLING_API_URL}/v1/usage-events?${scopeQuery(env)}`,
    {
      method: "POST",
      headers: authHeaders(env, idempotencyKey),
      // UsageEventCreateRequest — exactly these fields; environment and
      // merchantAccountId are query params, not body fields.
      body: JSON.stringify({
        customerId: account.vortexCustomerId,
        billingAccountId,
        meterId: env.VORTEX_BILLING_METER_ID,
        eventName: "usage",
        quantity: 1,
        occurredAt: new Date().toISOString(),
        idempotencyKey,
        metadata,
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`vortex usage-events: ${res.status}`);
  }
}
