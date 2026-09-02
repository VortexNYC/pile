import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createState,
  deleteState,
  getState,
  listStates,
  updateState,
} from "../global/workspace-entities.js";
import { VortexError } from "../platform/errors.js";
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

const stateBodySchema = z.object({
  name: z.string().min(1).optional(),
  type: z.string().optional(),
  color: z.string().optional(),
  position: z.string().optional(),
});

const createStateBodySchema = z.object({
  linearId: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  color: z.string().optional(),
  position: z.string().optional(),
});

const createStateRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/states",
  tags: ["states"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string() }),
    body: {
      content: {
        "application/json": { schema: createStateBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "State created",
      content: {
        "application/json": { schema: stateSchema },
      },
    },
  },
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

const getStateRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/states/{id}",
  tags: ["states"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "State",
      content: {
        "application/json": { schema: stateSchema },
      },
    },
  },
});

const updateStateRoute = createRoute({
  method: "patch",
  path: "/workspaces/{workspaceId}/states/{id}",
  tags: ["states"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": { schema: stateBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "State updated",
      content: {
        "application/json": { schema: stateSchema },
      },
    },
  },
});

const deleteStateRoute = createRoute({
  method: "delete",
  path: "/workspaces/{workspaceId}/states/{id}",
  tags: ["states"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "State deleted" },
  },
});

export function registerStateRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(createStateRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createState(db, workspaceId, input);
    return c.json(item, 201);
  });

  app.openapi(listStatesRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listStates(db, workspaceId);
    return c.json({ states: items });
  });

  app.openapi(getStateRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getState(db, workspaceId, id);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "State not found",
      });
    }
    return c.json(item);
  });

  app.openapi(updateStateRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await updateState(db, workspaceId, id, body);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "State not found",
      });
    }
    return c.json(item);
  });

  app.openapi(deleteStateRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await deleteState(db, workspaceId, id);
    return c.body(null, 204);
  });
}
