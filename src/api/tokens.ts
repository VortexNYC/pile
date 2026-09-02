import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createWorkspaceToken,
  deleteWorkspaceToken,
  listWorkspaceTokens,
} from "../global/tokens.js";
import { rls } from "../platform/rls.js";
import type { AppContext } from "./middleware.js";

const tokenSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  permissions: z.string(),
  createdAt: z.string(),
});

const tokenWithSecretSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  token: z.string(),
  permissions: z.string(),
  createdAt: z.string(),
});

const tokenBodySchema = z.object({
  name: z.string().min(1),
  permissions: z.string().optional(),
});

const listTokensRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/tokens",
  tags: ["tokens"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string() }),
  },
  responses: {
    200: {
      description: "Token list",
      content: {
        "application/json": {
          schema: z.object({ tokens: z.array(tokenSchema) }),
        },
      },
    },
  },
});

const createTokenRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/tokens",
  tags: ["tokens"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ workspaceId: z.string() }),
    body: {
      content: {
        "application/json": { schema: tokenBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Token created",
      content: {
        "application/json": { schema: tokenWithSecretSchema },
      },
    },
  },
});

const deleteTokenRoute = createRoute({
  method: "delete",
  path: "/workspaces/{workspaceId}/tokens/{id}",
  tags: ["tokens"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Token deleted" },
  },
});

export function registerTokenRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listTokensRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listWorkspaceTokens(db, workspaceId);
    return c.json({ tokens: items });
  });

  app.openapi(createTokenRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createWorkspaceToken(
      db,
      workspaceId,
      input.name,
      input.permissions,
      c.env.TOKEN_HASH_SECRET
    );
    return c.json(item, 201);
  });

  app.openapi(deleteTokenRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await deleteWorkspaceToken(db, workspaceId, id);
    return c.body(null, 204);
  });
}
