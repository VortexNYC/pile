import { z } from "zod";

import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import type {
  AgentSessionStatus,
  GitIdentity,
  Issue,
} from "../types/workspace.js";
import type {
  AgentDispatchContext,
  AgentProvider,
  AgentProviderHealth,
  AgentProviderSession,
  AgentProviderState,
} from "./provider.js";
import { probeUrl } from "./provider.js";

const API_BASE = "https://api.openai.com/v1";
const BETA_HEADER = "agents=v1";

const codexSessionSchema = z.object({
  id: z.string(),
  status: z.enum(["idle", "in_progress", "requires_action", "failed"]),
  error: z.string().nullable().optional(),
});

const codexItemSchema = z
  .object({
    role: z.string().optional(),
    content: z
      .array(
        z.object({
          type: z.string(),
          text: z.string().optional(),
        })
      )
      .optional(),
  })
  .passthrough();

const codexItemsSchema = z.object({
  data: z.array(codexItemSchema).default([]),
});

const STATUS_MAP: Record<string, AgentSessionStatus> = {
  in_progress: "running",
  requires_action: "waiting",
  failed: "failed",
};

// Webhook payloads carry no session items, so `idle` is terminal here —
// poll() requires assistant output before treating idle as completed.
const WEBHOOK_STATUS_MAP: Record<string, AgentSessionStatus> = {
  ...STATUS_MAP,
  idle: "completed",
  canceled: "canceled",
};

function extractText(item: unknown): string | null {
  const parsed = codexItemSchema.safeParse(item);
  if (!parsed.success) return null;
  const text = parsed.data.content
    ?.map((c) => c.text)
    .filter((t): t is string => typeof t === "string")
    .join("");
  return text ?? null;
}

function findPrUrl(text: string): string | null {
  const match = text.match(
    /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/
  );
  return match?.[0] ?? null;
}

function buildInput(issue: Issue, gitIdentity?: GitIdentity | null): unknown {
  const repo = issue.repo ?? "this repository";
  const branch = issue.branch ?? `issue-${issue.id}`;
  const identityLines = gitIdentity
    ? [
        `Git identity: ${gitIdentity.name} <${gitIdentity.email}>`,
        ...(gitIdentity.githubUsername
          ? [`GitHub user: ${gitIdentity.githubUsername}`]
          : []),
        ...(gitIdentity.signingKeyRef
          ? [`Signing key reference: ${gitIdentity.signingKeyRef}`]
          : []),
      ]
    : [];
  const prompt = [
    `# ${issue.title}`,
    "",
    `Repository: https://github.com/${repo}`,
    `Suggested branch name: ${branch}`,
    `Issue tracker: https://github.com/VortexNYC/pile`,
    `Issue: ${issue.identifier ?? issue.id}`,
    "",
    issue.description ?? "",
    "",
    ...identityLines,
    "",
    "Implement the requested change. Run the project's test/lint commands. If you open a pull request, include the full PR URL in your final message.",
    "Do not attempt to update Pile yourself — an external system will poll your session and write the status back automatically.",
  ].join("\n");
  return {
    role: "user",
    content: [
      {
        type: "input_text",
        text: prompt,
      },
    ],
  };
}

function mergeConfig(
  base: Record<string, unknown>,
  override: string | undefined
): Record<string, unknown> {
  if (!override) return base;
  try {
    const parsed: unknown = JSON.parse(override);
    if (typeof parsed === "object" && parsed !== null) {
      return { ...base, ...parsed };
    }
  } catch {
    // ignore malformed config JSON
  }
  return base;
}

export class CodexAgentProvider implements AgentProvider {
  readonly id = "codex";

  constructor(private env: AppEnv) {}

