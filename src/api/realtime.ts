import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const realtimeRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/realtime",
  tags: ["realtime"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    101: { description: "Switching Protocols to WebSocket" },
    200: { description: "Realtime endpoint (non-upgrade request)" },
    426: { description: "Upgrade Required" },
  },
});

export function registerRealtimeRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(realtimeRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
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
    return stub.fetch(c.req.raw);
  });
}
