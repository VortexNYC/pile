import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { webhookDeliveries } from "../global/schema.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const webhookSubscriptionSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  url: z.string(),
  events: z.string(),
  secret: z.string(),
  createdAt: z.string(),
});

const createWebhookSubscriptionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/webhook-subscriptions",
  tags: ["webhooks"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().url(),
            events: z.string().optional(),
            secret: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Webhook subscription created",
      content: {
        "application/json": { schema: webhookSubscriptionSchema },
      },
    },
  },
});

const listWebhookSubscriptionsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/webhook-subscriptions",
  tags: ["webhooks"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Webhook subscriptions list",
      content: {
        "application/json": {
          schema: z.object({
            subscriptions: z.array(webhookSubscriptionSchema),
          }),
        },
      },
    },
  },
});

const getWebhookSubscriptionRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/webhook-subscriptions/{id}",
  tags: ["webhooks"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Webhook subscription",
      content: {
        "application/json": { schema: webhookSubscriptionSchema },
      },
    },
  },
});

const updateWebhookSubscriptionRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/webhook-subscriptions/{id}",
  tags: ["webhooks"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            url: z.string().url().optional(),
            events: z.string().optional(),
            secret: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Webhook subscription updated",
      content: {
        "application/json": { schema: webhookSubscriptionSchema },
      },
    },
  },
});

const deleteWebhookSubscriptionRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/webhook-subscriptions/{id}",
  tags: ["webhooks"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: {
      description: "Webhook subscription deleted",
    },
  },
});

const listWebhookDeliveriesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/webhook-subscriptions/{id}/deliveries",
  tags: ["webhooks"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Webhook deliveries list",
      content: {
        "application/json": {
          schema: z.object({
            deliveries: z.array(
              z.object({
                id: z.string(),
                organizationId: z.string(),
                subscriptionId: z.string(),
                event: z.string(),
                url: z.string(),
                status: z.string(),
                statusCode: z.number().nullable(),
                error: z.string().nullable(),
                attemptCount: z.number(),
                createdAt: z.string(),
                updatedAt: z.string(),
              })
            ),
          }),
        },
      },
    },
  },
});

const webhookDeliverySchema = z.object({
  deliveryId: z.string(),
  source: z.string(),
  event: z.string(),
  organizationId: z.string().nullable(),
  processedAt: z.string(),
  status: z.string(),
  attemptCount: z.number(),
  payload: z.string().nullable(),
  lastError: z.string().nullable(),
  nextRetryAt: z.string().nullable(),
  lockedAt: z.string().nullable(),
  result: z.string().nullable(),
});

const listInboundWebhookDeliveriesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/webhook-deliveries",
  tags: ["webhooks"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      status: z
        .enum(["pending", "processing", "completed", "failed"])
        .optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "Inbound webhook delivery log",
      content: {
        "application/json": {
          schema: z.object({
            deliveries: z.array(webhookDeliverySchema),
          }),
        },
      },
    },
  },
});

export function registerWebhookRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(createWebhookSubscriptionRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const item = await stub.createWebhookSubscription(input);
    return c.json(item, 201);
  });

  app.openapi(listWebhookSubscriptionsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const items = await stub.listWebhookSubscriptions();
    return c.json({ subscriptions: items });
  });

  app.openapi(getWebhookSubscriptionRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const item = await stub.findWebhookSubscriptionByWorkspace(id);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Webhook subscription not found",
      });
    }
    return c.json(item);
  });

  app.openapi(updateWebhookSubscriptionRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const item = await stub.updateWebhookSubscription(id, input);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Webhook subscription not found",
      });
    }
    return c.json(item);
  });

  app.openapi(deleteWebhookSubscriptionRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const deleted = await stub.deleteWebhookSubscription(id);
    if (!deleted) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Webhook subscription not found",
      });
    }
    return c.body(null, 204);
  });

  app.openapi(listWebhookDeliveriesRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const items = await stub.listWebhookDeliveries(id);
    return c.json({ deliveries: items });
  });

  app.openapi(listInboundWebhookDeliveriesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { status, limit = 20 } = c.req.valid("query");
    const db = createD1(c.env.D1);
    const conditions = [eq(webhookDeliveries.organizationId, organizationId)];
    if (status) {
      conditions.push(eq(webhookDeliveries.status, status));
    }
    const items = await db
      .select()
      .from(webhookDeliveries)
      .where(and(...conditions))
      .orderBy(desc(webhookDeliveries.processedAt))
      .limit(limit)
      .all();
    return c.json({ deliveries: items });
  });
}
