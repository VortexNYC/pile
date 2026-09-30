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
    query: z.object({
      token: z
        .string()
        .optional()
        .describe(
          "Workspace API key for browser WebSocket clients, which cannot set the Authorization header"
        ),
    }),
  },
  responses: {
    101: { description: "Switching Protocols to WebSocket" },
    200: { description: "Realtime endpoint (non-upgrade request)" },
    426: { description: "Upgrade Required" },
  },
});

/**
 * Rebuild a response returned by `DurableObjectStub.fetch` with mutable
 * headers. Fetch-produced Responses are immutable, and response middleware
 * (secure headers, request id, CORS) attaches headers after the handler
 * returns — returning the stub response directly throws
 * "Can't modify immutable headers".
 */
export function toMutableResponse(res: Response): Response {
  const webSocket = res.webSocket;
  if (res.status === 101 && webSocket) {
    return new Response(null, { status: 101, webSocket });
  }
  return new Response(res.body, res);
}

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
    if (c.req.header("Upgrade") !== "websocket") {
      throw VortexError.fromCode(
        "UPGRADE_REQUIRED",
        'Send "Upgrade: websocket" to open a realtime stream'
      );
    }
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    return toMutableResponse(await stub.fetch(c.req.raw));
  });
}
