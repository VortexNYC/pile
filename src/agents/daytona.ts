import { z } from "@hono/zod-openapi";

import type { WorkerEnv } from "../platform/middleware.js";
import type { AppEnv } from "../types/env.js";

export const daytonaSandboxSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string(),
  lastSeen: z.string().nullable().optional(),
  nodeDomain: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  labels: z.record(z.string(), z.string()).optional(),
  toolboxProxyUrl: z.string().nullable().optional(),
});

export const daytonaSandboxListSchema = z.object({
  items: z.array(daytonaSandboxSchema),
});

export interface AgentProviderConfigRow {
  config?: string | null;
  token: string | null;
  providerOrgId: string | null;
  computeApiKey: string | null;
  computeApiUrl: string | null;
  computeSnapshot: string | null;
  computeVolumeId: string | null;
}

/**
 * Merge a workspace's provider config over the deployment-level env. Each
 * field falls back to the env value when the workspace hasn't set it, so a
 * workspace can BYO only the pieces it owns (e.g. its own Devin token while
 * running on classic hosted Devin).
 */
function parseConfigModel(
  configJson: string | null | undefined
): string | undefined {
  if (!configJson) return undefined;
  try {
    const parsed: unknown = JSON.parse(configJson);
    if (typeof parsed === "object" && parsed !== null) {
      const model = (parsed as Record<string, unknown>).model;
      if (typeof model === "string") return model;
    }
  } catch {
    // ignore malformed config JSON
  }
  return undefined;
}

function parseConfigEnvId(
  configJson: string | null | undefined
): string | undefined {
  if (!configJson) return undefined;
  try {
    const parsed: unknown = JSON.parse(configJson);
    if (typeof parsed === "object" && parsed !== null) {
      const envId = (parsed as Record<string, unknown>).envId;
      if (typeof envId === "string") return envId;
    }
  } catch {
    // ignore malformed config JSON
  }
  return undefined;
}

export function resolveAgentEnv(
  env: WorkerEnv,
  config: AgentProviderConfigRow | undefined
): WorkerEnv {
  if (!config) return env;
  return {
    ...env,
    DEVIN_TOKEN: config.token ?? env.DEVIN_TOKEN,
    OPENAI_API_KEY: config.token ?? env.OPENAI_API_KEY,
    AGENT_PROVIDER_TOKEN: config.token ?? env.AGENT_PROVIDER_TOKEN,
    CODEX_AUTH_JSON_B64: config.token ?? env.CODEX_AUTH_JSON_B64,
    CODEX_CLI_MODEL: parseConfigModel(config.config) ?? env.CODEX_CLI_MODEL,
    CODEX_CLI_ENV_ID: parseConfigEnvId(config.config) ?? env.CODEX_CLI_ENV_ID,
    DEVIN_CLI_CREDENTIALS_B64: config.token ?? env.DEVIN_CLI_CREDENTIALS_B64,
    DEVIN_CLI_MODEL: parseConfigModel(config.config) ?? env.DEVIN_CLI_MODEL,
    DEVIN_ORG_ID: config.providerOrgId ?? env.DEVIN_ORG_ID,
    DAYTONA_API_KEY: config.computeApiKey ?? env.DAYTONA_API_KEY,
    DAYTONA_API_URL: config.computeApiUrl ?? env.DAYTONA_API_URL,
    DAYTONA_SNAPSHOT: config.computeSnapshot ?? env.DAYTONA_SNAPSHOT,
    DAYTONA_VOLUME_ID: config.computeVolumeId ?? env.DAYTONA_VOLUME_ID,
    AGENT_PROVIDER_CONFIG: config.config ?? env.AGENT_PROVIDER_CONFIG,
  };
}

export function daytonaConfig(env: AppEnv) {
  const apiKey = env.DAYTONA_API_KEY;
  const apiUrl = env.DAYTONA_API_URL ?? "https://app.daytona.io/api";
  if (!apiKey) return null;
  return { apiKey, apiUrl };
}

type ActivityType =
  | "thought"
  | "response"
  | "error"
  | "elicitation"
  | "action"
  | "status"
  | "artifact";

export interface ActivitySpanOptions {
  /** Parent activity id — nests this event under an open span. */
  parentId?: string;
  /** ISO timestamp marking span start. Pass to open a span. */
  startedAt?: string;
  /** ISO timestamp marking span end (completed span record). */
  endedAt?: string;
  /** Explicit duration when started/ended aren't both known. */
  durationMs?: number;
}

export async function writeAgentSessionActivity(
  env: WorkerEnv,
  organizationId: string | undefined,
  sessionId: string | undefined,
  type: ActivityType,
  message: string,
  payload?: Record<string, unknown>,
  span?: ActivitySpanOptions
): Promise<string | undefined> {
  if (!organizationId || !sessionId) return undefined;
  try {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    const activity = await stub.addAgentActivity({
      sessionId,
      actorId: undefined,
      type,
      message,
      payload,
      parentId: span?.parentId,
      startedAt: span?.startedAt,
      endedAt: span?.endedAt,
      durationMs: span?.durationMs,
    });
    return activity.id;
  } catch (err) {
    console.error("daytona: failed to write session activity", {
      organizationId,
      sessionId,
      message,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Open a span activity. Returns its id for use as `parentId` on child
 *  events; pass the id to `closeAgentSessionSpan` when the step ends. */
export function openAgentSessionSpan(
  env: WorkerEnv,
  organizationId: string | undefined,
  sessionId: string | undefined,
  message: string,
  payload?: Record<string, unknown>,
  parentId?: string
): Promise<string | undefined> {
  return writeAgentSessionActivity(
    env,
    organizationId,
    sessionId,
    "action",
    message,
    payload,
    { startedAt: new Date().toISOString(), parentId }
  );
}

export async function closeAgentSessionSpan(
  env: WorkerEnv,
  organizationId: string | undefined,
  spanId: string | undefined
): Promise<void> {
  if (!organizationId || !spanId) return;
  try {
    const stub = env.WORKSPACE_DURABLE_OBJECT.get(
      env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
    );
    await stub.setOrganizationId(organizationId);
    await stub.closeAgentActivity(spanId);
  } catch (err) {
    console.error("daytona: failed to close session span", {
      organizationId,
      spanId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
