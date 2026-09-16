import { z } from "zod";

import { VortexError } from "../platform/errors.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type {
  AgentSessionStatus,
  GitIdentity,
  Issue,
} from "../types/workspace.js";
import { provisionOutpostWorker } from "./outpost.js";
import type {
  AgentDispatchContext,
  AgentProvider,
  AgentProviderSession,
} from "./provider.js";

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
    "Do not attempt to update the issue tracker yourself — an external system will poll your session and write the PR URL and final status back automatically.",
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
}
