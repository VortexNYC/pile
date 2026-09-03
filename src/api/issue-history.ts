import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { listIssueHistory } from "../global/issue-history.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const historySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  issueId: z.string(),
  linearId: z.string().nullable(),
  field: z.string(),
  fromValue: z.string().nullable(),
  toValue: z.string().nullable(),
  actorId: z.string().nullable(),
  createdAt: z.string(),
});

const listIssueHistoryRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/issues/{issueId}/history",
  tags: ["history"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string(), issueId: z.string() }),
  },
  responses: {
    200: {
      description: "Issue history",
      content: {
        "application/json": {
          schema: z.object({ history: z.array(historySchema) }),
        },
      },
    },
  },
});

export function registerIssueHistoryRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listIssueHistoryRoute, async (c) => {
    const { workspaceId, issueId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listIssueHistory(db, workspaceId, issueId);
    return c.json({ history: items });
  });
}
