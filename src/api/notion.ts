import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createNotionUserMapping,
  findNotionUserByNotionId,
  listNotionUsers,
} from "../global/notion-users.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const notionUserSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  userId: z.string(),
  notionUserId: z.string(),
  createdAt: z.string(),
});

const notionUserRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/notion/users",
  tags: ["notion"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            userId: z.string(),
            notionUserId: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Notion user mapping created",
      content: { "application/json": { schema: notionUserSchema } },
    },
  },
});

const notionUsersRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/notion/users",
  tags: ["notion"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Notion user mappings",
      content: {
        "application/json": {
          schema: z.object({ users: z.array(notionUserSchema) }),
        },
      },
    },
  },
});

export function registerNotionRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(notionUserRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { userId, notionUserId } = c.req.valid("json");
    const db = createD1(c.env.D1);

    const existing = await findNotionUserByNotionId(
      db,
      organizationId,
      notionUserId
    );
    if (existing) {
      throw new VortexError({
        code: "CONFLICT",
        status: 409,
        message: "Notion user already mapped",
      });
    }

    const mapping = await createNotionUserMapping(
      db,
      organizationId,
      userId,
      notionUserId
    );
    return c.json(mapping, 201);
  });

  app.openapi(notionUsersRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const users = await listNotionUsers(db, organizationId);
    return c.json({ users });
  });
}
