import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createSupportSavedView,
  getInboxTicketCounts,
  getNextInboxTicket,
  getSupportSavedView,
  listInboxTickets,
  listSupportSavedViews,
} from "../global/support-inbox.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const priorityEnum = z.enum(["low", "medium", "high", "urgent"]);
const statusEnum = z.enum(["todo", "done", "snoozed"]);
const channelEnum = z.enum([
  "email",
  "slack",
  "msteams",
  "discord",
  "chat",
  "capture",
  "api",
  "intercom",
  "zendesk",
  "plain",
]);

const customerSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string().optional().nullable(),
});

const supportInboxTicketSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  title: z.string(),
  status: statusEnum,
  priority: priorityEnum,
  customer: customerSchema,
  primaryAssignee: z.string().optional(),
  labels: z.array(z.string()),
  lastCustomerMessageAt: z.string().datetime().optional(),
  lastAgentMessageAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const orgParam = z.object({ organizationId: z.string() });
const viewIdParam = z.object({
  organizationId: z.string(),
  viewId: z.string(),
});

const listInboxOptionsSchema = z.object({
  status: statusEnum.optional(),
  priority: priorityEnum.optional(),
  assignedTo: z.string().optional(),
  customerId: z.string().optional(),
  channel: channelEnum.optional(),
  label: z.string().optional(),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

const listInboxRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/inbox",
  tags: ["support-inbox"],
  middleware: [rls("read")],
  request: {
    params: orgParam,
    query: listInboxOptionsSchema,
  },
  responses: {
    200: {
      description: "Inbox tickets",
      content: {
        "application/json": {
          schema: z.object({
            tickets: z.array(supportInboxTicketSchema),
            nextCursor: z.string().optional().nullable(),
          }),
        },
      },
    },
  },
});

const getInboxCountsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/inbox/counts",
  tags: ["support-inbox"],
  middleware: [rls("read")],
  request: { params: orgParam },
  responses: {
    200: {
      description: "Inbox counts",
      content: {
        "application/json": {
          schema: z.object({
            counts: z.object({
              todo: z.number().int(),
              done: z.number().int(),
              snoozed: z.number().int(),
              mine: z.number().int(),
              unassigned: z.number().int(),
            }),
          }),
        },
      },
    },
  },
});

const getNextInboxRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/inbox/next",
  tags: ["support-inbox"],
  middleware: [rls("read")],
  request: { params: orgParam },
  responses: {
    200: {
      description: "Next ticket",
      content: {
        "application/json": {
          schema: z.object({
            ticketId: z.string(),
            userId: z.string(),
          }),
        },
      },
    },
    404: { description: "No unassigned ticket or available agent" },
  },
});

const supportSavedViewSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string().nullable(),
  name: z.string(),
  filter: z.record(z.string(), z.unknown()),
  sort: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const createSavedViewRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/inbox/views",
  tags: ["support-inbox"],
  middleware: [rls("write")],
  request: {
    params: orgParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            filter: z.record(z.string(), z.unknown()),
            sort: z.record(z.string(), z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "View created",
      content: {
        "application/json": {
          schema: z.object({ view: supportSavedViewSchema }),
        },
      },
    },
  },
});

const listSavedViewsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/inbox/views",
  tags: ["support-inbox"],
  middleware: [rls("read")],
  request: { params: orgParam },
  responses: {
    200: {
      description: "Saved views",
      content: {
        "application/json": {
          schema: z.object({ views: z.array(supportSavedViewSchema) }),
        },
      },
    },
  },
});

const getSavedViewRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/inbox/views/{viewId}",
  tags: ["support-inbox"],
  middleware: [rls("read")],
  request: { params: viewIdParam },
  responses: {
    200: {
      description: "View",
      content: {
        "application/json": {
          schema: z.object({ view: supportSavedViewSchema }),
        },
      },
    },
    404: { description: "Not found" },
  },
});

const runSavedViewRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/inbox/views/{viewId}/run",
  tags: ["support-inbox"],
  middleware: [rls("read")],
  request: { params: viewIdParam },
  responses: {
    200: {
      description: "Run view",
      content: {
        "application/json": {
          schema: z.object({
            tickets: z.array(supportInboxTicketSchema),
            nextCursor: z.string().optional().nullable(),
          }),
        },
      },
    },
    404: { description: "View not found" },
  },
});

export function registerSupportInboxRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listInboxRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const db = createD1(c.env.D1);
    const result = await listInboxTickets(db, organizationId, {
      ...query,
      limit: query.limit,
    });
    return c.json(result);
  });

  app.openapi(getInboxCountsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const counts = await getInboxTicketCounts(
      db,
      organizationId,
      c.var.workspaceIdentity.id
    );
    return c.json({ counts });
  });

  app.openapi(getNextInboxRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const next = await getNextInboxTicket(db, organizationId);
    if (!next) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "No unassigned ticket or available agent",
      });
    }
    return c.json(next);
  });

  app.openapi(createSavedViewRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const raw = await createSupportSavedView(
      db,
      organizationId,
      c.var.workspaceIdentity.id,
      body
    );
    const view = supportSavedViewSchema.parse({
      ...raw,
      filter: JSON.parse(raw.filter),
      sort: JSON.parse(raw.sort),
    });
    return c.json({ view }, 201);
  });

  app.openapi(listSavedViewsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const raw = await listSupportSavedViews(
      db,
      organizationId,
      c.var.workspaceIdentity.id
    );
    const views = raw.map((v) =>
      supportSavedViewSchema.parse({
        ...v,
        filter: JSON.parse(v.filter),
        sort: JSON.parse(v.sort),
      })
    );
    return c.json({ views });
  });

  app.openapi(getSavedViewRoute, async (c) => {
    const { organizationId, viewId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const raw = await getSupportSavedView(db, organizationId, viewId);
    if (!raw) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "View not found",
      });
    }
    const view = supportSavedViewSchema.parse({
      ...raw,
      filter: JSON.parse(raw.filter),
      sort: JSON.parse(raw.sort),
    });
    return c.json({ view });
  });

  app.openapi(runSavedViewRoute, async (c) => {
    const { organizationId, viewId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const view = await getSupportSavedView(db, organizationId, viewId);
    if (!view) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "View not found",
      });
    }
    const filter = JSON.parse(view.filter);
    const query = listInboxOptionsSchema.parse({ limit: 25, ...filter });
    const { tickets, nextCursor } = await listInboxTickets(
      db,
      organizationId,
      query
    );
    return c.json({ tickets, nextCursor });
  });
}
