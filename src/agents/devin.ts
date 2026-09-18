import { z } from "zod";

import { VortexError } from "../platform/errors.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type {
  AgentSessionStatus,
  GitIdentity,
  Issue,
} from "../types/workspace.js";
import {
  daytonaConfig,
  daytonaSandboxListSchema,
  provisionOutpostWorker,
} from "./outpost.js";
import type {
  AgentDispatchContext,
  AgentProvider,
  AgentProviderHealth,
  AgentProviderSession,
  AgentProviderState,
} from "./provider.js";
import { probeUrl } from "./provider.js";

const devinCreateResponseSchema = z.object({
  session_id: z.string().optional(),
  id: z.string().optional(),
  url: z.string().optional(),
});

const prSchema = z.object({
  url: z.string().optional(),
  pr_url: z.string().optional(),
  pr_state: z.string().optional(),
});

const devinSessionSchema = z.object({
  session_id: z.string(),
  status: z.string(),
  status_detail: z.string().nullable().default(null),
  is_archived: z.boolean().default(false),
  pull_requests: z.array(prSchema).optional(),
});

const STATUS_MAP: Record<string, AgentSessionStatus> = {
  blocked: "waiting",
  exit: "completed",
  error: "failed",
  suspended: "canceled",
  running: "running",
  created: "created",
};

function buildPrompt(issue: Issue, gitIdentity?: GitIdentity | null): string {
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
  return [
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
    "Do all work in the Repository above. Do not open pull requests in any other repository. Open the PR against the main branch of that repository.",
    "Do not attempt to update Pile yourself — an external system will poll your session and write the PR URL and final status back automatically.",
  ].join("\n");
}

export class DevinAgentProvider implements AgentProvider {
  readonly id = "devin";

  constructor(private env: WorkerEnv) {}

  async dispatch(
    organizationId: string,
    issue: Issue,
    model = "swe-1-7-medium",
    sessionContext?: AgentDispatchContext
  ): Promise<AgentProviderSession> {
    const orgId = this.env.DEVIN_ORG_ID;
    if (!orgId) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "DEVIN_ORG_ID is not configured",
      });
    }

    const repo = issue.repo;
    const res = await fetch(
      `https://api.devin.ai/v3/organizations/${orgId}/sessions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.DEVIN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: buildPrompt(issue, sessionContext?.gitIdentity),
          repos: repo ? [`https://github.com/${repo}`] : undefined,
          bypass_approval: true,
          ...(this.env.DEVIN_OUTPOST
            ? { platform: this.env.DEVIN_OUTPOST }
            : {}),
          model,
          title: issue.title,
          tags: [`vortex:${organizationId}`, `issue:${issue.id}`],
        }),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Devin create failed: ${res.status} ${text}`,
      });
    }

    const body = devinCreateResponseSchema.parse(await res.json());
    const id = body.session_id ?? body.id;
    if (!id) {
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: "Devin response missing session id",
      });
    }

    const sessionUrl = body.url ?? `https://app.devin.ai/sessions/${id}`;
    const provision = provisionOutpostWorker(
      this.env,
      id,
      organizationId,
      sessionContext?.sessionId,
      sessionContext?.gitIdentity
    ).catch((err) => console.error("outpost provisioning failed", err));

    if (sessionContext?.waitUntil) {
      sessionContext.waitUntil(provision);
    } else {
      await provision;
    }

    return {
      id,
      agentId: this.id,
      issueId: issue.id,
      status: "created",
      url: sessionUrl,
    };
  }

  async poll(sessionId: string): Promise<AgentProviderSession> {
    const orgId = this.env.DEVIN_ORG_ID;
    if (!orgId) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "DEVIN_ORG_ID is not configured",
      });
    }

    const res = await fetch(
      `https://api.devin.ai/v3/organizations/${orgId}/sessions/${sessionId}`,
      {
        headers: { Authorization: `Bearer ${this.env.DEVIN_TOKEN}` },
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Devin get failed: ${res.status} ${text}`,
      });
    }

    const data = devinSessionSchema.parse(await res.json());
    const firstPr = data.pull_requests?.[0];
    const prUrl = firstPr?.url ?? firstPr?.pr_url;
    const prState = firstPr?.pr_state;

    return {
      id: data.session_id,
      agentId: this.id,
      status: STATUS_MAP[data.status] ?? "running",
      result: (data.status_detail ?? prState) || undefined,
      url: `https://app.devin.ai/sessions/${data.session_id}`,
      prUrl: prUrl ?? null,
      prState: prState ?? null,
    };
  }

  async cancel(sessionId: string): Promise<void> {
    const orgId = this.env.DEVIN_ORG_ID;
    if (!orgId) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "DEVIN_ORG_ID is not configured",
      });
    }
    const res = await fetch(
      `https://api.devin.ai/v3/organizations/${orgId}/sessions/${sessionId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.env.DEVIN_TOKEN}` },
      }
    );
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message: `Devin terminate failed: ${res.status} ${text}`,
      });
    }
  }

  private async getDaytonaSandbox(
    providerSessionId: string,
    trackerSessionId: string
  ): Promise<unknown> {
    const config = daytonaConfig(this.env);
    if (!config) return null;
    const res = await fetch(`${config.apiUrl}/sandbox`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) return null;
    const list = daytonaSandboxListSchema.safeParse(await res.json());
    if (!list.success) return null;
    const remoteId = providerSessionId;
    const fleetId = remoteId.startsWith("devin-")
      ? remoteId
      : `devin-${remoteId}`;
    return (
      list.data.items.find((item) => {
        const parsed = z
          .object({ labels: z.record(z.string(), z.string()).optional() })
          .safeParse(item);
        if (!parsed.success) return false;
        const labels = parsed.data.labels;
        return (
          labels?.["vortex.tracker_session"] === trackerSessionId ||
          labels?.["vortex.session"] === fleetId ||
          labels?.["vortex.session"] === remoteId
        );
      }) ?? null
    );
  }

  async getState(
    providerSessionId: string,
    trackerSessionId: string
  ): Promise<AgentProviderState | null> {
    const orgId = this.env.DEVIN_ORG_ID;
    const token = this.env.DEVIN_TOKEN;
    if (!orgId || !token) return null;
    const [devinRes, compute] = await Promise.all([
      fetch(
        `https://api.devin.ai/v3/organizations/${orgId}/sessions/${providerSessionId}`,
        { headers: { Authorization: `Bearer ${token}` } }
      ),
      this.getDaytonaSandbox(providerSessionId, trackerSessionId),
    ]);
    const provider = devinRes.ok ? await devinRes.json() : null;
    return { provider, compute };
  }

  async health(): Promise<AgentProviderHealth> {
    const orgId = this.env.DEVIN_ORG_ID;
    const token = this.env.DEVIN_TOKEN;
    if (!orgId || !token) {
      return { ok: false, message: "DEVIN_ORG_ID or DEVIN_TOKEN missing" };
    }
    return probeUrl(
      `https://api.devin.ai/v3/organizations/${orgId}/sessions?limit=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
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
        ? (STATUS_MAP[rawStatus] ?? undefined)
        : undefined;
    return {
      sessionId,
      session: {
        id: sessionId,
        agentId: this.id,
        status: status ?? "running",
        result:
          typeof record.status_detail === "string"
            ? record.status_detail
            : undefined,
        prUrl:
          typeof record.pr_url === "string"
            ? record.pr_url
            : typeof record.prUrl === "string"
              ? record.prUrl
              : undefined,
      },
    };
  }
}
