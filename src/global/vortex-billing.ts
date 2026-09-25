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
    data?: VortexCustomer[] | VortexCustomer;
  };
  const data = body.data;
  if (Array.isArray(data)) {
    return data[0] ?? null;
  }
  return data ?? null;
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
        defaultCurrency: "usd",
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

  const ts = new Date().toISOString();
  await db
    .insert(billingAccounts)
    .values({
      organizationId,
      vortexCustomerId: customerId,
      vortexBillingAccountId: customer?.billingAccountId ?? null,
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: billingAccounts.organizationId,
      set: {
        vortexCustomerId: customerId,
        vortexBillingAccountId: customer?.billingAccountId ?? null,
        updatedAt: ts,
      },
    });
  return customerId;
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
      billingAccountId: account.vortexBillingAccountId ?? undefined,
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
