import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createWorkspace,
  getWorkspaceById,
  getWorkspaceBySlug,
  listWorkspaces,
} from "../global/workspaces.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";

const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  key: z.string().nullable(),
  ownerId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createWorkspaceRoute = createRoute({
  method: "post",
  path: "/workspaces",
  tags: ["workspaces"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            slug: z.string().min(1),
            key: z.string().optional(),
            ownerId: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Workspace created",
      content: {
        "application/json": { schema: workspaceSchema },
      },
    },
  },
});

const listWorkspacesRoute = createRoute({
  method: "get",
  path: "/workspaces",
  tags: ["workspaces"],
  request: {},
  responses: {
    200: {
      description: "Workspaces list",
      content: {
        "application/json": {
          schema: z.object({ workspaces: z.array(workspaceSchema) }),
        },
      },
    },
  },
});

const getWorkspaceRoute = createRoute({
  method: "get",
  path: "/workspaces/{id}",
  tags: ["workspaces"],
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: "Workspace",
      content: {
        "application/json": { schema: workspaceSchema },
      },
    },
  },
});

const getWorkspaceBySlugRoute = createRoute({
  method: "get",
  path: "/workspaces/slug/{slug}",
  tags: ["workspaces"],
  request: {
    params: z.object({ slug: z.string() }),
  },
  responses: {
    200: {
      description: "Workspace",
      content: {
        "application/json": { schema: workspaceSchema },
      },
    },
  },
});

export function registerWorkspaceRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(createWorkspaceRoute, async (c) => {
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createWorkspace(db, {
      name: input.name,
      slug: input.slug,
      key: input.key,
      ownerId: input.ownerId,
    });
    return c.json(item, 201);
  });

  app.openapi(listWorkspacesRoute, async (c) => {
    const db = createD1(c.env.D1);
    const items = await listWorkspaces(db);
    return c.json({ workspaces: items });
  });

  app.openapi(getWorkspaceRoute, async (c) => {
    const { id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getWorkspaceById(db, id);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Workspace not found",
      });
    }
    return c.json(item);
  });

  app.openapi(getWorkspaceBySlugRoute, async (c) => {
    const { slug } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getWorkspaceBySlug(db, slug);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Workspace not found",
      });
    }
    return c.json(item);
  });
}
