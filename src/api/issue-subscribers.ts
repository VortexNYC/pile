import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createIssueSubscriber,
  listIssueSubscribers,
} from "../global/issue-subscribers.js";
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
}
