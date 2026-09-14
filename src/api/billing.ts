import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { usageRecords } from "../global/schema.js";
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
  usage: z.array(billingUsageItemSchema),
  total: z.number().int(),
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

    return c.json({
      organizationId,
      period,
      usage,
      total,
    });
  });
}
