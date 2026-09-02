import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { getLinearUser, listLinearUsers } from "../global/linear-users.js";
import { VortexError } from "../platform/errors.js";
import { rls } from "../platform/rls.js";
import type { AppContext } from "./middleware.js";

const linearUserSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  linearId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  createdAt: z.string(),
});

const listLinearUsersRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/linear-users",
  tags: ["linear-users"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string() }),
  },
  responses: {
    200: {
      description: "Linear users list",
      content: {
        "application/json": {
          schema: z.object({ linearUsers: z.array(linearUserSchema) }),
        },
      },
    },
  },
});

const getLinearUserRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/linear-users/{linearId}",
  tags: ["linear-users"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string(), linearId: z.string() }),
  },
  responses: {
    200: {
      description: "Linear user",
      content: {
        "application/json": { schema: linearUserSchema },
      },
    },
  },
});

export function registerLinearUserRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listLinearUsersRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listLinearUsers(db, workspaceId);
    return c.json({ linearUsers: items });
  });

  app.openapi(getLinearUserRoute, async (c) => {
    const { workspaceId, linearId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getLinearUser(db, workspaceId, linearId);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Linear user not found",
      });
    }
    return c.json(item);
  });
}
