import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import {
  AGENT_PROVIDER_CATALOG,
  AGENT_SETUP_MODES,
  applyCatalogMode,
  validateProviderSetup,
} from "../agents/catalog.js";
import {
  decryptProviderConfigRow,
  encryptProviderConfigInput,
  loadProviderConfig,
} from "../agents/credentials.js";
import { resolveAgentEnv } from "../agents/daytona.js";
import { getAgentProvider } from "../agents/index.js";
import type { AgentProviderSession } from "../agents/provider.js";
import { sha256Hex, timingSafeEqualHex } from "../global/crypto.js";
import { createD1 } from "../global/db.js";
import { listGithubInstallations } from "../global/github-installations.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import type { AgentSessionStatus } from "../types/workspace.js";
import { captureSessionPrArtifact } from "./agent-artifacts.js";
import { getWorkspaceStub } from "./stub.js";

const COMPUTE_PROVIDERS = new Set(["cloudflare", "daytona"]);

/** Which deployment env var satisfies each provider's credential need. */
const PROVIDER_ENV_CREDENTIALS: Record<string, (env: WorkerEnv) => boolean> = {
  devin: (e) => !!e.DEVIN_TOKEN,
  "devin-cli": (e) => !!e.DEVIN_CLI_CREDENTIALS_B64,
  cursor: (e) => !!e.AGENT_PROVIDER_TOKEN,
  "cursor-cli": (e) => !!(e.CURSOR_API_KEY ?? e.AGENT_PROVIDER_TOKEN),
  codex: (e) => !!e.OPENAI_API_KEY,
  "codex-cli": (e) => !!e.CODEX_AUTH_JSON_B64,
  "cf-agent": () => true,
  flue: () => true,
};

function configComputeProvider(
  configJson: string | null | undefined
): string | undefined {
  if (!configJson) return undefined;
  try {
    const parsed: unknown = JSON.parse(configJson);
    const v = (parsed as Record<string, unknown> | null)?.computeProvider;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

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

async function redact(env: WorkerEnv, row: ProviderConfigRow) {
  row = (await decryptProviderConfigRow(env, row)) ?? row;
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

const setupStatusRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/setup-status",
  tags: ["agent-providers"],
  middleware: [rls("read", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description:
        "Per-provider onboarding readiness: credentials source, compute backend, and what's still missing before first dispatch",
      content: {
        "application/json": {
          schema: z.object({
            githubConnected: z.boolean(),
            providers: z.array(
              z.object({
                agentId: z.string(),
                credentials: z.enum(["workspace", "deployment", "none"]),
                computeProvider: z.string(),
                computeCredentials: z.enum(["workspace", "deployment", "none"]),
                missing: z.array(z.string()),
                ready: z.boolean(),
              })
            ),
          }),
        },
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
  const row = await loadProviderConfig(env, stub, agentId);
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
    return c.json(await Promise.all(rows.map((r) => redact(c.env, r))), 200);
  });

  app.openapi(setupStatusRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const d1 = createD1(c.env.D1);
    const installations = await listGithubInstallations(d1, organizationId);
    // Installations are recorded per-repo on first use; the GitHub App env
    // config alone also enables write-back, so either counts as connected.
    const githubConnected = installations.length > 0 || !!c.env.GITHUB_APP_ID;
    const rows = await stub.listAgentProviderConfigs();
    const byAgent = new Map(rows.map((r) => [r.agentId, r]));

    const providers = await Promise.all(
      AGENT_PROVIDER_CATALOG.map(async (catalogEntry) => {
        const agentId = catalogEntry.id;
        const row = byAgent.get(agentId);
        const decrypted = row
          ? await decryptProviderConfigRow(c.env, row)
          : null;
        const hasWorkspaceToken = !!decrypted?.token;
        const envCheck = PROVIDER_ENV_CREDENTIALS[agentId];
        const credentials = hasWorkspaceToken
          ? ("workspace" as const)
          : envCheck?.(c.env)
            ? ("deployment" as const)
            : ("none" as const);

        const computeProvider =
          configComputeProvider(decrypted?.config) ??
          c.env.COMPUTE_PROVIDER ??
          "daytona";
        const computeCredentials =
          computeProvider === "cloudflare"
            ? ("deployment" as const)
            : decrypted?.computeApiKey
              ? ("workspace" as const)
              : c.env.DAYTONA_API_KEY
                ? ("deployment" as const)
                : ("none" as const);

        const missing: string[] = [];
        if (credentials === "none") missing.push("credentials");
        if (computeCredentials === "none") missing.push("compute credentials");
        if (!githubConnected) missing.push("github installation");
        return {
          agentId,
          credentials,
          computeProvider,
          computeCredentials,
          missing,
          ready: missing.length === 0,
        };
      })
    );

    return c.json({ githubConnected, providers }, 200);
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
    const computeProvider = config?.computeProvider;
    if (
      computeProvider !== undefined &&
      computeProvider !== null &&
      (typeof computeProvider !== "string" ||
        !COMPUTE_PROVIDERS.has(computeProvider))
    ) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: `config.computeProvider must be one of: ${[...COMPUTE_PROVIDERS].join(", ")}`,
      });
    }
    if (
      fields.computeApiUrl !== undefined &&
      fields.computeApiUrl !== null &&
      !fields.computeApiUrl.startsWith("https://")
    ) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "computeApiUrl must be an https:// URL",
      });
    }
    const stub = getWorkspaceStub(c.env, organizationId);
    const encrypted = await encryptProviderConfigInput(c.env, {
      ...fields,
      config,
    });
    await stub.upsertAgentProviderConfig({ agentId, ...encrypted });
    const row = await stub.getAgentProviderConfig(agentId);
    if (!row) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 500,
        message: "Failed to save provider config",
      });
    }
    return c.json(await redact(c.env, row), 200);
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
    const row = await loadProviderConfig(c.env, stub, agentId);
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
    const row = await loadProviderConfig(c.env, stub, agentId);
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
