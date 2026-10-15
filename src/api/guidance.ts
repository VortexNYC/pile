import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

// PILE-423 — guidance packs (Linear's "Guidance"): scoped markdown
// instruction blocks injected into every dispatched lane's prompt envelope.
// Scopes resolve least→most specific (workspace → team → status → step) so
// the most specific pack lands last. Packs are versioned — every edit bumps
// `version` and snapshots the revision; each agent session records the pack
// versions it was dispatched with.

const guidanceScopeSchema = z.enum(["workspace", "team", "status", "step"]);

const guidanceLinkSchema = z.object({
  label: z.string().optional(),
  url: z.string(),
});

const guidancePackSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  scope: guidanceScopeSchema,
  /** Team id / workflow-status value / step key; null for workspace packs. */
  scopeKey: z.string().nullable(),
  body: z.string(),
  links: z.array(guidanceLinkSchema).nullable(),
  version: z.number().int(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const guidancePackVersionSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  packId: z.string(),
  version: z.number().int(),
  name: z.string(),
  body: z.string(),
  links: z.array(guidanceLinkSchema).nullable(),
  actorId: z.string().nullable(),
  createdAt: z.string(),
});

const createGuidancePackSchema = z
  .object({
    name: z.string().min(1),
    scope: guidanceScopeSchema,
    scopeKey: z.string().min(1).nullable().optional(),
    body: z.string().min(1),
    links: z.array(guidanceLinkSchema).optional(),
  })
  .strict();

const updateGuidancePackSchema = z
  .object({
    name: z.string().min(1).optional(),
    scope: guidanceScopeSchema.optional(),
    scopeKey: z.string().min(1).nullable().optional(),
    body: z.string().min(1).optional(),
    links: z.array(guidanceLinkSchema).nullable().optional(),
  })
  .strict();

function parseLinks(raw: string | null) {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toPackResponse(row: {
  id: string;
  organizationId: string;
  name: string;
  scope: "workspace" | "team" | "status" | "step";
  scopeKey: string | null;
  body: string;
  links: string | null;
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}) {
  return { ...row, links: parseLinks(row.links) };
}

function toVersionResponse(row: {
  id: string;
  organizationId: string;
  packId: string;
  version: number;
  name: string;
  body: string;
  links: string | null;
  actorId: string | null;
  createdAt: string;
}) {
  return { ...row, links: parseLinks(row.links) };
}

function assertScopeKey(
  scope: "workspace" | "team" | "status" | "step",
  scopeKey: string | null | undefined
) {
  if (scope === "workspace") {
    if (scopeKey) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "scopeKey is not valid for workspace-scoped packs",
      });
    }
    return;
  }
  if (!scopeKey) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: `scopeKey is required for ${scope}-scoped packs`,
    });
  }
}

const listGuidancePacksRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/guidance",
  tags: ["agents"],
  middleware: [rls("session:view", "agent:read")],
  description:
    "List guidance packs for the workspace. Optional scope/scopeKey filters narrow to one attachment level.",
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      scope: guidanceScopeSchema.optional(),
      scopeKey: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Guidance packs",
      content: {
        "application/json": {
          schema: z.object({ packs: z.array(guidancePackSchema) }),
        },
      },
    },
  },
});

const createGuidancePackRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/guidance",
  tags: ["agents"],
  middleware: [rls("session:create", "agent:write")],
  description:
    "Create a guidance pack. scope=workspace applies to every lane; team/status/step packs match scopeKey against the issue's teamId, its workflow status, and the session's stepKey.",
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: { "application/json": { schema: createGuidancePackSchema } },
    },
  },
  responses: {
    201: {
      description: "Guidance pack created (version 1)",
      content: {
        "application/json": { schema: guidancePackSchema },
      },
    },
  },
});

const getGuidancePackRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/guidance/{id}",
  tags: ["agents"],
  middleware: [rls("session:view", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Guidance pack",
      content: {
        "application/json": { schema: guidancePackSchema },
      },
    },
    404: { description: "Guidance pack not found" },
  },
});

const listGuidancePackVersionsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/guidance/{id}/versions",
  tags: ["agents"],
  middleware: [rls("session:view", "agent:read")],
  description:
    "Revision history of a pack — one row per version, including versions recorded on sessions dispatched before a delete.",
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Guidance pack versions",
      content: {
        "application/json": {
          schema: z.object({
            versions: z.array(guidancePackVersionSchema),
          }),
        },
      },
    },
  },
});

const updateGuidancePackRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/agent/guidance/{id}",
  tags: ["agents"],
  middleware: [rls("session:create", "agent:write")],
  description:
    "Edit a guidance pack — bumps version and snapshots the revision. Sessions dispatched afterwards pick up the new version; existing sessions keep the refs they recorded.",
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: { "application/json": { schema: updateGuidancePackSchema } },
    },
  },
  responses: {
    200: {
      description: "Guidance pack updated",
      content: {
        "application/json": { schema: guidancePackSchema },
      },
    },
    404: { description: "Guidance pack not found" },
  },
});

const deleteGuidancePackRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/agent/guidance/{id}",
  tags: ["agents"],
  middleware: [rls("session:create", "agent:write")],
  description:
    "Delete a guidance pack. Version snapshots are kept so sessions that ran with it still resolve their recorded refs.",
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Guidance pack deleted",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
    404: { description: "Guidance pack not found" },
  },
});

export function registerGuidanceRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listGuidancePacksRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { scope, scopeKey } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const packs = await stub.listGuidancePacks({
      ...(scope ? { scope } : {}),
      ...(scopeKey !== undefined ? { scopeKey } : {}),
    });
    return c.json({ packs: packs.map(toPackResponse) }, 200);
  });

  app.openapi(createGuidancePackRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    assertScopeKey(body.scope, body.scopeKey);
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const pack = await stub.createGuidancePack(
      {
        name: body.name,
        scope: body.scope,
        scopeKey: body.scope === "workspace" ? null : (body.scopeKey ?? null),
        body: body.body,
        links: body.links ? JSON.stringify(body.links) : null,
      },
      { actorId: identity.id, actorType: identity.type }
    );
    return c.json(toPackResponse(pack), 201);
  });

  app.openapi(getGuidancePackRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const pack = await stub.getGuidancePack(id);
    if (!pack) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Guidance pack not found",
      });
    }
    return c.json(toPackResponse(pack), 200);
  });

  app.openapi(listGuidancePackVersionsRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const versions = await stub.listGuidancePackVersions(id);
    return c.json({ versions: versions.map(toVersionResponse) }, 200);
  });

  app.openapi(updateGuidancePackRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const pack = await stub.updateGuidancePack(
      id,
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.scope !== undefined ? { scope: body.scope } : {}),
        ...(body.scopeKey !== undefined ? { scopeKey: body.scopeKey } : {}),
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.links !== undefined
          ? { links: body.links === null ? null : JSON.stringify(body.links) }
          : {}),
      },
      { actorId: identity.id, actorType: identity.type }
    );
    if (!pack) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Guidance pack not found",
      });
    }
    return c.json(toPackResponse(pack), 200);
  });

  app.openapi(deleteGuidancePackRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    const ok = await stub.deleteGuidancePack(id, {
      actorId: identity.id,
      actorType: identity.type,
    });
    if (!ok) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Guidance pack not found",
      });
    }
    return c.json({ ok: true }, 200);
  });
}
