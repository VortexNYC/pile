import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import type { D1Client } from "../global/db.js";
import { createD1 } from "../global/db.js";
import { canAccessTeam } from "../global/teams.js";
import { getProject } from "../global/workspace-entities.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { canAccess } from "../platform/permissions.js";
import { canAccessProject } from "../platform/rls.js";
import { rls } from "../platform/rls.js";
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

type WorkspaceIdentity = {
  id: string;
  type: "user" | "agent";
  permissions: string[];
};

function notFound(message = "External link not found"): never {
  throw new VortexError({ code: "NOT_FOUND", status: 404, message });
}

async function canAccessEntity(
  env: AppContext["Bindings"],
  db: D1Client,
  organizationId: string,
  entityType: string,
  entityId: string,
  identity: WorkspaceIdentity,
  mode: "read" | "write"
): Promise<boolean> {
  const stub = getWorkspaceStub(env, organizationId);
  switch (entityType) {
    case "issue": {
      const issue = await stub.getIssue(entityId);
      if (!issue) return false;
      return canAccessTeam(db, issue.teamId, identity);
    }
    case "project": {
      const project = await getProject(db, organizationId, entityId);
      if (!project) return false;
      return canAccessProject(db, organizationId, project.id, identity, mode);
    }
    case "customer": {
      const customer = await stub.getCustomer(entityId);
      if (!customer) return false;
      if (canAccess(identity.permissions, "admin")) return true;
      if (mode === "read") return true;
      return customer.ownerId === identity.id;
    }
    case "document": {
      const doc = await stub.getDocument(entityId);
      if (!doc) return false;
      if (canAccess(identity.permissions, "admin")) return true;
      if (doc.createdById === identity.id) return true;
      const permissions = await stub.listDocumentPermissions(entityId);
      if (permissions.length === 0) return true;
      const requiredLevel = mode === "write" ? "edit" : "view";
      return permissions.some(
        (p) =>
          p.actorId === identity.id &&
          p.actorType === identity.type &&
          (requiredLevel === "view" || p.level === "edit")
      );
    }
    default:
      return false;
  }
}

async function assertEntityAccess(
  env: AppContext["Bindings"],
  db: D1Client,
  organizationId: string,
  entityType: string,
  entityId: string,
  identity: WorkspaceIdentity,
  mode: "read" | "write",
  message = "Entity not found"
) {
  const allowed = await canAccessEntity(
    env,
    db,
    organizationId,
    entityType,
    entityId,
    identity,
    mode
  );
  if (!allowed) {
    throw new VortexError({ code: "NOT_FOUND", status: 404, message });
  }
}

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

export function registerExternalLinkRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { entityType, entityId } = c.req.valid("query");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    if (entityType && entityId) {
      const db = createD1(c.env.D1);
      await assertEntityAccess(
        c.env,
        db,
        organizationId,
        entityType,
        entityId,
        identity,
        "read"
      );
      const links = await stub.listExternalLinks({ entityType, entityId });
      return c.json({ links });
    }

    const links = await stub.listExternalLinks({
      entityType: entityType ?? undefined,
      entityId: entityId ?? undefined,
    });

    if (links.length === 0) {
      return c.json({ links });
    }

    const db = createD1(c.env.D1);
    const access = await Promise.all(
      links.map(async (link) => ({
        link,
        ok: await canAccessEntity(
          c.env,
          db,
          organizationId,
          link.entityType,
          link.entityId,
          identity,
          "read"
        ),
      }))
    );
    return c.json({ links: access.filter((a) => a.ok).map((a) => a.link) });
  });

  app.openapi(createRouteDef, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    await assertEntityAccess(
      c.env,
      db,
      organizationId,
      input.entityType,
      input.entityId,
      identity,
      "write"
    );
    const stub = getWorkspaceStub(c.env, organizationId);
    const link = await stub.createExternalLink(
      {
        entityType: input.entityType,
        entityId: input.entityId,
        url: input.url,
        label: input.label ?? null,
      },
      identity.id
    );
    return c.json(link!, 201);
  });

  app.openapi(getRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const link = await stub.getExternalLink(id);
    if (!link) notFound();
    const db = createD1(c.env.D1);
    await assertEntityAccess(
      c.env,
      db,
      organizationId,
      link.entityType,
      link.entityId,
      identity,
      "read",
      "External link not found"
    );
    return c.json(link);
  });

  app.openapi(updateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const existing = await stub.getExternalLink(id);
    if (!existing) notFound();
    const db = createD1(c.env.D1);
    await assertEntityAccess(
      c.env,
      db,
      organizationId,
      existing.entityType,
      existing.entityId,
      identity,
      "write",
      "External link not found"
    );
    const nextType = input.entityType ?? existing.entityType;
    const nextId = input.entityId ?? existing.entityId;
    if (nextType !== existing.entityType || nextId !== existing.entityId) {
      await assertEntityAccess(
        c.env,
        db,
        organizationId,
        nextType,
        nextId,
        identity,
        "write"
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
    if (!existing) notFound();
    const db = createD1(c.env.D1);
    await assertEntityAccess(
      c.env,
      db,
      organizationId,
      existing.entityType,
      existing.entityId,
      identity,
      "write",
      "External link not found"
    );
    await stub.deleteExternalLink(id, identity.id);
    return c.body(null, 204);
  });
}
