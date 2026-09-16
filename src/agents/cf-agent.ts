import { z } from "zod";

import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import type { Issue } from "../types/workspace.js";
import type {
  AgentProvider,
  AgentProviderHealth,
  AgentProviderSession,
  AgentProviderState,
} from "./provider.js";

const dispatchResponseSchema = z.object({
  ok: z.boolean(),
  conversationId: z.string(),
  url: z.string().optional(),
});

const cfAgentConfigSchema = z.object({
  endpoint: z.string(),
  agent: z.string().optional(),
  dispatchPath: z.string().default("/dispatch/pile"),
  agentsPath: z.string().default("/agents"),
});

const agentSnapshotSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.string(),
        parts: z.array(
          z.object({
            type: z.string(),
            text: z.string().optional(),
          })
        ),
      })
    )
    .default([]),
  settlements: z
    .array(
      z.object({
        submissionId: z.string(),
        outcome: z.string(),
      })
    )
    .default([]),
});

/**
 * Cloudflare-Agents-SDK provider: targets any worker that exposes the Agents
 * SDK agent-router shape (GET /agents/{agent}/{conversation} → messages +
 * settlements) plus a dispatch route. The flue worker is the reference
 * implementation: its /dispatch/pile route starts a conversation and
 * writes status/result back to the tracker session when submit_report fires.
 *
 * Workspace provider config (`PUT /agent/providers/cf-agent` or `/flue`):
 *   token               — bearer expected by the worker's dispatch route
 *   config.endpoint     — worker base URL, or "service-binding" to use the
 *                         deployment's FLUE_WORKER binding (same-account)
 *   config.agent        — target agent slug (default "engineering")
 *   config.dispatchPath — override the dispatch route (default /dispatch/pile)
 *   config.agentsPath   — override the agent-router prefix (default /agents)
 */
export class CfAgentProvider implements AgentProvider {
  constructor(
    private env: AppEnv,
    readonly id: string
  ) {}

  async dispatch(
    organizationId: string,
    issue: Issue,
    _model?: string,
    sessionContext?: { sessionId: string }
  ): Promise<AgentProviderSession> {
    const config = cfAgentConfigSchema.parse(
      this.env.AGENT_PROVIDER_CONFIG
        ? (JSON.parse(this.env.AGENT_PROVIDER_CONFIG) as unknown)
        : {}
    );
    const target =
      config.endpoint === "service-binding"
        ? `https://cf-agent.internal${config.dispatchPath}`
        : `${config.endpoint.replace(/\/$/, "")}${config.dispatchPath}`;
    const request = new Request(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.env.AGENT_PROVIDER_TOKEN ?? ""}`,
      },
      body: JSON.stringify({
        sessionId: sessionContext?.sessionId,
        agent: config.agent,
        organizationId,
        issue: {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description,
          repo: issue.repo,
          branch: issue.branch,
          status: issue.status,
          priority: issue.priority,
          labelIds: issue.labelIds,
        },
      }),
    });
    const res = this.env.FLUE_WORKER
      ? await this.env.FLUE_WORKER.fetch(request)
      : await fetch(request);
    if (!res.ok) {
      const text = await res.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Flue dispatch failed: ${res.status} ${text.slice(0, 500)}`,
      });
    }
    const body = dispatchResponseSchema.parse(await res.json());
    return {
      id: body.conversationId,
      agentId: this.id,
      issueId: issue.id,
      status: "running",
      url: body.url,
      prUrl: null,
      prState: null,
      branch: null,
    };
  }

  private config() {
    return cfAgentConfigSchema.parse(
      this.env.AGENT_PROVIDER_CONFIG
        ? (JSON.parse(this.env.AGENT_PROVIDER_CONFIG) as unknown)
        : {}
    );
  }

  private snapshotUrl(sessionId: string) {
    const config = this.config();
    const agent = config.agent ?? "engineering";
    const base =
      config.endpoint === "service-binding"
        ? "https://cf-agent.internal"
        : config.endpoint.replace(/\/$/, "");
    return `${base}${config.agentsPath}/${agent}/${encodeURIComponent(sessionId)}`;
  }

  private async fetchSnapshot(sessionId: string): Promise<Response> {
    const request = new Request(this.snapshotUrl(sessionId), {
      headers: {
        accept: "application/json",
        Authorization: `Bearer ${this.env.AGENT_PROVIDER_TOKEN ?? ""}`,
      },
    });
    return this.env.FLUE_WORKER
      ? await this.env.FLUE_WORKER.fetch(request)
      : await fetch(request);
  }

  async poll(sessionId: string): Promise<AgentProviderSession> {
    // Status is pushed by the flue worker (PATCH on the session). This is the
    // recovery path: read the conversation snapshot and map its settlements
    // onto a session status so a crashed run cannot leave the tracker stuck
    // on "running" forever.
    const res = await this.fetchSnapshot(sessionId);
    if (res.status === 404) {
      return {
        id: sessionId,
        agentId: this.id,
        status: "running",
      };
    }
    if (!res.ok) {
      const text = await res.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Flue poll failed: ${res.status} ${text.slice(0, 500)}`,
      });
    }
    const snapshot = agentSnapshotSchema.parse(await res.json());
    const settlement = snapshot.settlements.at(-1);
    if (!settlement) {
      return {
        id: sessionId,
        agentId: this.id,
        status: "running",
      };
    }
    const status =
      settlement.outcome === "completed"
        ? "completed"
        : settlement.outcome === "aborted"
          ? "canceled"
          : "failed";
    const lastText = snapshot.messages
      .toReversed()
      .find((m) => m.role === "assistant")
      ?.parts.filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("")
      .trim();
    return {
      id: sessionId,
      agentId: this.id,
      status,
      ...(lastText ? { result: lastText } : {}),
    };
  }

  async getState(
    providerSessionId: string
  ): Promise<AgentProviderState | null> {
    const res = await this.fetchSnapshot(providerSessionId);
    if (!res.ok) return null;
    const json = await res.json();
    const snapshot = agentSnapshotSchema.safeParse(json);
    return { provider: snapshot.success ? snapshot.data : json };
  }

  async health(): Promise<AgentProviderHealth> {
    if (!this.env.AGENT_PROVIDER_TOKEN) {
      return { ok: false, message: "Agent worker token missing" };
    }
    try {
      const res = await this.fetchSnapshot("health");
      if (res.status === 404 || res.ok) return { ok: true };
      const text = await res.text();
      return { ok: false, message: `${res.status} ${text.slice(0, 200)}` };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
