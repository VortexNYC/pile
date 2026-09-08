import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { canAccessTeam } from "../global/teams.js";
import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import type { Issue } from "../types/workspace.js";

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

async function getStub(env: WorkerEnv, organizationId: string) {
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
  await stub.setOrganizationId(organizationId);
  return stub;
}

async function getIssue(
  stub: { getIssue(id: string): Promise<Issue | undefined> },
  id: string
): Promise<Issue> {
  const issue = await stub.getIssue(id);
  if (!issue) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Issue not found",
    });
  }
  return issue;
}

async function assertIssueAccess(
  db: ReturnType<typeof createD1>,
  issue: Issue,
  identity: WorkspaceIdentity
): Promise<void> {
  const allowed = await canAccessTeam(db, issue.teamId, identity);
  if (!allowed) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Issue not found",
    });
  }
}

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
  path: "/workspaces/{organizationId}/relations/{id}",
  tags: ["relations"],
  middleware: [rls("write")],
  request: {
    params: z.object({
      organizationId: z.string(),
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
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);
    const issue = await getIssue(stub, issueId);
    await assertIssueAccess(db, issue, identity);
    const outgoing =
      direction === undefined || direction === "outgoing"
        ? await stub.listIssueRelations(issueId)
        : [];
    const incoming =
      direction === undefined || direction === "incoming"
        ? await stub.listInverseIssueRelations(issueId)
        : [];
    return c.json({
      relations: outgoing,
      inverseRelations:
        direction === undefined || direction === "incoming"
          ? incoming
          : undefined,
    });
  });

  app.openapi(createRelationRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const { toIssueId, type } = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);
    const fromIssue = await getIssue(stub, issueId);
    const toIssue = await getIssue(stub, toIssueId);
    await assertIssueAccess(db, fromIssue, identity);
    await assertIssueAccess(db, toIssue, identity);
    const relation = await stub.createIssueRelation({
      fromIssueId: issueId,
      toIssueId,
      type,
    });
    return c.json(relation, 201);
  });

  app.openapi(deleteRelationRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub0 = await getStub(c.env, organizationId);
    const existing = await stub0.getIssueRelation(id);
    if (!existing) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Relation not found",
      });
    }
    const stub = await getStub(c.env, organizationId);
    const issue = await getIssue(stub, existing.fromIssueId);
    await assertIssueAccess(db, issue, identity);
    await stub.deleteIssueRelation(id);
    return c.body(null, 204);
  });
}
