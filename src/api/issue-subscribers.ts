import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createIssueSubscriber,
  deleteIssueSubscriber,
  getIssueSubscriber,
  listIssueSubscribers,
} from "../global/issue-subscribers.js";
import { VortexError } from "../platform/errors.js";
import { rls } from "../platform/rls.js";
import type { AppContext } from "./middleware.js";

const issueSubscriberSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  issueId: z.string(),
  linearUserId: z.string(),
  createdAt: z.string(),
});

const subscriberBodySchema = z.object({
  linearUserId: z.string().min(1),
});

const listIssueSubscribersRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/issues/{issueId}/subscribers",
  tags: ["issue-subscribers"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string(), issueId: z.string() }),
  },
  responses: {
    200: {
      description: "Issue subscribers list",
      content: {
        "application/json": {
          schema: z.object({ subscribers: z.array(issueSubscriberSchema) }),
        },
      },
    },
  },
});

const createIssueSubscriberRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/issues/{issueId}/subscribers",
  tags: ["issue-subscribers"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string(), issueId: z.string() }),
    body: {
      content: {
        "application/json": { schema: subscriberBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Subscriber added",
      content: {
        "application/json": { schema: issueSubscriberSchema },
      },
    },
  },
});

const deleteIssueSubscriberRoute = createRoute({
  method: "delete",
  path: "/workspaces/{workspaceId}/issues/{issueId}/subscribers/{id}",
  tags: ["issue-subscribers"],
  middleware: [rls("write")],
  request: {
    params: z.object({
      workspaceId: z.string(),
      issueId: z.string(),
      id: z.string(),
    }),
  },
  responses: {
    204: { description: "Subscriber removed" },
  },
});

export function registerIssueSubscriberRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listIssueSubscribersRoute, async (c) => {
    const { workspaceId, issueId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listIssueSubscribers(db, workspaceId, issueId);
    return c.json({ subscribers: items });
  });

  app.openapi(createIssueSubscriberRoute, async (c) => {
    const { workspaceId, issueId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createIssueSubscriber(db, workspaceId, {
      issueId,
      linearUserId: input.linearUserId,
    });
    return c.json(item, 201);
  });

  app.openapi(deleteIssueSubscriberRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const existing = await getIssueSubscriber(db, workspaceId, id);
    if (!existing) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Subscriber not found",
      });
    }
    await deleteIssueSubscriber(db, workspaceId, id);
    return c.body(null, 204);
  });
}
