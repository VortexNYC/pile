import { z } from "zod";

import { VortexError } from "../platform/errors.js";
import type { WorkerEnv } from "../platform/middleware.js";
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
  DispatchComment,
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

const devinMessageSchema = z.object({
  type: z.string().optional(),
  message: z.string().optional(),
  timestamp: z.union([z.string(), z.number()]).optional(),
});

const devinMessagesSchema = z.union([
  z.object({ messages: z.array(devinMessageSchema) }),
  z.array(devinMessageSchema),
]);

const STATUS_MAP: Record<string, AgentSessionStatus> = {
  blocked: "waiting",
  exit: "completed",
  error: "failed",
  suspended: "canceled",
  running: "running",
  created: "created",
};

function buildPrompt(
  issue: Issue,
  gitIdentity?: GitIdentity | null,
  comments?: DispatchComment[],
  instructions?: string
): string {
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
  const repoLines = issue.repo
    ? [
        `Repository: https://github.com/${repo}`,
        `Suggested branch name: ${branch}`,
        "Do all work in the Repository above. Do not open pull requests in any other repository. Open the PR against the main branch of that repository.",
      ]
    : [
        "This task has no code repository — produce the deliverable directly (report, document, analysis) and summarize it in your final answer. Do not open pull requests.",
      ];
  return [
    `# ${issue.title}`,
    "",
    ...repoLines,
    `Issue tracker: https://github.com/VortexNYC/pile`,
    `Issue: ${issue.identifier ?? issue.id}`,
    `Priority: ${issue.priority ?? "none"}`,
    "",
    issue.description ?? "",
    ...(comments && comments.length > 0
      ? [
          "",
          "## Follow-up comments",
          "",
          ...comments.map(
            (c) =>
              `- ${c.author}${c.createdAt ? ` (${c.createdAt})` : ""}: ${c.body}`
          ),
        ]
      : []),
    "",
    ...identityLines,
    ...(instructions ? ["", "## Dispatch instructions", "", instructions] : []),
    "",
    "Verify proportionate to the diff: run the project's lint/typecheck and any tests covering code you change (the repository's AGENTS.md lists its proof commands); docs/config-only diffs can skip tests. Note honestly in the PR body what you could not run.",
    "Do not attempt to update Pile yourself — an external system will poll your session and write the PR URL and final status back automatically.",
  ].join("\n");
}

export class DevinAgentProvider implements AgentProvider {
  readonly id = "devin";

  constructor(private env: WorkerEnv) {}

  async dispatch(
    organizationId: string,
    issue: Issue,
    model = "swe-2",
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
          prompt: buildPrompt(
            issue,
            sessionContext?.gitIdentity,
            sessionContext?.comments,
            sessionContext?.instructions
          ),
          repos: repo ? [`https://github.com/${repo}`] : undefined,
          bypass_approval: true,
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
      // Devin keeps `status: "running"` while blocked on a user question;
      // status_detail "waiting_for_user" is the real signal. Map it to
      // `waiting` so the sweep surfaces an elicitation (needs_input).
      status:
        data.status_detail === "waiting_for_user" || data.status === "blocked"
          ? "waiting"
          : (STATUS_MAP[data.status] ?? "running"),
      result: (data.status_detail ?? prState) || undefined,
      url: `https://app.devin.ai/sessions/${data.session_id}`,
      prUrl: prUrl ?? null,
      prState: prState ?? null,
    };
  }

  async latestElicitation(providerSessionId: string): Promise<string | null> {
    const orgId = this.env.DEVIN_ORG_ID;
    const token = this.env.DEVIN_TOKEN;
    if (!orgId || !token) return null;
    const devinId = providerSessionId.startsWith("devin-")
      ? providerSessionId
      : `devin-${providerSessionId}`;
    const res = await fetch(
      `https://api.devin.ai/v3/organizations/${orgId}/sessions/${devinId}/messages`,
      { headers: { Authorization: `Bearer ${token}` } }
    ).catch(() => null);
    if (!res) return null;
    if (!res.ok) {
      console.error("devin latestElicitation failed", {
        sessionId: providerSessionId,
        status: res.status,
        body: (await res.text()).slice(0, 500),
      });
      return null;
    }
    const body: unknown = await res.json();
    const parsed = devinMessagesSchema.safeParse(body);
    if (!parsed.success) {
      console.error("devin latestElicitation parse failed", {
        sessionId: providerSessionId,
        keys:
          typeof body === "object" && body !== null
            ? Object.keys(body)
            : typeof body,
      });
      return null;
    }
    const messages = Array.isArray(parsed.data)
      ? parsed.data
      : parsed.data.messages;
    // Last Devin-authored message is whatever it's asking the user.
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (
        m.message &&
        (m.type === "devin_message" || m.type?.includes("devin"))
      ) {
        return m.message;
      }
    }
    console.error("devin latestElicitation found no devin message", {
      sessionId: providerSessionId,
      types: messages.map((m) => m.type).slice(-10),
    });
    return null;
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

  async sendPrompt(
    providerSessionId: string,
    prompt: string
  ): Promise<boolean> {
    const orgId = this.env.DEVIN_ORG_ID;
    const token = this.env.DEVIN_TOKEN;
    if (!orgId || !token) return false;
    const devinId = providerSessionId.startsWith("devin-")
      ? providerSessionId
      : `devin-${providerSessionId}`;
    const res = await fetch(
      `https://api.devin.ai/v3/organizations/${orgId}/sessions/${devinId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: prompt }),
      }
    );
    if (!res.ok) {
      const text = await res.text();
      console.error("devin sendPrompt failed", {
        sessionId: providerSessionId,
        status: res.status,
        body: text.slice(0, 500),
      });
    }
    return res.ok;
  }

  async getState(
    providerSessionId: string,
    _trackerSessionId: string
  ): Promise<AgentProviderState | null> {
    const orgId = this.env.DEVIN_ORG_ID;
    const token = this.env.DEVIN_TOKEN;
    if (!orgId || !token) return null;
    const devinRes = await fetch(
      `https://api.devin.ai/v3/organizations/${orgId}/sessions/${providerSessionId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const provider = devinRes.ok ? await devinRes.json() : null;
    return { provider, compute: null };
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

  parseWebhook(
    body: unknown,
    _headers?: Headers
  ): {
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
