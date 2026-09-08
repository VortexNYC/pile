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

const flueSnapshotSchema = z.object({
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
    // Status is pushed by the flue worker (PATCH on the session). This is the
    // recovery path: read the conversation snapshot and map its settlements
    // onto a session status so a crashed run cannot leave the tracker stuck
    // on "running" forever.
    const config = flueConfigSchema.parse(
      this.env.AGENT_PROVIDER_CONFIG
        ? (JSON.parse(this.env.AGENT_PROVIDER_CONFIG) as unknown)
        : {}
    );
    const agent = config.agent ?? "engineering";
    const base =
      config.endpoint === "service-binding"
        ? "https://flue-cf-teammate.internal"
        : config.endpoint.replace(/\/$/, "");
    const request = new Request(
      `${base}/agents/${agent}/${encodeURIComponent(sessionId)}`,
      { headers: { accept: "application/json" } }
    );
    const res = this.env.FLUE_WORKER
      ? await this.env.FLUE_WORKER.fetch(request)
      : await fetch(request);
    if (res.status === 404) {
      return {
        id: sessionId,
        agentId: this.id,
        issueId: "",
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
    const snapshot = flueSnapshotSchema.parse(await res.json());
    const settlement = snapshot.settlements.at(-1);
    if (!settlement) {
      return {
        id: sessionId,
        agentId: this.id,
        issueId: "",
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
      issueId: "",
      status,
      result: lastText || undefined,
    };
  }
}
