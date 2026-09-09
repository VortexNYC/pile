import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, sql } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { usageRecords } from "../global/schema.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const usageRecordSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  period: z.string(),
  resource: z.string(),
  action: z.string(),
  count: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const recordUsageBodySchema = z.object({
  period: z.string().min(1),
  resource: z.string().min(1),
  action: z.string().min(1),
  count: z.number().int().min(0).default(1),
});

const listUsageRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/usage",
  tags: ["usage"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      period: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Usage records",
      content: {
        "application/json": {
          schema: z.object({ usage: z.array(usageRecordSchema) }),
        },
      },
    },
  },
});

const recordUsageRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/usage",
  tags: ["usage"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: { "application/json": { schema: recordUsageBodySchema } },
    },
  },
  responses: {
    201: {
      description: "Usage recorded",
      content: { "application/json": { schema: usageRecordSchema } },
    },
  },
});

function toUsageResponse(row: typeof usageRecords.$inferSelect) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    period: row.period,
    resource: row.resource,
    action: row.action,
    count: row.count,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function registerUsageRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listUsageRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const db = createD1(c.env.D1);
    const conditions = [eq(usageRecords.organizationId, organizationId)];
    if (query.period) {
      conditions.push(eq(usageRecords.period, query.period));
    }
    const rows = await db
      .select()
      .from(usageRecords)
      .where(and(...conditions))
      .all();
    return c.json({ usage: rows.map(toUsageResponse) });
  });

  app.openapi(recordUsageRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);

    const existing = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.organizationId, organizationId))
      .all();
    const match = existing.find(
      (r) =>
        r.period === input.period &&
        r.resource === input.resource &&
        r.action === input.action
    );

    const ts = new Date().toISOString();
    let id: string;
    if (match) {
      id = match.id;
      await db
        .update(usageRecords)
        .set({
          count: sql`${usageRecords.count} + ${input.count}`,
          updatedAt: ts,
        })
        .where(eq(usageRecords.id, match.id));
    } else {
      id = crypto.randomUUID();
      await db.insert(usageRecords).values({
        id,
        organizationId,
        period: input.period,
        resource: input.resource,
        action: input.action,
        count: input.count,
        createdAt: ts,
        updatedAt: ts,
      });
    }

    const row = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, id))
      .get();
    if (!row) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Usage record not found",
      });
    }
    return c.json(toUsageResponse(row), 201);
  });
}
