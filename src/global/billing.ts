import { eq, sql } from "drizzle-orm";

import { VortexError } from "../platform/errors.js";
import type { AppEnv } from "../types/env.js";
import type { D1Client } from "./db.js";
import { billingAccounts, usageRecords } from "./schema.js";
import { submitUsageEvent } from "./vortex-billing.js";

export function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function getBillingPlan(
  db: D1Client,
  organizationId: string
): Promise<"free" | "paid"> {
  const row = await db
    .select({ plan: billingAccounts.plan })
    .from(billingAccounts)
    .where(eq(billingAccounts.organizationId, organizationId))
    .get();
  return row?.plan ?? "free";
}

/**
 * Consume n usage units for the org in the current period. Free plans are
 * capped at freeUseCap units per month across all resources (sum of counts);
 * cap <= 0 disables metering entirely — the call always succeeds. Over-cap
 * throws USAGE_LIMIT so callers fail closed at the value boundary.
 */
export async function consumeUsage(
  db: D1Client,
  organizationId: string,
  resource: string,
  action: string,
  freeUseCap: number,
  count = 1,
  env?: AppEnv,
  ctx?: { waitUntil(promise: Promise<unknown>): void }
): Promise<void> {
  // Pile counts + enforces locally; Vortex owns recording/rating. Submitted
  // fire-and-forget after the gate passes — failure must never block a request.
  const submit = () => {
    if (!env) {
      return;
    }
    const p = submitUsageEvent(env, db, organizationId, { resource, action });
    const safe = p.catch(() => {});
    if (ctx) {
      ctx.waitUntil(safe);
    } else {
      void safe;
    }
  };
  if (freeUseCap <= 0) {
    submit();
    return;
  }
  const plan = await getBillingPlan(db, organizationId);
  if (plan !== "free") {
    submit();
    return;
  }
  const period = currentPeriod();
  const ts = new Date().toISOString();
  const underCap = sql`(${sql.param(freeUseCap)} <= 0 OR (SELECT coalesce(sum(${usageRecords.count}),0) FROM ${usageRecords} WHERE ${usageRecords.organizationId} = ${organizationId} AND ${usageRecords.period} = ${period}) + ${count} <= ${freeUseCap})`;

  const updated = await db.run(sql`
    UPDATE usage_records SET count = count + ${count}, updated_at = ${ts}
    WHERE organization_id = ${organizationId} AND period = ${period}
      AND resource = ${resource} AND action = ${action} AND ${underCap}
  `);
  let changes = updated.meta.changes;
  if (changes === 0) {
    const inserted = await db.run(sql`
      INSERT INTO usage_records (id, organization_id, period, resource, action, count, created_at, updated_at)
      SELECT ${crypto.randomUUID()}, ${organizationId}, ${period}, ${resource}, ${action}, ${count}, ${ts}, ${ts}
      WHERE NOT EXISTS (
        SELECT 1 FROM usage_records
        WHERE organization_id = ${organizationId} AND period = ${period}
          AND resource = ${resource} AND action = ${action}
      ) AND ${underCap}
    `);
    changes = inserted.meta.changes;
  }
  if (changes === 0) {
    throw new VortexError({
      code: "USAGE_LIMIT",
      status: 402,
      message:
        "Free tier usage limit reached for this period. Subscribe to continue.",
    });
  }
  submit();
}
