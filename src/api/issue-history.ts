import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const historySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
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
  path: "/workspaces/{organizationId}/issues/{issueId}/history",
  tags: ["history"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
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
    const { organizationId, issueId } = c.req.valid("param");
    const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(
      c.env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    const items = await stub.listIssueHistory(issueId);
    return c.json({ history: items });
  });
}
