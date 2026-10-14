import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { getCustomerById } from "../global/support-contacts.js";
import { getProject } from "../global/workspace-entities.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { resolveMentions } from "./mentions.js";
import { getWorkspaceStub } from "./stub.js";

// Record notes — the same comments table issues/documents share, keyed
// by the CRM entity's own type so a note on a deal stays a note on a deal.
const entityCommentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  authorId: z.string().nullable(),
  body: z.string(),
  internal: z.boolean(),
  externalId: z.string().nullable(),
  externalSource: z.string().nullable(),
  externalAuthor: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolvedById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const commentsResponse = {
  "application/json": {
    schema: z.object({ comments: z.array(entityCommentSchema) }),
  },
} as const;
const commentResponse = {
  "application/json": { schema: entityCommentSchema },
} as const;
const bodySchema = z.object({ body: z.string().min(1) });

function notFound(what: string): never {
  throw new VortexError({ code: "NOT_FOUND", status: 404, message: what });
}

type EntityDef = {
  // API surface — where the comments live and which gate guards them.
  path: string;
  idParam: "id" | "dealId" | "customerId";
  entityType: "customer" | "deal" | "contact" | "session" | "project";
  view: string;
  edit: string;
  tag: string;
  exists: (args: {
    stub: ReturnType<typeof getWorkspaceStub>;
    env: WorkerEnv;
    organizationId: string;
    id: string;
  }) => Promise<boolean>;
};

const ENTITIES: EntityDef[] = [
  {
    path: "/workspaces/{organizationId}/customers/{id}/comments",
    idParam: "id",
    entityType: "customer",
    view: "customer:view",
    edit: "customer:edit",
    tag: "customers",
    exists: async ({ stub, id }) => (await stub.getCustomer(id)) != null,
  },
  {
    path: "/workspaces/{organizationId}/deals/{dealId}/comments",
    idParam: "dealId",
    entityType: "deal",
    view: "deal:view",
    edit: "deal:edit",
    tag: "deals",
    exists: async ({ stub, id }) => (await stub.getDeal(id)) !== undefined,
  },
  {
    path: "/workspaces/{organizationId}/support/customers/{customerId}/comments",
    idParam: "customerId",
    entityType: "contact",
    view: "ticket:view",
    edit: "ticket:edit",
    tag: "support-contacts",
    // Contacts live in D1, not the DO — the comment still lands in the
    // workspace DO's comments table.
    exists: async ({ env, organizationId, id }) =>
      (await getCustomerById(createD1(env.D1), organizationId, id)) !== null,
  },
  {
    path: "/workspaces/{organizationId}/agent/sessions/{id}/comments",
    idParam: "id",
    entityType: "session",
    view: "session:view",
    edit: "session:edit",
    tag: "sessions",
    exists: async ({ stub, id }) => (await stub.getAgentSession(id)) != null,
  },
  {
    path: "/workspaces/{organizationId}/projects/{id}/comments",
    idParam: "id",
    entityType: "project",
    view: "project:view",
    edit: "project:edit",
    tag: "projects",
    exists: async ({ env, organizationId, id }) =>
      (await getProject(createD1(env.D1), organizationId, id)) !== null,
  },
];

export function registerEntityCommentRoutes(app: OpenAPIHono<AppContext>) {
  for (const entity of ENTITIES) {
    const params = z.object({
      organizationId: z.string(),
      [entity.idParam]: z.string(),
    });
    const listRoute = createRoute({
      method: "get",
      path: entity.path,
      tags: [entity.tag],
      middleware: [rls(entity.view)],
      request: { params },
      responses: {
        200: { description: "Record comments", content: commentsResponse },
        404: { description: "Record not found" },
      },
    });
    const createCommentRoute = createRoute({
      method: "post",
      path: entity.path,
      tags: [entity.tag],
      middleware: [rls(entity.edit)],
      request: {
        params,
        body: { content: { "application/json": { schema: bodySchema } } },
      },
      responses: {
        201: { description: "Comment created", content: commentResponse },
        404: { description: "Record not found" },
      },
    });

    app.openapi(listRoute, async (c) => {
      const { organizationId } = c.req.valid("param");
      const id = (c.req.valid("param") as Record<string, string>)[
        entity.idParam
      ]!;
      const stub = getWorkspaceStub(c.env, organizationId);
      if (!(await entity.exists({ stub, env: c.env, organizationId, id }))) {
        notFound("Record not found");
      }
      const comments = await stub.listEntityComments(entity.entityType, id);
      return c.json({ comments });
    });

    app.openapi(createCommentRoute, async (c) => {
      const { organizationId } = c.req.valid("param");
      const id = (c.req.valid("param") as Record<string, string>)[
        entity.idParam
      ]!;
      const { body } = c.req.valid("json");
      const stub = getWorkspaceStub(c.env, organizationId);
      if (!(await entity.exists({ stub, env: c.env, organizationId, id }))) {
        notFound("Record not found");
      }
      const identity = c.get("workspaceIdentity");
      const mentions = await resolveMentions(
        createD1(c.env.D1),
        organizationId,
        body
      );
      const comment = await stub.createComment({
        entityType: entity.entityType,
        entityId: id,
        authorId: identity.id,
        body,
        mentions,
      });
      return c.json(comment, 201);
    });
  }
}
