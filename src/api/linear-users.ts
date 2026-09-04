import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createLinearUser,
  getLinearUser,
  listLinearUsers,
} from "../global/linear-users.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const linearUserSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  linearId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  createdAt: z.string(),
});

const createLinearUserBodySchema = z.object({
  linearId: z.string().min(1),
  name: z.string().optional(),
  email: z.string().optional(),
});

const createLinearUserRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/linear-users",
  tags: ["linear-users"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: createLinearUserBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Linear user created",
      content: {
        "application/json": { schema: linearUserSchema },
      },
    },
  },
});

const listLinearUsersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/linear-users",
  tags: ["linear-users"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
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
  path: "/workspaces/{organizationId}/linear-users/{linearId}",
  tags: ["linear-users"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), linearId: z.string() }),
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
  app.openapi(createLinearUserRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createLinearUser(db, organizationId, input);
    return c.json(item, 201);
  });

  app.openapi(listLinearUsersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listLinearUsers(db, organizationId);
    return c.json({ linearUsers: items });
  });

  app.openapi(getLinearUserRoute, async (c) => {
    const { organizationId, linearId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getLinearUser(db, organizationId, linearId);
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
