import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { getVisibleTeamIds } from "../global/teams.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { issueViewer } from "./issue-access.js";

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
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const env = c.env;
    if (!env.WORKSPACE_DURABLE_OBJECT) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 503,
        message: "Workspace Durable Object binding missing",
      });
    }
    // Caller-supplied teamIds intersect with the caller's visible teams —
    // otherwise the filter could be pointed at private teams.
    const visibleTeamIds = await getVisibleTeamIds(
      db,
      organizationId,
      identity
    );
    const teamIds = input.teamIds.length
      ? input.teamIds.filter((id) => visibleTeamIds.includes(id))
      : visibleTeamIds;
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const results = await stub.searchAll(
      input.query,
      teamIds,
      input.limit,
      await issueViewer(db, identity)
    );
    return c.json(results);
  });
}
