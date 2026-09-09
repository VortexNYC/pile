import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const searchResultSchema = z.object({
  issueIds: z.array(z.string()),
  documentIds: z.array(z.string()),
});

const searchBodySchema = z.object({
  query: z.string().min(1),
  teamIds: z.array(z.string()).default([]),
  limit: z.number().int().min(1).max(1000).default(50),
});

const searchRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/search",
  tags: ["search"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: { content: { "application/json": { schema: searchBodySchema } } },
  },
  responses: {
    200: {
      description: "Search results",
      content: {
        "application/json": { schema: searchResultSchema },
      },
    },
  },
});

export function registerSearchRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(searchRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const env = c.env;
    if (!env.WORKSPACE_DURABLE_OBJECT) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 503,
        message: "Workspace Durable Object binding missing",
      });
    }
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const results = await stub.searchAll(input.query, input.teamIds, input.limit);
    return c.json(results);
  });
}
