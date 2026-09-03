import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  findWebhookSubscriptionByWorkspace,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  updateWebhookSubscription,
} from "../global/webhook-subscriptions.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const webhookSubscriptionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  url: z.string(),
  events: z.string(),
  secret: z.string(),
  createdAt: z.string(),
});

const createWebhookSubscriptionRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/webhook-subscriptions",
  tags: ["webhooks"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ workspaceId: z.string() }),
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
  path: "/workspaces/{workspaceId}/webhook-subscriptions",
  tags: ["webhooks"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ workspaceId: z.string() }),
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
  path: "/workspaces/{workspaceId}/webhook-subscriptions/{id}",
  tags: ["webhooks"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
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
  path: "/workspaces/{workspaceId}/webhook-subscriptions/{id}",
  tags: ["webhooks"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
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
  path: "/workspaces/{workspaceId}/webhook-subscriptions/{id}",
  tags: ["webhooks"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
  },
  responses: {
    204: {
      description: "Webhook subscription deleted",
    },
  },
});

const listWebhookDeliveriesRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/webhook-subscriptions/{id}/deliveries",
  tags: ["webhooks"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
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
                workspaceId: z.string(),
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

export function registerWebhookRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(createWebhookSubscriptionRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createWebhookSubscription(db, workspaceId, input);
    return c.json(item, 201);
  });

  app.openapi(listWebhookSubscriptionsRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listWebhookSubscriptions(db, workspaceId);
    return c.json({ subscriptions: items });
  });

  app.openapi(getWebhookSubscriptionRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await findWebhookSubscriptionByWorkspace(db, workspaceId, id);
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
    const { workspaceId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await updateWebhookSubscription(db, workspaceId, id, input);
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
    const { workspaceId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const deleted = await deleteWebhookSubscription(db, workspaceId, id);
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
    const { workspaceId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listWebhookDeliveries(db, workspaceId, id);
    return c.json({ deliveries: items });
  });
}
