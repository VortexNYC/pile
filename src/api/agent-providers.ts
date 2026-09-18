import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import {
  AGENT_PROVIDER_CATALOG,
  AGENT_SETUP_MODES,
  applyCatalogMode,
  validateProviderSetup,
} from "../agents/catalog.js";
import { resolveAgentEnv } from "../agents/daytona.js";
import { getAgentProvider } from "../agents/index.js";
import type { AgentProviderSession } from "../agents/provider.js";
import { sha256Hex, timingSafeEqualHex } from "../global/crypto.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import type { AgentSessionStatus } from "../types/workspace.js";
import { captureSessionPrArtifact } from "./agent-artifacts.js";
import { getWorkspaceStub } from "./stub.js";

const setupModeSchema = z.enum(AGENT_SETUP_MODES);

const providerConfigInputSchema = z.object({
  mode: setupModeSchema.optional(),
  token: z.string().nullable().optional(),
  providerOrgId: z.string().nullable().optional(),
  computeApiKey: z.string().nullable().optional(),
  computeApiUrl: z.string().nullable().optional(),
  computeSnapshot: z.string().nullable().optional(),
  computeVolumeId: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).nullable().optional(),
  teamIds: z.array(z.string()).nullable().optional(),
});

const providerConfigSchema = z.object({
  agentId: z.string(),
  hasToken: z.boolean(),
  providerOrgId: z.string().nullable(),
  hasComputeApiKey: z.boolean(),
  computeApiUrl: z.string().nullable(),
  computeSnapshot: z.string().nullable(),
  computeVolumeId: z.string().nullable(),
  config: z.record(z.string(), z.unknown()).nullable(),
  teamIds: z.array(z.string()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type ProviderConfigRow = {
  agentId: string;
  token: string | null;
  providerOrgId: string | null;
  computeApiKey: string | null;
  computeApiUrl: string | null;
  computeSnapshot: string | null;
  computeVolumeId: string | null;
  config: string | null;
  teamIds: string | null;
  createdAt: string;
  updatedAt: string;
};

function redactConfig(
  config: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!config) return null;
  if (!("webhookSecret" in config)) return config;
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key !== "webhookSecret") rest[key] = value;
  }
  return { ...rest, hasWebhookSecret: true };
}

function webhookSecretFromConfig(
  configJson: string | null | undefined
): string | null {
  if (!configJson) return null;
  try {
    const value: unknown = JSON.parse(configJson);
    if (typeof value !== "object" || value === null) return null;
    const secret = (value as Record<string, unknown>).webhookSecret;
    return typeof secret === "string" && secret.length > 0 ? secret : null;
  } catch {
    return null;
  }
}

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
  let parsedTeamIds: string[] | null = null;
  if (row.teamIds) {
    try {
      const value: unknown = JSON.parse(row.teamIds);
      if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
        parsedTeamIds = value;
      }
    } catch {
      parsedTeamIds = null;
    }
  }
  return {
    agentId: row.agentId,
    hasToken: row.token !== null && row.token !== "",
    providerOrgId: row.providerOrgId,
    hasComputeApiKey: row.computeApiKey !== null && row.computeApiKey !== "",
    computeApiUrl: row.computeApiUrl,
    computeSnapshot: row.computeSnapshot,
    computeVolumeId: row.computeVolumeId,
    config: redactConfig(parsedConfig),
    teamIds: parsedTeamIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const catalogFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  required: z.boolean(),
  type: z.enum(["text", "secret", "select"]),
  options: z
    .array(z.object({ value: z.string(), label: z.string() }))
    .optional(),
  help: z.string().optional(),
});

const catalogModeSchema = z.object({
  id: setupModeSchema,
  label: z.string(),
  help: z.string().optional(),
  fields: z.array(catalogFieldSchema),
});

const catalogProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  modes: z.array(catalogModeSchema),
});

const catalogRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/providers/catalog",
  tags: ["agent-providers"],
  middleware: [rls("read", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description:
        "Agents a workspace can add, with hosted vs BYO modes and required fields",
      content: {
        "application/json": {
          schema: z.object({ providers: z.array(catalogProviderSchema) }),
        },
      },
    },
  },
});

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

const healthRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/providers/{agentId}/health",
  tags: ["agent-providers"],
  middleware: [rls("admin", "admin")],
  request: {
    params: z.object({
      organizationId: z.string(),
      agentId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Provider credential/config probe",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            message: z.string().optional(),
          }),
        },
      },
    },
  },
});

const webhookRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/providers/{agentId}/hooks",
  tags: ["agent-providers"],
  middleware: [rls("write", "agent:write")],
  request: {
    params: z.object({
      organizationId: z.string(),
      agentId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Webhook accepted",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            sessionId: z.string().optional(),
          }),
        },
      },
    },
    404: { description: "Session not found" },
  },
});

const inboundWebhookRoute = createRoute({
  method: "post",
  path: "/webhooks/agent/{organizationId}/{agentId}",
  tags: ["agent-providers"],
  request: {
    params: z.object({
      organizationId: z.string(),
      agentId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Webhook accepted",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            sessionId: z.string().optional(),
          }),
        },
      },
    },
    401: { description: "Missing or invalid webhook secret" },
    404: { description: "Session not found" },
  },
});

