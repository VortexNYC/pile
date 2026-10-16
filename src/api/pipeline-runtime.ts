import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const entityTypeSchema = z.enum(["issue", "deal", "customer"]);
const params = z.object({ organizationId: z.string() });
const idParams = z.object({ organizationId: z.string(), id: z.string() });

const stageConfigSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  entityType: entityTypeSchema,
  status: z.string(),
  ownerAgent: z.string().nullable(),
  instructions: z.string().nullable(),
  advancePolicy: z.enum(["none", "auto", "ready_flag"]),
  enabled: z.number(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const upsertStageConfigSchema = z
  .object({
    entityType: entityTypeSchema.optional(),
    /** Stage the config binds to; slug-normalized like stage templates. */
    status: z.string().min(1),
    ownerAgent: z.string().nullable().optional(),
    instructions: z.string().nullable().optional(),
    advancePolicy: z.enum(["none", "auto", "ready_flag"]).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const agentTypeSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  slug: z.string(),
  name: z.string(),
  providerAgentId: z.string(),
  jobSpec: z.string().nullable(),
  toolScope: z.string().nullable(),
  permissionsTier: z.string().nullable(),
  enabled: z.number(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const upsertAgentTypeSchema = z
  .object({
    /** Registry key; slug-normalized ("Sales Scout" → "sales_scout"). */
    slug: z.string().min(1),
    name: z.string().min(1),
    providerAgentId: z.string().min(1),
    jobSpec: z.string().nullable().optional(),
    toolScope: z.string().nullable().optional(),
    permissionsTier: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const listStageConfigsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/stage-configs",
  tags: ["pipeline"],
  middleware: [rls("workspace:read")],
  request: { params },
  responses: {
    200: {
      description: "Stage configs for the workspace",
      content: {
        "application/json": {
          schema: z.object({ configs: z.array(stageConfigSchema) }),
        },
      },
    },
  },
});

const upsertStageConfigRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/stage-configs",
  tags: ["pipeline"],
  middleware: [rls("settings:edit")],
  request: {
    params,
    body: {
      content: { "application/json": { schema: upsertStageConfigSchema } },
    },
  },
  responses: {
    200: {
      description: "Stage config upserted (keyed on entityType + status)",
      content: { "application/json": { schema: stageConfigSchema } },
    },
  },
});

const deleteStageConfigRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/stage-configs/{id}",
  tags: ["pipeline"],
  middleware: [rls("settings:edit")],
  request: { params: idParams },
  responses: {
    200: {
      description: "Stage config deleted",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
    404: { description: "Stage config not found" },
  },
});

const listAgentTypesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent-types",
  tags: ["pipeline"],
  middleware: [rls("workspace:read")],
  request: { params },
  responses: {
    200: {
      description: "Registered agent types for the workspace",
      content: {
        "application/json": {
          schema: z.object({ agentTypes: z.array(agentTypeSchema) }),
        },
      },
    },
  },
});

const upsertAgentTypeRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent-types",
  tags: ["pipeline"],
  middleware: [rls("settings:edit")],
  request: {
    params,
    body: {
      content: { "application/json": { schema: upsertAgentTypeSchema } },
    },
  },
  responses: {
    200: {
      description: "Agent type upserted (keyed on slug)",
      content: { "application/json": { schema: agentTypeSchema } },
    },
  },
});

const deleteAgentTypeRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/agent-types/{id}",
  tags: ["pipeline"],
  middleware: [rls("settings:edit")],
  request: { params: idParams },
  responses: {
    200: {
      description: "Agent type deleted",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
    404: { description: "Agent type not found" },
  },
});

function notFound(what: string): never {
  throw new VortexError({ code: "NOT_FOUND", status: 404, message: what });
}

export function registerPipelineRuntimeRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listStageConfigsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json({ configs: await stub.listStageConfigs() }, 200);
  });

  app.openapi(upsertStageConfigRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const config = await stub.upsertStageConfig({
      ...input,
      createdBy: identity.id,
    });
    return c.json(config, 200);
  });

  app.openapi(deleteStageConfigRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const ok = await stub.deleteStageConfig(id);
    if (!ok) notFound("Stage config not found");
    return c.json({ ok }, 200);
  });

  app.openapi(listAgentTypesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json({ agentTypes: await stub.listAgentTypes() }, 200);
  });

  app.openapi(upsertAgentTypeRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const agentType = await stub.upsertAgentType({
      ...input,
      createdBy: identity.id,
    });
    return c.json(agentType, 200);
  });

  app.openapi(deleteAgentTypeRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const ok = await stub.deleteAgentType(id);
    if (!ok) notFound("Agent type not found");
    return c.json({ ok }, 200);
  });
}
