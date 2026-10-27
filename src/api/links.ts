import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { AppContext } from "../platform/middleware.js";
import { canAccess, isAdminIdentity } from "../platform/permissions.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

// VTX-748 — a link is a write on the two entities it joins, not a
// workspace-settings change. Each side maps to its own edit grant; an
// unmapped entity type falls back to the coarse workspace write grant.
const LINK_ENTITY_RESOURCES: Record<string, string> = {
  issue: "issue",
  document: "document",
  project: "project",
  ticket: "ticket",
  customer: "customer",
  contact: "contact",
  deal: "deal",
  session: "session",
  comment: "comment",
  memory: "memory",
};

const LINK_EDIT_GRANTS = [
  ...Object.values(LINK_ENTITY_RESOURCES).map((r) => `${r}:edit`),
  "write",
];

function assertLinkEditAccess(
  identity: WorkspaceIdentity,
  entityType: string
): void {
  const resource = LINK_ENTITY_RESOURCES[entityType];
  const ok =
    resource === undefined
      ? canAccess(identity.permissions, "write")
      : canAccess(identity.permissions, "edit", resource);
  if (!ok) {
    throw new VortexError({
      code: "FORBIDDEN",
      status: 403,
      message: `Required permission: ${resource ?? "workspace"}:edit`,
    });
  }
}

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

// Strict — a mis-keyed field (e.g. `linkType` instead of `kind`, or the
// docs' old `targetEntityType` names) used to be silently dropped and
// `kind` defaulted to "relates". Now unknown keys 400 (PILE-429).
const createLinkSchema = z
  .object({
    toType: z.string().min(1),
    toId: z.string().min(1),
    kind: z.string().default("relates"),
    label: z.string().optional(),
  })
  .strict();

const entityParam = z.object({
  organizationId: z.string(),
  entityType: z.string(),
  entityId: z.string(),
});

const listLinksRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/entities/{entityType}/{entityId}/links",
  tags: ["links"],
  middleware: [rls("settings:view")],
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
  // Coarse gate first (must be able to edit *something*); the handler
  // applies the precise per-entity check on both ends of the link.
  middleware: [rls(...LINK_EDIT_GRANTS)],
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
  middleware: [rls(...LINK_EDIT_GRANTS)],
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
    const identity = c.get("workspaceIdentity");
    if (!isAdminIdentity(identity)) {
      assertLinkEditAccess(identity, entityType);
      assertLinkEditAccess(identity, body.toType);
    }
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
    const identity = c.get("workspaceIdentity");
    if (!isAdminIdentity(identity)) {
      const existing = await stub.getEntityLink(linkId);
      if (existing) {
        assertLinkEditAccess(identity, existing.fromType);
        assertLinkEditAccess(identity, existing.toType);
      }
    }
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
