import { z } from "zod";

import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import type { Issue } from "../types/workspace.js";
import type { AgentProvider, AgentProviderSession } from "./provider.js";

const flueDispatchResponseSchema = z.object({
  ok: z.boolean(),
  conversationId: z.string(),
  url: z.string().optional(),
});

const flueConfigSchema = z.object({
  endpoint: z.string(),
  agent: z.string().optional(),
});

/**
 * Flue adapter: dispatch POSTs a task envelope to the flue worker's
 * /dispatch/issuetracker route, which starts a conversation on a Flue agent
 * and writes status/result back to the tracker session when submit_report
 * fires. Provider config on the workspace carries:
 *   token            — bearer expected by the flue /dispatch/issuetracker route
 *   config.endpoint  — flue worker base URL
 *   config.agent     — target agent slug (default "engineering" on flue side)
 */
export class FlueAgentProvider implements AgentProvider {
  readonly id = "flue";
  constructor(private env: AppEnv) {}

  async dispatch(
    organizationId: string,
    issue: Issue,
    _model?: string,
    sessionContext?: { sessionId: string }
  ): Promise<AgentProviderSession> {
    const config = flueConfigSchema.parse(
      this.env.AGENT_PROVIDER_CONFIG
        ? (JSON.parse(this.env.AGENT_PROVIDER_CONFIG) as unknown)
        : {}
    );
    const target =
      config.endpoint === "service-binding"
        ? "https://flue-cf-teammate.internal/dispatch/issuetracker"
        : `${config.endpoint.replace(/\/$/, "")}/dispatch/issuetracker`;
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
    const body = flueDispatchResponseSchema.parse(await res.json());
    return {
      id: body.conversationId,
      agentId: this.id,
      issueId: issue.id,
      status: "running",
      url: body.url,
    };
  }

  async poll(sessionId: string): Promise<AgentProviderSession> {
    // Status is pushed by the flue worker (PATCH on the session); there is no
    // stateful read on the flue side to poll against.
    return { id: sessionId, agentId: this.id, issueId: "", status: "running" };
  }
}
