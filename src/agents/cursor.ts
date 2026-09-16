import { z } from "zod";

import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import type { AgentSessionStatus, Issue } from "../types/workspace.js";
import type {
  AgentProvider,
  AgentProviderHealth,
  AgentProviderSession,
  AgentProviderState,
} from "./provider.js";
import { probeUrl } from "./provider.js";

const cursorConfigSchema = z.object({
  endpoint: z.string().default("https://api.cursor.com"),
  // BYOM: route the agent to a self-hosted pool/machine instead of
  // Cursor-hosted cloud. e.g. { type: "pool", name: "sandbox" }
  env: z
    .object({
      type: z.enum(["cloud", "pool", "machine"]),
      name: z.string().optional(),
    })
    .optional(),
  repoUrl: z.string().optional(),
  startingRef: z.string().optional(),
  autoCreatePR: z.boolean().default(true),
});

const createResponseSchema = z.object({
  agent: z.object({
    id: z.string(),
    url: z.string().optional(),
    latestRunId: z.string().optional(),
  }),
  run: z.object({ id: z.string(), status: z.string() }),
});

const runSchema = z.object({
  id: z.string(),
  status: z.string(),
  result: z.string().optional(),
  git: z
    .object({
      branches: z
        .array(
          z.object({
            branch: z.string().optional(),
            prUrl: z.string().optional(),
          })
        )
        .optional(),
    })
    .optional(),
});

const STATUS_MAP: Record<string, AgentSessionStatus> = {
  CREATING: "created",
  RUNNING: "running",
  FINISHED: "completed",
  ERROR: "failed",
  CANCELLED: "canceled",
  EXPIRED: "canceled",
};

/**
 * Cursor Cloud Agents provider. `token` is a Cursor API key (user or
 * enterprise service account). config.env routes to a self-hosted pool or
 * machine for BYOM execution; omit it for Cursor-hosted cloud.
 */
export class CursorAgentProvider implements AgentProvider {
  readonly id = "cursor";
  constructor(private env: AppEnv) {}

  private config() {
    return cursorConfigSchema.parse(
      this.env.AGENT_PROVIDER_CONFIG
        ? (JSON.parse(this.env.AGENT_PROVIDER_CONFIG) as unknown)
        : {}
    );
  }

  private get api() {
    return this.config().endpoint.replace(/\/$/, "");
  }

  private get auth() {
    return `Bearer ${this.env.AGENT_PROVIDER_TOKEN ?? ""}`;
  }

