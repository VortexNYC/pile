import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createIssueRelation,
  deleteIssueRelation,
  getIssueRelation,
  listInverseIssueRelations,
  listIssueRelations,
} from "../global/issue-relations.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const relationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  fromIssueId: z.string(),
  toIssueId: z.string(),
  type: z.string(),
  createdAt: z.string(),
});

const relationTypeSchema = z.enum([
  "related",
  "blocks",
  "duplicate",
  "similar",
]);

const relationBodySchema = z.object({
  toIssueId: z.string().min(1),
  type: relationTypeSchema,
});

const listRelationsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/relations",
  tags: ["relations"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
    query: z.object({ direction: z.enum(["outgoing", "incoming"]).optional() }),
  },
  responses: {
    200: {
      description: "Issue relations",
      content: {
        "application/json": {
          schema: z.object({
            relations: z.array(relationSchema),
            inverseRelations: z.array(relationSchema).optional(),
          }),
        },
      },
    },
  },
});

const createRelationRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/issues/{issueId}/relations",
  tags: ["relations"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
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
  path: "/workspaces/{organizationId}/issues/{issueId}/relations/{id}",
  tags: ["relations"],
  middleware: [rls("write")],
  request: {
    params: z.object({
      organizationId: z.string(),
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
    const { organizationId, issueId } = c.req.valid("param");
    const { direction } = c.req.valid("query");
    const db = createD1(c.env.D1);
    const outgoing =
      direction === undefined || direction === "outgoing"
        ? await listIssueRelations(db, organizationId, issueId)
        : [];
    const incoming =
      direction === undefined || direction === "incoming"
        ? await listInverseIssueRelations(db, organizationId, issueId)
        : [];
    return c.json({
      relations: outgoing,
      inverseRelations: direction === undefined ? incoming : undefined,
    });
  });

  app.openapi(createRelationRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const { toIssueId, type } = c.req.valid("json");
    const db = createD1(c.env.D1);
    const relation = await createIssueRelation(db, organizationId, {
      fromIssueId: issueId,
      toIssueId,
      type,
    });
    return c.json(relation, 201);
  });

  app.openapi(deleteRelationRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const existing = await getIssueRelation(db, organizationId, id);
    if (!existing) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Relation not found",
      });
    }
    await deleteIssueRelation(db, organizationId, id);
    return c.body(null, 204);
  });
}
