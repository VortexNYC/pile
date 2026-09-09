import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const notificationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  recipientId: z.string(),
  recipientType: z.string(),
  issueId: z.string(),
  type: z.string(),
  read: z.boolean(),
  snoozedUntil: z.string().nullable(),
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
      snoozedOnly: z
        .string()
        .optional()
        .openapi({ description: "Only snoozed notifications" }),
      includeSnoozed: z
        .string()
        .optional()
        .openapi({ description: "Include snoozed notifications" }),
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

const markUnreadRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/notifications/{id}/unread",
  tags: ["notifications"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Notification marked unread",
      content: {
        "application/json": { schema: notificationSchema },
      },
    },
    404: {
      description: "Notification not found",
    },
  },
});

const snoozeRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/notifications/{id}/snooze",
  tags: ["notifications"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            until: z.string().datetime().nullable().openapi({
              description: "ISO timestamp to snooze until, or null to unsnooze",
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Notification snoozed",
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
  snoozedUntil: string | null;
  metadata: string | null;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

const preferencesSchema = z.object({
  organizationId: z.string(),
  userId: z.string(),
  inApp: z.boolean(),
  webhook: z.boolean(),
  email: z.boolean(),
  mutedTypes: z.array(z.string()).nullable(),
  updatedAt: z.string(),
});

const preferencesBodySchema = z.object({
  inApp: z.boolean().optional(),
  webhook: z.boolean().optional(),
  email: z.boolean().optional(),
  mutedTypes: z.array(z.string()).nullable().optional(),
});

const getPreferencesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/notification-preferences",
  tags: ["notifications"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "My notification delivery preferences",
      content: {
        "application/json": { schema: preferencesSchema },
      },
    },
  },
});

const putPreferencesRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/notification-preferences",
  tags: ["notifications"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: { "application/json": { schema: preferencesBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Preferences updated",
      content: {
        "application/json": { schema: preferencesSchema },
      },
    },
  },
});

function toPreferencesResponse(row: {
  organizationId: string;
  userId: string;
  inApp: boolean;
  webhook: boolean;
  email: boolean;
  mutedTypes: string | null;
  updatedAt: string;
}) {
  return {
    ...row,
    mutedTypes: row.mutedTypes ? row.mutedTypes.split(",") : null,
  };
}

export function registerNotificationRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listNotificationsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const identity = c.var.workspaceIdentity;
    const rows = await stub.listNotificationsForRecipient(
      identity.id,
      identity.type,
      {
        unreadOnly: query.unreadOnly === "true" || query.unreadOnly === "1",
        snoozedOnly: query.snoozedOnly === "true" || query.snoozedOnly === "1",
        includeSnoozed:
          query.includeSnoozed === "true" || query.includeSnoozed === "1",
        limit: query.limit ? Number(query.limit) : undefined,
      }
    );
    return c.json({ notifications: rows.map(toNotificationResponse) });
  });

  app.openapi(unreadCountRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const identity = c.var.workspaceIdentity;
    const count = await stub.unreadNotificationCount(
      identity.id,
      identity.type
    );
    return c.json({ count });
  });

  app.openapi(markReadRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const identity = c.var.workspaceIdentity;
    const updated = await stub.markNotificationRead(
      identity.id,
      identity.type,
      id
    );
    if (!updated) {
      return c.json({ message: "Notification not found" }, 404);
    }
    return c.json(toNotificationResponse(updated));
  });

  app.openapi(markUnreadRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const identity = c.var.workspaceIdentity;
    const updated = await stub.markNotificationUnread(
      identity.id,
      identity.type,
      id
    );
    if (!updated) {
      return c.json({ message: "Notification not found" }, 404);
    }
    return c.json(toNotificationResponse(updated));
  });

  app.openapi(snoozeRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const { until } = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const identity = c.var.workspaceIdentity;
    const updated = await stub.snoozeNotification(
      identity.id,
      identity.type,
      id,
      until
    );
    if (!updated) {
      return c.json({ message: "Notification not found" }, 404);
    }
    return c.json(toNotificationResponse(updated));
  });

  app.openapi(markAllReadRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const identity = c.var.workspaceIdentity;
    await stub.markAllNotificationsRead(identity.id, identity.type);
    return c.body(null, 204);
  });

  app.openapi(getPreferencesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const identity = c.var.workspaceIdentity;
    const prefs = await stub.getNotificationPreferences(identity.id);
    return c.json(
      toPreferencesResponse(
        prefs ?? {
          organizationId,
          userId: identity.id,
          inApp: true,
          webhook: true,
          email: false,
          mutedTypes: null,
          updatedAt: "",
        }
      )
    );
  });

  app.openapi(putPreferencesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const identity = c.var.workspaceIdentity;
    const prefs = await stub.upsertNotificationPreferences(identity.id, input);
    return c.json(toPreferencesResponse(prefs));
  });
}