  async dispatch(
    organizationId: string,
    issue: Issue,
    model?: string
  ): Promise<AgentProviderSession> {
    const config = this.config();
    const repoUrl = config.repoUrl ?? issue.repo ?? undefined;
    const res = await fetch(`${this.api}/v1/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.auth,
      },
      body: JSON.stringify({
        prompt: {
          text: [
            `Issue ${issue.identifier ?? issue.id}: ${issue.title}`,
            issue.description ?? "",
            issue.branch ? `Target branch: ${issue.branch}` : "",
            `Tracker: workspace ${organizationId}, issue ${issue.id}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
        ...(model ? { model: { id: model } } : {}),
        ...(config.env ? { env: config.env } : {}),
        ...(repoUrl
          ? {
              repos: [
                {
                  url: repoUrl,
                  ...(config.startingRef
                    ? { startingRef: config.startingRef }
                    : {}),
                },
              ],
            }
          : {}),
        autoCreatePR: config.autoCreatePR,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Cursor create failed: ${res.status} ${text.slice(0, 500)}`,
      });
    }
    const body = createResponseSchema.parse(await res.json());
    return {
      id: `${body.agent.id}/${body.run.id}`,
      agentId: this.id,
      issueId: issue.id,
      status: STATUS_MAP[body.run.status] ?? "created",
      url: body.agent.url,
    };
  }

  async poll(sessionId: string): Promise<AgentProviderSession> {
    // sessionId is "<agentId>/<runId>" from dispatch.
    const [agentId, runId] = sessionId.split("/");
    const res = await fetch(`${this.api}/v1/agents/${agentId}/runs/${runId}`, {
      headers: { Authorization: this.auth },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Cursor poll failed: ${res.status} ${text.slice(0, 500)}`,
      });
    }
    const run = runSchema.parse(await res.json());
    const branch = run.git?.branches?.find((b) => b.prUrl);
    const prUrl = branch?.prUrl;
    return {
      id: sessionId,
      agentId: this.id,
      status: STATUS_MAP[run.status] ?? "running",
      result: run.result,
      prUrl: prUrl ?? null,
      branch: branch?.branch ?? null,
    };
  }

  parseWebhook(body: unknown): {
    sessionId: string;
    session?: AgentProviderSession;
  } | null {
    if (typeof body !== "object" || body === null) return null;
    const record = body as Record<string, unknown>;

    // Tracker session ids are "<agentId>/<runId>"; rebuild the composite from
    // whichever shape the payload carries.
    const nestedAgent = record.agent as Record<string, unknown> | undefined;
    const nestedRun = record.run as Record<string, unknown> | undefined;
    const agentId =
      (typeof nestedAgent?.id === "string" && nestedAgent.id) ||
      (typeof record.agentId === "string" && record.agentId) ||
      (typeof record.agent_id === "string" && record.agent_id) ||
      null;
    const runId =
      (typeof nestedRun?.id === "string" && nestedRun.id) ||
      (typeof record.runId === "string" && record.runId) ||
      (typeof record.run_id === "string" && record.run_id) ||
      null;

    let sessionId: string;
    if (agentId && runId) {
      sessionId = `${agentId}/${runId}`;
    } else if (typeof record.id === "string" && record.id.includes("/")) {
      sessionId = record.id;
    } else {
      return null;
    }

    const rawStatus =
      (typeof nestedRun?.status === "string" && nestedRun.status) ||
      (typeof record.status === "string" && record.status) ||
      undefined;
    const status = rawStatus ? STATUS_MAP[rawStatus] : undefined;
    const url =
      typeof nestedAgent?.url === "string" ? nestedAgent.url : undefined;
    const prUrl =
      typeof record.prUrl === "string"
        ? record.prUrl
        : typeof record.pr_url === "string"
          ? record.pr_url
          : undefined;
    const branch =
      typeof record.branch === "string" ? record.branch : undefined;
    const result =
      typeof record.result === "string" ? record.result : undefined;

    return {
      sessionId,
      session: status
        ? {
            id: sessionId,
            agentId: this.id,
            status,
            url,
            result,
            prUrl,
            branch,
          }
        : undefined,
    };
  }

  async cancel(sessionId: string): Promise<void> {
    const [agentId, runId] = sessionId.split("/");
    const res = await fetch(
      `${this.api}/v1/agents/${agentId}/runs/${runId}/cancel`,
      { method: "POST", headers: { Authorization: this.auth } }
    );
    // 409 = run already terminal — fine, we're canceling anyway.
    if (!res.ok && res.status !== 409) {
      const text = await res.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Cursor cancel failed: ${res.status} ${text.slice(0, 500)}`,
      });
    }
  }

  async getState(
    providerSessionId: string
  ): Promise<AgentProviderState | null> {
    const [agentId, runId] = providerSessionId.split("/");
    const res = await fetch(`${this.api}/v1/agents/${agentId}/runs/${runId}`, {
      headers: { Authorization: this.auth },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const run = runSchema.safeParse(json);
    return { provider: run.success ? run.data : json };
  }

  async health(): Promise<AgentProviderHealth> {
    if (!this.env.AGENT_PROVIDER_TOKEN) {
      return { ok: false, message: "Cursor API token missing" };
    }
    return probeUrl(`${this.api}/v1/agents?limit=1`, {
      headers: { Authorization: this.auth },
    });
  }
}
