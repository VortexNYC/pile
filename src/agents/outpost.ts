import { z } from "@hono/zod-openapi";

import type { WorkerEnv } from "../platform/middleware.js";
import type { AppEnv } from "../types/env.js";
import type { AgentSessionStatus, GitIdentity } from "../types/workspace.js";

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

const outpostQueueSchema = z.object({
  items: z.array(
    z.object({
      metadata: z.object({ session_id: z.string() }),
      status: z.object({ phase: z.string() }),
    })
  ),
});

const prSchema = z.object({
  url: z.string().optional(),
  pr_url: z.string().optional(),
  pr_state: z.string().optional(),
});

const devinSessionSchema = z.object({
  session_id: z.string(),
  status: z.string(),
  status_detail: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  pull_requests: z.array(prSchema).optional(),
});

export interface AgentProviderConfigRow {
  config?: string | null;
  token: string | null;
  providerOrgId: string | null;
  outpost: string | null;
  outpostId: string | null;
  outpostToken: string | null;
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
    DEVIN_OUTPOST: config.outpost ?? env.DEVIN_OUTPOST,
    DEVIN_OUTPOST_ID: config.outpostId ?? env.DEVIN_OUTPOST_ID,
    DEVIN_OUTPOST_TOKEN: config.outpostToken ?? env.DEVIN_OUTPOST_TOKEN,
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

/**
 * Provision a dedicated Daytona sandbox that claims and serves one outpost
 * session. The sandbox snapshot runs `devin worker start --session <id>` as
 * its entrypoint, so the worker picks up exactly this session and exits when
 * it ends.
 *
 * This is idempotent: if a sandbox already exists for the session it is
 * reused when healthy and recreated when it is not.
 */
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
    console.error("outpost: failed to write session activity", {
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
    console.error("outpost: failed to close session span", {
      organizationId,
      spanId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function provisionOutpostWorker(
  env: WorkerEnv,
  devinSessionId: string,
  organizationId?: string,
  trackerSessionId?: string,
  gitIdentity?: GitIdentity | null
): Promise<void> {
  const fleetId = devinSessionId.startsWith("devin-")
    ? devinSessionId
    : `devin-${devinSessionId}`;
  const spanId = await openAgentSessionSpan(
    env,
    organizationId,
    trackerSessionId,
    "provision outpost worker",
    { session: fleetId }
  );
  try {
    await provisionOutpostWorkerInner(
      env,
      devinSessionId,
      organizationId,
      trackerSessionId,
      gitIdentity,
      spanId
    );
  } finally {
    await closeAgentSessionSpan(env, organizationId, spanId);
  }
}

async function provisionOutpostWorkerInner(
  env: WorkerEnv,
  devinSessionId: string,
  organizationId: string | undefined,
  trackerSessionId: string | undefined,
  gitIdentity: GitIdentity | null | undefined,
  spanId: string | undefined
): Promise<void> {
  const fleetId = devinSessionId.startsWith("devin-")
    ? devinSessionId
    : `devin-${devinSessionId}`;
  const config = daytonaConfig(env);
  const outpostId = env.DEVIN_OUTPOST_ID;
  const outpostToken = env.DEVIN_OUTPOST_TOKEN;
  if (!config || !outpostId || !outpostToken) return;

  const shortId = devinSessionId.replace(/^devin-/, "").slice(0, 12);
  const name = `vortex-outpost-${shortId}`;

  // List all sandboxes and find any that already belong to this session.
  const listRes = await fetch(`${config.apiUrl}/sandbox`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!listRes.ok) {
    console.error("daytona sandbox list failed", listRes.status);
    await writeAgentSessionActivity(
      env,
      organizationId,
      trackerSessionId,
      "error",
      "daytona sandbox list failed",
      { status: listRes.status, session: fleetId },
      { parentId: spanId }
    );
    return;
  }
  const list = daytonaSandboxListSchema.parse(await listRes.json());
  const existing = list.items.find(
    (s) =>
      s.name === name ||
      (s.labels?.["vortex.outpost"] === "1" &&
        s.labels?.["vortex.session"] === fleetId)
  );

  if (existing) {
    if (existing.state === "started") {
      console.log("outpost worker already healthy", {
        session: fleetId,
        sandbox: existing.id,
      });
      await writeAgentSessionActivity(
        env,
        organizationId,
        trackerSessionId,
        "status",
        "outpost worker already healthy",
        { sandbox: existing.id, state: existing.state, session: fleetId },
        { parentId: spanId }
      );
      return;
    }
    console.log("outpost worker exists but is not healthy, recreating", {
      session: fleetId,
      sandbox: existing.id,
      state: existing.state,
    });
    await writeAgentSessionActivity(
      env,
      organizationId,
      trackerSessionId,
      "status",
      "outpost worker exists but is not healthy, recreating",
      { sandbox: existing.id, state: existing.state, session: fleetId },
      { parentId: spanId }
    );
    const del = await fetch(`${config.apiUrl}/sandbox/${existing.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!del.ok && del.status !== 404) {
      console.error("daytona sandbox delete failed", {
        session: fleetId,
        status: del.status,
      });
      await writeAgentSessionActivity(
        env,
        organizationId,
        trackerSessionId,
        "error",
        "daytona sandbox delete failed",
        { status: del.status, session: fleetId },
        { parentId: spanId }
      );
      return;
    }
  }

  const res = await fetch(`${config.apiUrl}/sandbox`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      snapshot: env.DAYTONA_SNAPSHOT ?? "vortex-outpost-worker",
      env: {
        OUTPOST_ID: outpostId,
        OUTPOST_TOKEN: outpostToken,
        SESSION_ID: fleetId,
        ...(gitIdentity
          ? {
              GIT_AUTHOR_NAME: gitIdentity.name,
              GIT_AUTHOR_EMAIL: gitIdentity.email,
              GIT_COMMITTER_NAME: gitIdentity.name,
              GIT_COMMITTER_EMAIL: gitIdentity.email,
            }
          : {}),
      },
      labels: {
        "vortex.outpost": "1",
        "vortex.session": fleetId,
        ...(organizationId ? { "vortex.org": organizationId } : {}),
        ...(trackerSessionId
          ? { "vortex.tracker_session": trackerSessionId }
          : {}),
      },
      autoStopInterval: 0,
      autoDeleteInterval: 0,
      ...(env.DAYTONA_VOLUME_ID
        ? {
            volumes: [
              {
                volumeId: env.DAYTONA_VOLUME_ID,
                mountPath: "/home/daytona/cache",
              },
            ],
          }
        : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("daytona sandbox create failed", {
      session: fleetId,
      status: res.status,
      body: text.slice(0, 500),
    });
    await writeAgentSessionActivity(
      env,
      organizationId,
      trackerSessionId,
      "error",
      "daytona sandbox create failed",
      { status: res.status, body: text.slice(0, 500), session: fleetId },
      { parentId: spanId }
    );
    return;
  }

  const sandbox = daytonaSandboxSchema.parse(await res.json());
  console.log("outpost worker provisioned", {
    session: fleetId,
    sandbox: sandbox.id,
  });
  await writeAgentSessionActivity(
    env,
    organizationId,
    trackerSessionId,
    "status",
    "outpost worker provisioned",
    {
      sandbox: sandbox.id,
      state: sandbox.state,
      nodeDomain: sandbox.nodeDomain,
      session: fleetId,
    },
    { parentId: spanId }
  );
}

/**
 * Cron sweeper: delete outpost sandboxes whose Devin session has reached a
 * terminal state. Sessions run to completion inside the sandbox; once Devin
 * reports exit/error/suspended, the sandbox is reclaimed.
 */
export async function sweepOutpostWorkers(env: WorkerEnv): Promise<void> {
  const config = daytonaConfig(env);
  const orgId = env.DEVIN_ORG_ID;
  if (!config || !orgId || !env.DEVIN_TOKEN) return;

  const res = await fetch(`${config.apiUrl}/sandbox`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!res.ok) {
    console.error("daytona sandbox list failed", res.status);
    return;
  }
  const list = daytonaSandboxListSchema.parse(await res.json());

  const workers = list.items.filter(
    (s) =>
      s.labels?.["vortex.outpost"] === "1" &&
      s.labels["vortex.session"] &&
      s.state !== "destroyed" &&
      s.state !== "archived"
  );

  const statusMap: Record<string, AgentSessionStatus> = {
    blocked: "waiting",
    exit: "completed",
    error: "failed",
    suspended: "canceled",
  };
  const terminal = new Set(["exit", "error", "suspended"]);

  await Promise.all(
    workers.map(async (sandbox) => {
      const sessionId = sandbox.labels?.["vortex.session"];
      if (!sessionId) return;
      const trackerSessionId = sandbox.labels?.["vortex.tracker_session"];
      const sandboxOrg = sandbox.labels?.["vortex.org"];

      let token = env.DEVIN_TOKEN;
      let sessionOrgId = orgId;
      if (sandboxOrg) {
        try {
          const stub = env.WORKSPACE_DURABLE_OBJECT.get(
            env.WORKSPACE_DURABLE_OBJECT.idFromName(sandboxOrg)
          );
          await stub.setOrganizationId(sandboxOrg);
          const cfg = await stub.getAgentProviderConfig("devin");
          if (cfg?.token) token = cfg.token;
          if (cfg?.providerOrgId) sessionOrgId = cfg.providerOrgId;
        } catch (err) {
          console.error("outpost sweep: config lookup failed", err);
          await writeAgentSessionActivity(
            env,
            sandboxOrg,
            trackerSessionId,
            "error",
            "outpost sweep: config lookup failed",
            {
              error: err instanceof Error ? err.message : String(err),
              session: sessionId,
            }
          );
        }
      }

      const sessionRes = await fetch(
        `https://api.devin.ai/v3/organizations/${sessionOrgId}/sessions/${sessionId.replace(/^devin-/, "")}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!sessionRes.ok) return;
      const session = devinSessionSchema.parse(await sessionRes.json());

      const mapped = statusMap[session.status];
      if (mapped && trackerSessionId && sandboxOrg) {
        try {
          const firstPr = session.pull_requests?.[0];
          const prUrl = firstPr?.url ?? firstPr?.pr_url;
          const prState = firstPr?.pr_state;
          const stub = env.WORKSPACE_DURABLE_OBJECT.get(
            env.WORKSPACE_DURABLE_OBJECT.idFromName(sandboxOrg)
          );
          await stub.setOrganizationId(sandboxOrg);
          await stub.applyAgentSessionResult(
            trackerSessionId,
            {
              status: mapped,
              result: (session.status_detail ?? prState) || undefined,
              url: `https://app.devin.ai/sessions/${session.session_id}`,
              prUrl: prUrl ?? null,
              prState: prState ?? null,
            },
            undefined
          );
        } catch (err) {
          console.error("outpost status write-back failed", {
            session: sessionId,
            err,
          });
          await writeAgentSessionActivity(
            env,
            sandboxOrg,
            trackerSessionId,
            "error",
            "outpost status write-back failed",
            {
              error: err instanceof Error ? err.message : String(err),
              session: sessionId,
            }
          );
        }
      }

      if (terminal.has(session.status)) {
        const del = await fetch(`${config.apiUrl}/sandbox/${sandbox.id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${config.apiKey}` },
        });
        console.log("outpost worker reaped", {
          session: sessionId,
          sandbox: sandbox.id,
          ok: del.ok,
        });
        await writeAgentSessionActivity(
          env,
          sandboxOrg,
          trackerSessionId,
          "status",
          "outpost worker reaped",
          { sandbox: sandbox.id, session: sessionId, ok: del.ok }
        );
      }
    })
  );
}

/**
 * Backstop for queued sessions that never got a worker provisioned (e.g. a
 * dispatch that predates provisioning, or a failed create). Lists the
 * outpost's pending sessions and provisions a worker for each.
 */
export async function drainOutpostQueue(env: WorkerEnv): Promise<void> {
  const outpostId = env.DEVIN_OUTPOST_ID;
  const outpostToken = env.DEVIN_OUTPOST_TOKEN;
  if (!outpostId || !outpostToken || !env.DEVIN_TOKEN) return;

  const res = await fetch(
    `https://api.devin.ai/opbeta/outposts/devins?outpost=${encodeURIComponent(outpostId)}&phase=pending`,
    { headers: { Authorization: `Bearer ${outpostToken}` } }
  );
  if (!res.ok) {
    console.error("outpost queue list failed", res.status);
    return;
  }
  const queue = outpostQueueSchema.parse(await res.json());
  const orgId = env.DEVIN_ORG_ID;
  if (!orgId) return;

  await Promise.all(
    queue.items.map(async (item) => {
      const fleetId = item.metadata.session_id;

      // Recover org + tracker session from the Devin session tags so the
      // sweeper can write status back for drained sessions too.
      let organizationId: string | undefined;
      let trackerSessionId: string | undefined;
      const sessionRes = await fetch(
        `https://api.devin.ai/v3/organizations/${orgId}/sessions/${fleetId.replace(/^devin-/, "")}`,
        { headers: { Authorization: `Bearer ${env.DEVIN_TOKEN}` } }
      );
      if (sessionRes.ok) {
        const session = devinSessionSchema.parse(await sessionRes.json());
        organizationId = session.tags
          ?.find((t) => t.startsWith("vortex:"))
          ?.slice("vortex:".length);
        const issueId = session.tags
          ?.find((t) => t.startsWith("issue:"))
          ?.slice("issue:".length);
        if (organizationId && issueId) {
          try {
            const stub = env.WORKSPACE_DURABLE_OBJECT.get(
              env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
            );
            await stub.setOrganizationId(organizationId);
            const sessions = await stub.listAgentSessions({ issueId });
            trackerSessionId = sessions.find((s) =>
              s.url?.includes(fleetId.replace(/^devin-/, ""))
            )?.id;
          } catch (err) {
            console.error("outpost drain: tracker session lookup failed", err);
          }
        }
      }

      return provisionOutpostWorker(
        env,
        fleetId,
        organizationId,
        trackerSessionId
      );
    })
  );
}
