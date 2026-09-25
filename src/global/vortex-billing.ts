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
 * Provision the Vortex billing customer keyed by Pile org id
 * (externalCustomerRef is the join key). Idempotent — the Idempotency-Key is
 * deterministic per org, matching the Veil client's contract. Returns the
 * Vortex customerId, or null when billing envs aren't configured.
 */
export async function ensureBillingCustomer(
  env: AppEnv,
  db: D1Client,
  organizationId: string
): Promise<string | null> {
  const existing = await db
    .select({ vortexCustomerId: billingAccounts.vortexCustomerId })
    .from(billingAccounts)
    .where(eq(billingAccounts.organizationId, organizationId))
    .get();
  if (existing?.vortexCustomerId) {
    return existing.vortexCustomerId;
  }
  if (!billingConfigured(env)) {
    return null;
  }

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
  if (!res.ok) {
    throw new Error(`vortex customers: ${res.status}`);
  }
  const body = (await res.json()) as { data?: { customerId?: string } };
  const customerId = body.data?.customerId;
  if (!customerId) {
    throw new Error("vortex customers: empty customerId");
  }

  const ts = new Date().toISOString();
  await db
    .insert(billingAccounts)
    .values({
      organizationId,
      vortexCustomerId: customerId,
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: billingAccounts.organizationId,
      set: { vortexCustomerId: customerId, updatedAt: ts },
    });
  return customerId;
}
