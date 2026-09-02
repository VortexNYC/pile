import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { createD1 } from "../global/db.js";
import { listStates } from "../global/workspace-entities.js";
import { rls } from "../platform/rls.js";
import type { AppContext } from "./middleware.js";

const stateSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  linearId: z.string(),
  name: z.string(),
  type: z.string(),
  color: z.string().nullable(),
  position: z.string().nullable(),
  createdAt: z.string(),
});

const listStatesRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/states",
  tags: ["states"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string() }),
  },
  responses: {
    200: {
      description: "States list",
      content: {
        "application/json": {
          schema: z.object({ states: z.array(stateSchema) }),
        },
      },
    },
  },
});

export function registerStateRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listStatesRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listStates(db, workspaceId);
    return c.json({ states: items });
  });
}
