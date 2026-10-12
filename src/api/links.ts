import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const linkSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  fromType: z.string(),
  fromId: z.string(),
  toType: z.string(),
  toId: z.string(),
  kind: z.string(),
  label: z.string().nullable(),
  createdAt: z.string(),
});

const createLinkSchema = z.object({
  toType: z.string().min(1),
  toId: z.string().min(1),
  kind: z.string().default("relates"),
  label: z.string().optional(),
});

const entityParam = z.object({
  organizationId: z.string(),
  entityType: z.string(),
  entityId: z.string(),
});

const listLinksRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/entities/{entityType}/{entityId}/links",
  tags: ["links"],
  middleware: [rls("read")],
  request: { params: entityParam },
  responses: {
    200: {
      description: "Edges for a node — both directions",
      content: {
        "application/json": {
          schema: z.object({ links: z.array(linkSchema) }),
        },
      },
    },
  },
});

const createLinkRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/entities/{entityType}/{entityId}/links",
  tags: ["links"],
  middleware: [rls("write")],
  request: {
    params: entityParam,
    body: { content: { "application/json": { schema: createLinkSchema } } },
  },
  responses: {
    201: {
      description: "Linked",
      content: {
        "application/json": { schema: z.object({ link: linkSchema }) },
      },
    },
  },
});

const deleteLinkRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/links/{linkId}",
  tags: ["links"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), linkId: z.string() }),
  },
  responses: {
    200: {
      description: "Unlinked",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
  },
});

/** The edges API — every entity's rail renders these, both directions. */
export function registerLinkRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listLinksRoute, async (c) => {
    const { organizationId, entityType, entityId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json(
      { links: await stub.listEntityLinks(entityType, entityId) },
      200
    );
  });

  app.openapi(createLinkRoute, async (c) => {
    const { organizationId, entityType, entityId } = c.req.valid("param");
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const link = await stub.linkEntities({
      fromType: entityType,
      fromId: entityId,
      toType: body.toType,
      toId: body.toId,
      kind: body.kind,
      label: body.label,
    });
    return c.json({ link }, 201);
  });

  app.openapi(deleteLinkRoute, async (c) => {
    const { organizationId, linkId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const ok = await stub.unlinkEntities(linkId);
    if (!ok) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Link not found",
      });
    }
    return c.json({ ok }, 200);
  });
}
