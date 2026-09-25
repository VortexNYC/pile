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

type VortexCustomer = {
  customerId?: string;
  billingAccountId?: string;
};

async function findCustomerByRef(
  env: AppEnv,
  externalCustomerRef: string
): Promise<VortexCustomer | null> {
  const url = `${env.VORTEX_BILLING_API_URL}/v1/customers?externalCustomerRef=${encodeURIComponent(externalCustomerRef)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.VORTEX_BILLING_API_KEY}` },
  });
  if (!res.ok) {
    return null;
  }
  const body = (await res.json()) as {
    // List responses nest under data.items; a bare object is a single record.
    data?: { items?: VortexCustomer[] } | VortexCustomer[];
  };
  const data = body.data;
  if (Array.isArray(data)) {
    return data[0] ?? null;
  }
  return data?.items?.[0] ?? null;
}

async function ensureBillingAccountId(
  env: AppEnv,
  customerId: string,
  organizationId: string
): Promise<string | null> {
  const base = env.VORTEX_BILLING_API_URL;
  const headers = {
    Authorization: `Bearer ${env.VORTEX_BILLING_API_KEY}`,
    "Content-Type": "application/json",
  };
  const envParam = `environment=${env.VORTEX_BILLING_ENV ?? "production"}&merchantAccountId=${env.VORTEX_BILLING_MERCHANT_ID}`;
  const list = await fetch(
    `${base}/v1/customers/${customerId}/billing-accounts?${envParam}`,
    { headers }
  );
  if (list.ok) {
    const body = (await list.json()) as {
      data?: { items?: Array<{ billingAccountId?: string }> };
    };
    const id = body.data?.items?.[0]?.billingAccountId;
    if (id) {
      return id;
    }
  }
  // None exists yet — create a minimal manual-collection account so usage
  // events have a billingAccountId to hang off.
  const res = await fetch(
    `${base}/v1/customers/${customerId}/billing-accounts`,
    {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": `pile-ba-${organizationId}` },
      body: JSON.stringify({
        environment: env.VORTEX_BILLING_ENV ?? "production",
        merchantAccountId: env.VORTEX_BILLING_MERCHANT_ID,
        customerId,
        invoiceDeliveryMode: "api_only",
        collectionMode: "manual",
        autoCollectionEnabled: false,
      }),
    }
  );
  if (!res.ok) {
    return null;
  }
  const body = (await res.json()) as {
    data?: { billingAccountId?: string };
  };
  return body.data?.billingAccountId ?? null;
}

/**
 * Provision the Vortex billing customer keyed by Pile org id
 * (externalCustomerRef is the join key). Vortex has no upsert — create 409s
 * on collision — so we look up by ref first and again on conflict. Returns
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

  let customer = await findCustomerByRef(env, organizationId);
  if (!customer?.customerId) {
    const res = await fetch(`${env.VORTEX_BILLING_API_URL}/v1/customers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.VORTEX_BILLING_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `pile-customer-${organizationId}`,
      },
      body: JSON.stringify({
        environment: env.VORTEX_BILLING_ENV ?? "production",
        merchantAccountId: env.VORTEX_BILLING_MERCHANT_ID,
        name: organizationId,
        defaultCurrency: "USD",
        externalCustomerRef: organizationId,
        metadata: { source: "pile", orgId: organizationId },
      }),
    });
    if (res.status === 409) {
      customer = await findCustomerByRef(env, organizationId);
    } else if (res.ok) {
      const body = (await res.json()) as { data?: VortexCustomer };
      customer = body.data ?? null;
    } else {
      throw new Error(`vortex customers: ${res.status}`);
    }
  }
  const customerId = customer?.customerId;
  if (!customerId) {
    throw new Error("vortex customers: empty customerId");
  }

  // The customer payload doesn't carry a billing account — resolve one
  // separately so usage events can satisfy the contract.
  const billingAccountId = await ensureBillingAccountId(
    env,
    customerId,
    organizationId
  );

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
  if (!account?.vortexCustomerId || !account.vortexBillingAccountId) {
    return null;
  }
  const res = await fetch(
    `${env.VORTEX_BILLING_API_URL}/v1/checkout/sessions`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.VORTEX_BILLING_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `pile-checkout-${organizationId}-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        environment: env.VORTEX_BILLING_ENV ?? "production",
        merchantAccountId: env.VORTEX_BILLING_MERCHANT_ID,
        mode: "subscription",
        customerId: account.vortexCustomerId,
        billingAccountId: account.vortexBillingAccountId,
        items: [{ priceId, quantity: 1 }],
      }),
    }
  );
  if (!res.ok) {
    return null;
  }
  const body = (await res.json()) as {
    data?: { checkoutSession?: { checkoutUrl?: string } };
  };
  return body.data?.checkoutSession?.checkoutUrl ?? null;
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
  const idempotencyKey = `pile-usage-${crypto.randomUUID()}`;
  const res = await fetch(`${env.VORTEX_BILLING_API_URL}/v1/usage-events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.VORTEX_BILLING_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      environment: env.VORTEX_BILLING_ENV ?? "production",
      merchantAccountId: env.VORTEX_BILLING_MERCHANT_ID,
      customerId: account.vortexCustomerId,
      billingAccountId: billingAccountId ?? undefined,
      meterId: env.VORTEX_BILLING_METER_ID,
      eventName: "usage",
      quantity: 1,
      occurredAt: new Date().toISOString(),
      idempotencyKey,
      metadata,
    }),
  });
  if (!res.ok) {
    throw new Error(`vortex usage-events: ${res.status}`);
  }
}
