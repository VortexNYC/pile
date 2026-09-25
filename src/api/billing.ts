import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { billingAccounts, usageRecords } from "../global/schema.js";
import {
  billingConfigured,
  ensureBillingCustomer,
} from "../global/vortex-billing.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const billingUsageItemSchema = z.object({
  resource: z.string(),
  action: z.string(),
  count: z.number().int(),
});

const billingResponseSchema = z.object({
  organizationId: z.string(),
  period: z.string(),
  plan: z.enum(["free", "paid"]),
  status: z.enum(["active", "past_due", "canceled"]),
  cap: z.number().int(),
  used: z.number().int(),
  remaining: z.number().int(),
  upgradeRequired: z.boolean(),
  upgradeUrl: z.string().optional(),
  usage: z.array(billingUsageItemSchema),
  total: z.number().int(),
});

const billingAccountSchema = z.object({
  organizationId: z.string(),
  plan: z.enum(["free", "paid"]),
  status: z.enum(["active", "past_due", "canceled"]),
  vortexCustomerId: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
});

const setPlanRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/billing/plan",
  tags: ["billing"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            plan: z.enum(["free", "paid"]),
            status: z.enum(["active", "past_due", "canceled"]).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated billing account",
      content: { "application/json": { schema: billingAccountSchema } },
    },
  },
});

const subscribeRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/billing/subscribe",
  tags: ["billing"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Subscribe to the paid plan",
      content: {
        "application/json": {
          schema: z.object({
            organizationId: z.string(),
            customerId: z.string().nullable(),
            upgradeUrl: z.string().nullable(),
          }),
        },
      },
    },
    503: {
      description: "Billing not configured",
      content: {
        "application/json": { schema: z.object({ error: z.string() }) },
      },
    },
  },
});

const getBillingRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/billing",
  tags: ["billing"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      period: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Billing usage for the workspace",
      content: {
        "application/json": { schema: billingResponseSchema },
      },
    },
  },
});

function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function registerBillingRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(getBillingRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { period = currentPeriod() } = c.req.valid("query");
    const db = createD1(c.env.D1);

    const rows = await db
      .select({
        resource: usageRecords.resource,
        action: usageRecords.action,
        count: sql<number>`sum(${usageRecords.count})`,
      })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.organizationId, organizationId),
          eq(usageRecords.period, period)
        )
      )
      .groupBy(usageRecords.resource, usageRecords.action)
      .all();

    const usage = rows.map((row) => ({
      resource: row.resource,
      action: row.action,
      count: Number(row.count),
    }));
    const total = usage.reduce((sum, item) => sum + item.count, 0);

    const account = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.organizationId, organizationId))
      .get();
    const plan = account?.plan ?? "free";
    const cap =
      plan === "paid" ? 0 : Math.max(0, Number(c.env.FREE_USE_CAP ?? 0));
    const used = total;
    const remaining =
      cap === 0 ? Number.MAX_SAFE_INTEGER : Math.max(0, cap - used);

    return c.json({
      organizationId,
      period,
      plan,
      status: account?.status ?? "active",
      cap,
      used,
      remaining,
      upgradeRequired: cap > 0 && used >= cap,
      upgradeUrl: c.env.BILLING_UPGRADE_URL || undefined,
      usage,
      total,
    });
  });

  app.openapi(subscribeRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);

    // Provisions (idempotently) the Vortex billing customer and links it
    // locally. Checkout sessions are pending on the Vortex side (VOR-577) —
    // until then the client follows upgradeUrl to the hosted subscribe page.
    const customerId = await ensureBillingCustomer(c.env, db, organizationId);
    if (!billingConfigured(c.env) && !customerId) {
      return c.json(
        { error: "Billing is not configured on this deployment" },
        503
      );
    }
    return c.json(
      {
        organizationId,
        customerId,
        upgradeUrl: c.env.BILLING_UPGRADE_URL ?? null,
      },
      200
    );
  });

  app.openapi(setPlanRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const ts = new Date().toISOString();

    const existing = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.organizationId, organizationId))
      .get();

    if (existing) {
      await db
        .update(billingAccounts)
        .set({
          plan: input.plan,
          status: input.status ?? existing.status,
          updatedAt: ts,
        })
        .where(eq(billingAccounts.organizationId, organizationId));
    } else {
      await db.insert(billingAccounts).values({
        organizationId,
        plan: input.plan,
        status: input.status ?? "active",
        createdAt: ts,
        updatedAt: ts,
      });
    }

    const row = await db
      .select()
      .from(billingAccounts)
      .where(eq(billingAccounts.organizationId, organizationId))
      .get();

    return c.json(
      {
        organizationId,
        plan: row!.plan,
        status: row!.status,
        vortexCustomerId: row!.vortexCustomerId,
        currentPeriodEnd: row!.currentPeriodEnd,
      },
      200
    );
  });
}
