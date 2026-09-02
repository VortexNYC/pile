import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { migrateLinear } from "../migrate/linear.js";
import { rls } from "../platform/rls.js";
import type { AppContext } from "./middleware.js";

const migrateLinearRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/migrate/linear",
  tags: ["migrate"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ workspaceId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            linearToken: z.string().min(1),
            teamId: z.string().min(1),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Migration complete",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            counts: z.object({
              issues: z.number(),
              labels: z.number(),
              projects: z.number(),
              cycles: z.number(),
            }),
          }),
        },
      },
    },
  },
});

export function registerMigrateRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(migrateLinearRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { linearToken, teamId } = c.req.valid("json");
    const counts = await migrateLinear(c.env, workspaceId, linearToken, teamId);
    return c.json({ ok: true, counts });
  });
}
