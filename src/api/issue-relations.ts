import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createIssueRelation,
  deleteIssueRelation,
  getIssueRelation,
  listIssueRelations,
} from "../global/issue-relations.js";
import { VortexError } from "../platform/errors.js";
import { rls } from "../platform/rls.js";
import type { AppContext } from "./middleware.js";

const relationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  fromIssueId: z.string(),
  toIssueId: z.string(),
  type: z.string(),
  createdAt: z.string(),
});

const relationBodySchema = z.object({
  toIssueId: z.string().min(1),
  type: z.enum([
    "parent",
    "child",
    "blocks",
    "blocked_by",
    "related",
    "duplicate",
  ]),
});

const listRelationsRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/issues/{issueId}/relations",
  tags: ["relations"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string(), issueId: z.string() }),
  },
  responses: {
    200: {
      description: "Issue relations",
      content: {
        "application/json": {
          schema: z.object({ relations: z.array(relationSchema) }),
        },
      },
    },
  },
});

const createRelationRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/issues/{issueId}/relations",
  tags: ["relations"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string(), issueId: z.string() }),
    body: {
      content: {
        "application/json": { schema: relationBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Relation created",
      content: {
        "application/json": { schema: relationSchema },
      },
    },
  },
});

const deleteRelationRoute = createRoute({
  method: "delete",
  path: "/workspaces/{workspaceId}/issues/{issueId}/relations/{id}",
  tags: ["relations"],
  middleware: [rls("write")],
  request: {
    params: z.object({
      workspaceId: z.string(),
      issueId: z.string(),
      id: z.string(),
    }),
  },
  responses: {
    204: { description: "Relation deleted" },
  },
});

export function registerIssueRelationRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listRelationsRoute, async (c) => {
    const { workspaceId, issueId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const relations = await listIssueRelations(db, workspaceId, issueId);
    return c.json({ relations });
  });

  app.openapi(createRelationRoute, async (c) => {
    const { workspaceId, issueId } = c.req.valid("param");
    const { toIssueId, type } = c.req.valid("json");
    const db = createD1(c.env.D1);
    const relation = await createIssueRelation(db, workspaceId, {
      fromIssueId: issueId,
      toIssueId,
      type,
    });
    return c.json(relation, 201);
  });

  app.openapi(deleteRelationRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const existing = await getIssueRelation(db, workspaceId, id);
    if (!existing) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Relation not found",
      });
    }
    await deleteIssueRelation(db, workspaceId, id);
    return c.body(null, 204);
  });
}
