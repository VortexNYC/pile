import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";
import { hasAgentProvider } from "../agents/index.js";

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
  prompt: z.string().nullable(),
  model: z.string().nullable(),
  tools: z.string().nullable(),
  kind: z.string(),
  endpointUrl: z.string().nullable(),
  hasEndpointSecret: z.boolean(),
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
    /** System prompt the profile runs with. */
    prompt: z.string().nullable().optional(),
    /** Model tier or id. */
    model: z.string().nullable().optional(),
    /** JSON allowlist of tool names. */
    tools: z.string().nullable().optional(),
    /** "agent" runs a provider lane; "human" owns steps without dispatch;
     *  "external" POSTs the dispatch payload to endpointUrl. */
    kind: z.enum(["agent", "human", "external"]).optional(),
    endpointUrl: z.string().url().nullable().optional(),
    /** Bearer the endpoint verifies — write-only, never returned. */
    endpointSecret: z.string().nullable().optional(),
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

const getStageConfigRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/stage-configs/{id}",
  tags: ["pipeline"],
  middleware: [rls("workspace:read")],
  request: { params: idParams },
  responses: {
    200: {
      description: "Stage config",
      content: { "application/json": { schema: stageConfigSchema } },
    },
    404: { description: "Stage config not found" },
  },
});

const patchStageConfigSchema = z
  .object({
    ownerAgent: z.string().nullable().optional(),
    instructions: z.string().nullable().optional(),
    advancePolicy: z.enum(["none", "auto", "ready_flag"]).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const patchStageConfigRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/stage-configs/{id}",
  tags: ["pipeline"],
  middleware: [rls("settings:edit")],
  request: {
    params: idParams,
    body: {
      content: { "application/json": { schema: patchStageConfigSchema } },
    },
  },
  responses: {
    200: {
      description: "Stage config updated",
      content: { "application/json": { schema: stageConfigSchema } },
    },
    404: { description: "Stage config not found" },
  },
});

const getAgentTypeRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent-types/{id}",
  tags: ["pipeline"],
  middleware: [rls("workspace:read")],
  request: { params: idParams },
  responses: {
    200: {
      description: "Agent type",
      content: { "application/json": { schema: agentTypeSchema } },
    },
    404: { description: "Agent type not found" },
  },
});

const patchAgentTypeSchema = z
  .object({
    slug: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    providerAgentId: z.string().min(1).optional(),
    kind: z.enum(["agent", "human", "external"]).optional(),
    endpointUrl: z.string().url().nullable().optional(),
    endpointSecret: z.string().nullable().optional(),
    prompt: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    tools: z.string().nullable().optional(),
    jobSpec: z.string().nullable().optional(),
    toolScope: z.string().nullable().optional(),
    permissionsTier: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const patchAgentTypeRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/agent-types/{id}",
  tags: ["pipeline"],
  middleware: [rls("settings:edit")],
  request: {
    params: idParams,
    body: {
      content: { "application/json": { schema: patchAgentTypeSchema } },
    },
  },
  responses: {
    200: {
      description: "Agent type updated",
      content: { "application/json": { schema: agentTypeSchema } },
    },
    400: { description: "Unknown providerAgentId" },
    404: { description: "Agent type not found" },
  },
});

const lintFindingSchema = z.object({
  kind: z.enum([
    "unknown_provider",
    "unresolved_owner_template",
    "unresolved_owner_config",
  ]),
  id: z.string(),
  detail: z.string(),
});

const pipelineLintRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/pipeline/lint",
  tags: ["pipeline"],
  middleware: [rls("workspace:read")],
  request: { params },
  responses: {
    200: {
      description:
        "Referential-integrity lint: agent types pointing at unknown providers, and stage templates/configs whose ownerAgent slug has no agent type",
      content: {
        "application/json": {
          schema: z.object({ findings: z.array(lintFindingSchema) }),
        },
      },
    },
  },
});

/** Strip the encrypted webhook bearer from responses — the wire exposes
 *  hasEndpointSecret, never the ciphertext or plaintext. */
function serializeAgentType<T extends { endpointSecret?: unknown }>(
  t: T
): Omit<T, "endpointSecret"> & { hasEndpointSecret: boolean } {
  const { endpointSecret, ...rest } = t;
  return { ...rest, hasEndpointSecret: Boolean(endpointSecret) };
}

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
    const types = await stub.listAgentTypes();
    return c.json({ agentTypes: types.map(serializeAgentType) }, 200);
  });

  app.openapi(upsertAgentTypeRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    // PILE-437 — reject provider ids that don't resolve at write time;
    // a typo'd providerAgentId otherwise fails silently at dispatch.
    if (!hasAgentProvider(input.providerAgentId)) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: `Unknown agent provider: ${input.providerAgentId}`,
      });
    }
    const stub = getWorkspaceStub(c.env, organizationId);
    const agentType = await stub.upsertAgentType({
      ...input,
      createdBy: identity.id,
    });
    return c.json(serializeAgentType(agentType), 200);
  });

  app.openapi(getStageConfigRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const config = await stub.getStageConfigById(id);
    if (!config) notFound("Stage config not found");
    return c.json(config, 200);
  });

  app.openapi(patchStageConfigRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const patch = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const config = await stub.updateStageConfig(id, patch);
    if (!config) notFound("Stage config not found");
    return c.json(config, 200);
  });

  app.openapi(getAgentTypeRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const agentType = await stub.getAgentTypeById(id);
    if (!agentType) notFound("Agent type not found");
    return c.json(serializeAgentType(agentType), 200);
  });

  app.openapi(patchAgentTypeRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const patch = c.req.valid("json");
    if (patch.providerAgentId && !hasAgentProvider(patch.providerAgentId)) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: `Unknown agent provider: ${patch.providerAgentId}`,
      });
    }
    const stub = getWorkspaceStub(c.env, organizationId);
    const agentType = await stub.updateAgentType(id, patch);
    if (!agentType) notFound("Agent type not found");
    return c.json(serializeAgentType(agentType), 200);
  });

  app.openapi(pipelineLintRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const [types, templates, configs] = await Promise.all([
      stub.listAgentTypes(),
      stub.listStageTemplates(),
      stub.listStageConfigs(),
    ]);
    const slugs = new Set(types.map((t) => t.slug));
    const findings: Array<{
      kind:
        | "unknown_provider"
        | "unresolved_owner_template"
        | "unresolved_owner_config";
      id: string;
      detail: string;
    }> = [];
    for (const t of types) {
      if (!hasAgentProvider(t.providerAgentId)) {
        findings.push({
          kind: "unknown_provider",
          id: t.id,
          detail: `agent type "${t.slug}" binds unknown provider "${t.providerAgentId}"`,
        });
      }
    }
    for (const t of templates) {
      if (t.ownerAgent && !slugs.has(t.ownerAgent)) {
        findings.push({
          kind: "unresolved_owner_template",
          id: t.id,
          detail: `template "${t.title}" (${t.entityType}/${t.status}) owns to unregistered slug "${t.ownerAgent}"`,
        });
      }
    }
    for (const cfg of configs) {
      if (cfg.ownerAgent && !slugs.has(cfg.ownerAgent)) {
        findings.push({
          kind: "unresolved_owner_config",
          id: cfg.id,
          detail: `stage config (${cfg.entityType}/${cfg.status}) owns to unregistered slug "${cfg.ownerAgent}"`,
        });
      }
    }
    return c.json({ findings }, 200);
  });

  app.openapi(deleteAgentTypeRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const ok = await stub.deleteAgentType(id);
    if (!ok) notFound("Agent type not found");
    return c.json({ ok }, 200);
  });
}
