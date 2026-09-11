import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, count, eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import {
  apikey,
  supportCustomers,
  supportTickets,
  webhookDeliveries,
} from "../global/schema.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const metricsSchema = z.object({
  supportTickets: z.object({
    total: z.number(),
    open: z.number(),
    done: z.number(),
    snoozed: z.number(),
  }),
  supportCustomers: z.object({
    total: z.number(),
  }),
  webhookDeliveries: z.object({
    total: z.number(),
    pending: z.number(),
    processing: z.number(),
    completed: z.number(),
    failed: z.number(),
  }),
  tokens: z.object({
    total: z.number(),
  }),
});

function toNumber(value: { n: number | string } | undefined): number {
  return Number(value?.n ?? 0);
}

const getMetricsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/observability/metrics",
  tags: ["observability"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Workspace metrics",
      content: {
        "application/json": { schema: metricsSchema },
      },
    },
  },
});

export function registerObservabilityRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(getMetricsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);

    const orgFilter = eq(supportTickets.organizationId, organizationId);
    const total = await db
      .select({ n: count() })
      .from(supportTickets)
      .where(orgFilter)
      .get();
    const open = await db
      .select({ n: count() })
      .from(supportTickets)
      .where(and(orgFilter, eq(supportTickets.status, "todo")))
      .get();
    const done = await db
      .select({ n: count() })
      .from(supportTickets)
      .where(and(orgFilter, eq(supportTickets.status, "done")))
      .get();
    const snoozed = await db
      .select({ n: count() })
      .from(supportTickets)
      .where(and(orgFilter, eq(supportTickets.status, "snoozed")))
      .get();

    const customers = await db
      .select({ n: count() })
      .from(supportCustomers)
      .where(eq(supportCustomers.organizationId, organizationId))
      .get();

    const deliveryFilter = eq(webhookDeliveries.organizationId, organizationId);
    const deliveryTotal = await db
      .select({ n: count() })
      .from(webhookDeliveries)
      .where(deliveryFilter)
      .get();
    const pending = await db
      .select({ n: count() })
      .from(webhookDeliveries)
      .where(and(deliveryFilter, eq(webhookDeliveries.status, "pending")))
      .get();
    const processing = await db
      .select({ n: count() })
      .from(webhookDeliveries)
      .where(and(deliveryFilter, eq(webhookDeliveries.status, "processing")))
      .get();
    const completed = await db
      .select({ n: count() })
      .from(webhookDeliveries)
      .where(and(deliveryFilter, eq(webhookDeliveries.status, "completed")))
      .get();
    const failed = await db
      .select({ n: count() })
      .from(webhookDeliveries)
      .where(and(deliveryFilter, eq(webhookDeliveries.status, "failed")))
      .get();

    const apiKeyRows = await db.select().from(apikey).all();
    const apiKeyMetadataSchema = z.object({
      organizationId: z.string(),
      permissions: z.string(),
    });
    const workspaceKeys = apiKeyRows.filter((row) => {
      if (!row.metadata) return false;
      try {
        const parsed = apiKeyMetadataSchema.parse(JSON.parse(row.metadata));
        return parsed.organizationId === organizationId;
      } catch {
        return false;
      }
    });

    return c.json({
      supportTickets: {
        total: toNumber(total),
        open: toNumber(open),
        done: toNumber(done),
        snoozed: toNumber(snoozed),
      },
      supportCustomers: {
        total: toNumber(customers),
      },
      webhookDeliveries: {
        total: toNumber(deliveryTotal),
        pending: toNumber(pending),
        processing: toNumber(processing),
        completed: toNumber(completed),
        failed: toNumber(failed),
      },
      tokens: {
        total: workspaceKeys.length,
      },
    });
  });
}