  private get token(): string {
    const token = this.env.OPENAI_API_KEY;
    if (!token) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "OPENAI_API_KEY is not configured",
      });
    }
    return token;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      "OpenAI-Beta": BETA_HEADER,
      "Content-Type": "application/json",
    };
  }

  async dispatch(
    _organizationId: string,
    issue: Issue,
    model = "gpt-6-astra",
    sessionContext?: AgentDispatchContext
  ): Promise<AgentProviderSession> {
    const input = buildInput(issue, sessionContext?.gitIdentity);
    const agent: Record<string, unknown> = mergeConfig(
      {
        model,
        instructions:
          "You are a senior software engineer. Implement the issue, run tests, and report the result. If you open a pull request, include the PR URL in your final message.",
        tools: [{ type: "programmatic_tool_calling" }, { type: "web_search" }],
      },
      this.env.AGENT_PROVIDER_CONFIG
    );

    const environment: Record<string, unknown> = (typeof agent.environment ===
      "object" &&
      agent.environment !== null && { ...agent.environment }) || {
      type: "openai_hosted",
    };
    delete agent.environment;

    const res = await fetch(`${API_BASE}/agents/sessions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        agent,
        environment,
        input,
        metadata: {
          vortex_tracker: sessionContext?.sessionId,
          vortex_issue: issue.id,
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `OpenAI Codex create failed: ${res.status} ${text}`,
      });
    }

    const body = z.object({ id: z.string() }).parse(await res.json());

    return {
      id: body.id,
      agentId: this.id,
      issueId: issue.id,
      status: "created",
      url: null,
    };
  }

  async poll(sessionId: string): Promise<AgentProviderSession> {
    const [sessionRes, itemsRes] = await Promise.all([
      fetch(`${API_BASE}/agents/sessions/${sessionId}`, {
        headers: this.headers(),
      }),
      fetch(
        `${API_BASE}/agents/sessions/${sessionId}/items?order=asc&limit=100`,
        { headers: this.headers() }
      ),
    ]);

    if (!sessionRes.ok) {
      const text = await sessionRes.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `OpenAI Codex get failed: ${sessionRes.status} ${text}`,
      });
    }

    const data = codexSessionSchema.parse(await sessionRes.json());
    const items = sessionRes.ok
      ? codexItemsSchema.safeParse(await itemsRes.json())
      : null;
    const latestAssistantText = items?.success
      ? (items.data.data
          .toReversed()
          .map(extractText)
          .find((t): t is string => t !== null) ?? null)
      : null;

    let status: AgentSessionStatus = STATUS_MAP[data.status] ?? "running";
    let result = data.error ?? latestAssistantText ?? undefined;
    let prUrl: string | null = null;

    if (data.status === "idle" && latestAssistantText) {
      status = "completed";
      prUrl = findPrUrl(latestAssistantText);
    }

    if (data.status === "idle" && !latestAssistantText) {
      // The session has not produced output yet; treat as running.
      status = "running";
      result = undefined;
    }

    return {
      id: data.id,
      agentId: this.id,
      status,
      result,
      url: null,
      prUrl,
      prState: null,
    };
  }

  async cancel(sessionId: string): Promise<void> {
    const res = await fetch(`${API_BASE}/agents/sessions/${sessionId}/events`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        events: [{ type: "agent.session.input.cancel" }],
      }),
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `OpenAI Codex cancel failed: ${res.status} ${text}`,
      });
    }
  }

  parseWebhook(body: unknown): {
    sessionId: string;
    session?: AgentProviderSession;
  } | null {
    if (typeof body !== "object" || body === null) return null;
    const record = body as Record<string, unknown>;
    const sessionId = record.session_id ?? record.sessionId ?? record.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    const rawStatus = record.status;
    const status =
      typeof rawStatus === "string"
        ? (WEBHOOK_STATUS_MAP[rawStatus] ?? undefined)
        : undefined;
    return {
      sessionId,
      session: status
        ? {
            id: sessionId,
            agentId: this.id,
            status,
            result:
              typeof record.result === "string" ? record.result : undefined,
            prUrl:
              typeof record.pr_url === "string"
                ? record.pr_url
                : typeof record.prUrl === "string"
                  ? record.prUrl
                  : undefined,
          }
        : undefined,
    };
  }

  async getState(
    providerSessionId: string,
    _trackerSessionId: string
  ): Promise<AgentProviderState | null> {
    const token = this.env.OPENAI_API_KEY;
    if (!token) return null;
    const headers = {
      Authorization: `Bearer ${token}`,
      "OpenAI-Beta": BETA_HEADER,
    };
    const [sessionRes, itemsRes] = await Promise.all([
      fetch(`${API_BASE}/agents/sessions/${providerSessionId}`, { headers }),
      fetch(
        `${API_BASE}/agents/sessions/${providerSessionId}/items?order=asc&limit=100`,
        { headers }
      ),
    ]);
    const provider = sessionRes.ok ? await sessionRes.json() : null;
    const compute = itemsRes.ok ? await itemsRes.json() : null;
    return { provider, compute };
  }

  async health(): Promise<AgentProviderHealth> {
    const token = this.env.OPENAI_API_KEY;
    if (!token) return { ok: false, message: "OPENAI_API_KEY missing" };
    return probeUrl(`${API_BASE}/models?limit=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
}