function parseGenericWebhook(body: unknown): {
  sessionId: string;
  session?: AgentProviderSession;
} | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const sessionId = record.session_id ?? record.sessionId ?? record.id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const rawStatus = record.status;
  const allowed: AgentSessionStatus[] = [
    "created",
    "running",
    "waiting",
    "completed",
    "failed",
    "canceled",
  ];
  const status =
    typeof rawStatus === "string" &&
    (allowed as readonly string[]).includes(rawStatus)
      ? (rawStatus as AgentSessionStatus)
      : undefined;
  const result = typeof record.result === "string" ? record.result : undefined;
  const prUrl =
    typeof record.prUrl === "string"
      ? record.prUrl
      : typeof record.pr_url === "string"
        ? record.pr_url
        : undefined;
  const prState =
    typeof record.prState === "string"
      ? record.prState
      : typeof record.pr_state === "string"
        ? record.pr_state
        : undefined;
  return {
    sessionId,
    session: status
      ? {
          id: sessionId,
          agentId: "",
          status,
          result,
          prUrl,
          prState,
        }
      : undefined,
  };
}

function bearerOrHeaderSecret(c: {
  req: { header: (name: string) => string | undefined };
}): string {
  const header = c.req.header("x-pile-webhook-secret");
  if (header && header.length > 0) return header;
  const auth = c.req.header("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return "";
}

async function secretsMatch(
  provided: string,
  expected: string
): Promise<boolean> {
  return timingSafeEqualHex(
    await sha256Hex(provided),
    await sha256Hex(expected)
  );
}

async function applyInboundWebhook(
  env: WorkerEnv,
  organizationId: string,
  agentId: string,
  body: unknown,
  headers: Headers
): Promise<{ ok: true; sessionId: string } | { notFound: true }> {
  const stub = getWorkspaceStub(env, organizationId);
  const row = await stub.getAgentProviderConfig(agentId);
  const effectiveEnv = resolveAgentEnv(env, row ?? undefined);
  const provider = getAgentProvider(agentId, effectiveEnv);
  const parsed =
    provider.parseWebhook?.(body, headers) ?? parseGenericWebhook(body);
  if (!parsed) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Webhook payload did not include a session id",
    });
  }
  const session =
    (await stub.getAgentSessionByProviderSessionId(parsed.sessionId)) ??
    (await stub.getAgentSession(parsed.sessionId));
  if (!session) {
    return { notFound: true };
  }
  if (parsed.session) {
    await stub.applyAgentSessionResult(session.id, {
      status: parsed.session.status,
      result: parsed.session.result,
      url: parsed.session.url,
      providerSessionId: parsed.session.id,
      prUrl: parsed.session.prUrl,
      prState: parsed.session.prState,
      branch: parsed.session.branch,
    });
    await captureSessionPrArtifact(
      stub,
      session.id,
      undefined,
      parsed.session.prUrl
    );
  }
  await stub.addAgentActivity({
    sessionId: session.id,
    type: "status",
    message: parsed.session
      ? `webhook: ${parsed.session.status}`
      : "webhook received",
    payload: { source: "webhook" },
  });
  return { ok: true, sessionId: session.id };
}

export function registerAgentProviderRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(catalogRoute, async (c) => {
    return c.json({ providers: AGENT_PROVIDER_CATALOG });
  });

  app.openapi(listConfigsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const rows = await stub.listAgentProviderConfigs();
    return c.json(rows.map(redact), 200);
  });

  app.openapi(upsertConfigRoute, async (c) => {
    const { organizationId, agentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { mode, ...fields } = body;
    if (mode) {
      validateProviderSetup(agentId, mode, body);
    }
    const config = mode
      ? applyCatalogMode(agentId, mode, fields.config ?? undefined)
      : fields.config;
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.upsertAgentProviderConfig({
      agentId,
      ...fields,
      config,
    });
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

  app.openapi(healthRoute, async (c) => {
    const { organizationId, agentId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const row = await stub.getAgentProviderConfig(agentId);
    const effectiveEnv = resolveAgentEnv(c.env, row ?? undefined);
    const provider = getAgentProvider(agentId, effectiveEnv);
    if (!provider.health) {
      return c.json({ ok: false, message: "Health check not supported" });
    }
    try {
      return c.json(await provider.health());
    } catch (err) {
      return c.json({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.openapi(webhookRoute, async (c) => {
    const { organizationId, agentId } = c.req.valid("param");
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const result = await applyInboundWebhook(
      c.env,
      organizationId,
      agentId,
      body,
      c.req.raw.headers
    );
    if ("notFound" in result) {
      return c.json({ message: "Session not found" }, 404);
    }
    return c.json(result);
  });

  app.openapi(inboundWebhookRoute, async (c) => {
    const { organizationId, agentId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const row = await stub.getAgentProviderConfig(agentId);
    const expected = webhookSecretFromConfig(row?.config);
    if (!expected) {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Provider webhook secret is not configured",
      });
    }
    const provided = bearerOrHeaderSecret(c);
    if (!(await secretsMatch(provided, expected))) {
      throw new VortexError({
        code: "UNAUTHORIZED",
        status: 401,
        message: "Invalid webhook secret",
      });
    }
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }
    const result = await applyInboundWebhook(
      c.env,
      organizationId,
      agentId,
      body,
      c.req.raw.headers
    );
    if ("notFound" in result) {
      return c.json({ message: "Session not found" }, 404);
    }
    return c.json(result);
  });
}
