import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  getNotificationsForRecipient,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead,
} from "../global/notifications.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const notificationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  recipientId: z.string(),
  recipientType: z.string(),
  issueId: z.string(),
  type: z.string(),
  read: z.boolean(),
  metadata: z.unknown().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const listNotificationsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/notifications",
  tags: ["notifications"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      unreadOnly: z
        .string()
        .optional()
        .openapi({ description: "Only unread notifications" }),
      limit: z
        .string()
        .optional()
        .openapi({ description: "Max notifications to return" }),
    }),
  },
  responses: {
    200: {
      description: "Notifications list",
      content: {
        "application/json": {
          schema: z.object({ notifications: z.array(notificationSchema) }),
        },
      },
    },
  },
});

const unreadCountRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/notifications/unread-count",
  tags: ["notifications"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Unread notification count",
      content: {
        "application/json": {
          schema: z.object({ count: z.number().int() }),
        },
      },
    },
  },
});

const markReadRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/notifications/{id}/read",
  tags: ["notifications"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Notification marked read",
      content: {
        "application/json": { schema: notificationSchema },
      },
    },
    404: {
      description: "Notification not found",
    },
  },
});

const markAllReadRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/notifications/mark-all-read",
  tags: ["notifications"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    204: { description: "All notifications marked read" },
  },
});

function toNotificationResponse(row: {
  id: string;
  organizationId: string;
  recipientId: string;
  recipientType: string;
  issueId: string;
  type: string;
  read: boolean;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

export function registerNotificationRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listNotificationsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const db = createD1(c.env.D1);
    const identity = c.var.workspaceIdentity;
    const rows = await getNotificationsForRecipient(
      db,
      organizationId,
      identity.id,
      identity.type,
      {
        unreadOnly: query.unreadOnly === "true" || query.unreadOnly === "1",
        limit: query.limit ? Number(query.limit) : undefined,
      }
    );
    return c.json({ notifications: rows.map(toNotificationResponse) });
  });

  app.openapi(unreadCountRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const identity = c.var.workspaceIdentity;
    const count = await getUnreadNotificationCount(
      db,
      organizationId,
      identity.id,
      identity.type
    );
    return c.json({ count });
  });

  app.openapi(markReadRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const identity = c.var.workspaceIdentity;
    const updated = await markNotificationRead(
      db,
      organizationId,
      identity.id,
      identity.type,
      id
    );
    if (!updated) {
      return c.json({ message: "Notification not found" }, 404);
    }
    return c.json(toNotificationResponse(updated));
  });

  app.openapi(markAllReadRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const identity = c.var.workspaceIdentity;
    await markAllNotificationsRead(
      db,
      organizationId,
      identity.id,
      identity.type
    );
    return c.body(null, 204);
  });
}
