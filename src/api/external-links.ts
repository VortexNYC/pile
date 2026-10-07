import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { getProject } from "../global/workspace-entities.js";
import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { assertIssueAccess, issueViewer } from "./issue-access.js";
import { getWorkspaceStub } from "./stub.js";

const entityTypeSchema = z.enum(["issue", "project", "customer", "document"]);

const linkSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  url: z.string(),
  label: z.string().nullable(),
  createdAt: z.string(),
});

const bodySchema = z.object({
  entityType: entityTypeSchema,
  entityId: z.string(),
  url: z.string().url(),
  label: z.string().optional(),
});

const listRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/external-links",
  tags: ["external-links"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      entityType: entityTypeSchema.optional(),
      entityId: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "External links",
      content: {
        "application/json": {
          schema: z.object({ links: z.array(linkSchema) }),
        },
      },
    },
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/external-links",
  tags: ["external-links"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: { content: { "application/json": { schema: bodySchema } } },
  },
  responses: {
    201: {
      description: "External link created",
      content: { "application/json": { schema: linkSchema } },
    },
    404: { description: "Entity not found" },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/external-links/{id}",
  tags: ["external-links"],
  middleware: [rls("read")],
  request: { params: z.object({ organizationId: z.string(), id: z.string() }) },
  responses: {
    200: {
      description: "External link",
      content: { "application/json": { schema: linkSchema } },
    },
    404: { description: "External link not found" },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/external-links/{id}",
  tags: ["external-links"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: { content: { "application/json": { schema: bodySchema.partial() } } },
  },
  responses: {
    200: {
      description: "External link updated",
      content: { "application/json": { schema: linkSchema } },
    },
    404: { description: "External link not found" },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/external-links/{id}",
  tags: ["external-links"],
  middleware: [rls("write")],
  request: { params: z.object({ organizationId: z.string(), id: z.string() }) },
  responses: {
    204: { description: "External link deleted" },
    404: { description: "External link not found" },
  },
});

async function checkEntityAccess(
  env: AppContext["Bindings"],
  db: ReturnType<typeof createD1>,
  organizationId: string,
  entityType: string,
  entityId: string,
  identity: WorkspaceIdentity
) {
  const stub = getWorkspaceStub(env, organizationId);
  switch (entityType) {
    case "issue": {
      const issue = await stub.getIssue(entityId);
      if (!issue)
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Issue not found",
        });
      await assertIssueAccess(db, stub, issue, identity);
      return issue.id;
    }
    case "project": {
      const project = await getProject(db, organizationId, entityId);
      if (!project)
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Project not found",
        });
      return entityId;
    }
    case "customer": {
      const customer = await stub.getCustomer(entityId);
      if (!customer)
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Customer not found",
        });
      return entityId;
    }
    case "document": {
      const doc = await stub.getDocument(entityId);
      if (!doc)
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Document not found",
        });
      return entityId;
    }
    default:
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Unsupported entity type",
      });
  }
}

// Link-scoped routes deny access when the link targets a restricted issue
// — the row exposes the issue id and its linked URL.
async function assertLinkEntityAccess(
  env: AppContext["Bindings"],
  db: ReturnType<typeof createD1>,
  organizationId: string,
  link: { entityType: string; entityId: string },
  identity: WorkspaceIdentity
): Promise<void> {
  if (link.entityType !== "issue") return;
  const stub = getWorkspaceStub(env, organizationId);
  const issue = await stub.getIssue(link.entityId);
  if (!issue) return;
  await assertIssueAccess(db, stub, issue, identity);
}

export function registerExternalLinkRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { entityType, entityId } = c.req.valid("query");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);
    let resolvedEntityId: string | undefined;
    if (
      entityId !== undefined &&
      (entityType === undefined || entityType === "issue")
    ) {
      // An explicit issue filter is a read on that issue — enforce grants.
      const issue = await stub.getIssue(entityId);
      if (issue) {
        await assertIssueAccess(db, stub, issue, identity);
        resolvedEntityId = issue.id;
      } else {
        resolvedEntityId = entityId;
      }
    } else {
      resolvedEntityId = entityId;
    }
    const links = await stub.listExternalLinks(
      {
        entityType: entityType ?? undefined,
        entityId: resolvedEntityId,
      },
      await issueViewer(db, identity)
    );
    return c.json({ links });
  });

  app.openapi(createRouteDef, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const entityId = await checkEntityAccess(
      c.env,
      db,
      organizationId,
      input.entityType,
      input.entityId,
      identity
    );
    const stub = getWorkspaceStub(c.env, organizationId);
    const link = await stub.createExternalLink(
      {
        entityType: input.entityType,
        entityId,
        url: input.url,
        label: input.label ?? null,
      },
      identity.id
    );
    return c.json(link!, 201);
  });

  app.openapi(getRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const link = await stub.getExternalLink(id);
    if (!link)
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "External link not found",
      });
    try {
      await assertLinkEntityAccess(c.env, db, organizationId, link, identity);
    } catch (err) {
      if (!(err instanceof VortexError)) throw err;
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "External link not found",
      });
    }
    return c.json(link);
  });

  app.openapi(updateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const existing = await stub.getExternalLink(id);
    if (!existing)
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "External link not found",
      });
    const db = createD1(c.env.D1);
    try {
      await assertLinkEntityAccess(
        c.env,
        db,
        organizationId,
        existing,
        identity
      );
    } catch (err) {
      if (!(err instanceof VortexError)) throw err;
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "External link not found",
      });
    }
    if (input.entityType || input.entityId) {
      await checkEntityAccess(
        c.env,
        db,
        organizationId,
        input.entityType ?? existing.entityType,
        input.entityId ?? existing.entityId,
        identity
      );
    }
    const link = await stub.updateExternalLink(
      id,
      {
        url: input.url,
        label: input.label,
      },
      identity.id
    );
    return c.json(link!);
  });

  app.openapi(deleteRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const existing = await stub.getExternalLink(id);
    if (!existing)
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "External link not found",
      });
    try {
      await assertLinkEntityAccess(
        c.env,
        createD1(c.env.D1),
        organizationId,
        existing,
        identity
      );
    } catch (err) {
      if (!(err instanceof VortexError)) throw err;
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "External link not found",
      });
    }
    await stub.deleteExternalLink(id, identity.id);
    return c.body(null, 204);
  });
}
