import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const providerConfigInputSchema = z.object({
  token: z.string().nullable().optional(),
  providerOrgId: z.string().nullable().optional(),
  outpost: z.string().nullable().optional(),
  outpostId: z.string().nullable().optional(),
  outpostToken: z.string().nullable().optional(),
  computeApiKey: z.string().nullable().optional(),
  computeApiUrl: z.string().nullable().optional(),
  computeSnapshot: z.string().nullable().optional(),
  computeVolumeId: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
});

const providerConfigSchema = z.object({
  agentId: z.string(),
  hasToken: z.boolean(),
  providerOrgId: z.string().nullable(),
  outpost: z.string().nullable(),
  hasOutpostToken: z.boolean(),
  hasComputeApiKey: z.boolean(),
  computeApiUrl: z.string().nullable(),
  computeSnapshot: z.string().nullable(),
  computeVolumeId: z.string().nullable(),
  config: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type ProviderConfigRow = {
  agentId: string;
  token: string | null;
  providerOrgId: string | null;
  outpost: string | null;
  outpostToken: string | null;
  computeApiKey: string | null;
  computeApiUrl: string | null;
  computeSnapshot: string | null;
  computeVolumeId: string | null;
  config: string | null;
  createdAt: string;
  updatedAt: string;
};

function redact(row: ProviderConfigRow) {
  let parsedConfig: Record<string, unknown> | null = null;
  if (row.config) {
    try {
      const value: unknown = JSON.parse(row.config);
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        parsedConfig = value as Record<string, unknown>;
      }
    } catch {
      parsedConfig = null;
    }
  }
  return {
    agentId: row.agentId,
    hasToken: row.token !== null && row.token !== "",
    providerOrgId: row.providerOrgId,
    outpost: row.outpost,
    hasOutpostToken: row.outpostToken !== null && row.outpostToken !== "",
    hasComputeApiKey: row.computeApiKey !== null && row.computeApiKey !== "",
    computeApiUrl: row.computeApiUrl,
    computeSnapshot: row.computeSnapshot,
    computeVolumeId: row.computeVolumeId,
    config: parsedConfig,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const listConfigsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/providers",
  tags: ["agent-providers"],
  middleware: [rls("read", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Agent provider configs (secrets redacted)",
      content: {
        "application/json": { schema: z.array(providerConfigSchema) },
      },
    },
  },
});

const upsertConfigRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/agent/providers/{agentId}",
  tags: ["agent-providers"],
  middleware: [rls("admin", "admin")],
  request: {
    params: z.object({
      organizationId: z.string(),
      agentId: z.string(),
    }),
    body: {
      content: {
        "application/json": { schema: providerConfigInputSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Provider config saved (secrets redacted)",
      content: {
        "application/json": { schema: providerConfigSchema },
      },
    },
  },
});

const deleteConfigRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/agent/providers/{agentId}",
  tags: ["agent-providers"],
  middleware: [rls("admin", "admin")],
  request: {
    params: z.object({
      organizationId: z.string(),
      agentId: z.string(),
    }),
  },
  responses: {
    204: { description: "Provider config deleted" },
  },
});

export function registerAgentProviderRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listConfigsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const rows = await stub.listAgentProviderConfigs();
    return c.json(rows.map(redact), 200);
  });

  app.openapi(upsertConfigRoute, async (c) => {
    const { organizationId, agentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.upsertAgentProviderConfig({ agentId, ...body });
    const row = await stub.getAgentProviderConfig(agentId);
    if (!row) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 500,
        message: "Failed to save provider config",
      });
    }
    return c.json(redact(row), 200);
  });

  app.openapi(deleteConfigRoute, async (c) => {
    const { organizationId, agentId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.deleteAgentProviderConfig(agentId);
    return c.body(null, 204);
  });
}
