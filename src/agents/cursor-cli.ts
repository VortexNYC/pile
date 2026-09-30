import { z } from "zod";

import { getInstallationTokenForRepo } from "../global/github-auth.js";
import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type {
  AgentSessionStatus,
  GitIdentity,
  Issue,
} from "../types/workspace.js";
import { computeBackend } from "./compute.js";
import type { ComputeBackend } from "./compute.js";
import { agentCacheUrl, agentLogToken, agentLogUrl } from "./credentials.js";
import {
  writeAgentSessionActivity,
  openAgentSessionSpan,
  closeAgentSessionSpan,
} from "./daytona.js";
import type { ActivitySpanOptions } from "./daytona.js";
import type {
  AgentDispatchContext,
  AgentProvider,
  DispatchComment,
  AgentProviderHealth,
  AgentProviderSession,
  AgentProviderState,
} from "./provider.js";
import { runnerBundle } from "./runner/bundle.js";

const DEFAULT_MODEL = "cursor-grok-4.6-medium";
const RESULT_PATH = "/tmp/agent-result.json";
const NAME_PREFIX = "vortex-cursorcli";
const AGENT_LABEL = "cursor-cli";

const cursorResultSchema = z.object({
  status: z.enum(["completed", "failed"]).optional(),
  prUrl: z.string().optional(),
  branch: z.string().optional(),
  result: z.string().optional(),
  report: z.string().optional(),
});

function encodeBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(bin);
}

function parseRepo(repo: string): [string, string] {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: `Invalid repository format: ${repo}`,
    });
  }
  return [parts[0], parts[1]];
}

function buildPrompt(
  issue: Issue,
  gitIdentity?: GitIdentity | null,
  comments?: DispatchComment[],
  pileApi?: { url: string; key: string } | null,
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
  return [
    `# ${issue.title}`,
    "",
    `Repository: https://github.com/${repo}`,
    `Branch: ${branch}`,
    `Issue tracker: https://github.com/VortexNYC/pile`,
    `Issue: ${issue.identifier ?? issue.id}`,
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
    "Implement the requested change. Verify proportionate to the diff: always run the project's lint/typecheck (for example `pnpm run check`) when the toolchain exists; when you change code, add or extend tests covering the change and run the relevant suites; skip tests entirely when the diff is docs/config-only. Do not burn time on suites that need network egress the sandbox lacks — note the limitation and move on. Make commits with clear messages. Do not push and do not open a pull request — the runner handles that after you exit.",
    "Do not attempt to update Pile yourself — an external system will poll your session and write the status back automatically.",
    ...(pileApi
      ? [
          "",
          "Pile API: a scoped read-only credential is in the environment as $PILE_API_KEY (base URL $PILE_API_URL). If this issue references a support ticket or capture artifacts, fetch them first:",
          '  curl -s "$PILE_API_URL/workspaces/<org>/support/tickets/<ticketId>/artifacts" -H "Authorization: Bearer $PILE_API_KEY"',
          "Text artifacts (debugger_json, network, log, replay) come back inline; screenshots/video come back as URLs with an available flag.",
        ]
      : []),
  ].join("\n");
}

function sanitizeEnv(value: string): string {
  return value
    .replaceAll("\r\n", " ")
    .replaceAll("\n", " ")
    .replaceAll("\0", "");
}

const PYTHON_RUNNER = runnerBundle.core + "\n" + runnerBundle.cursor;

function buildSandboxEnv(
  issue: Issue,
  model: string,
  apiKey: string,
  githubToken: string,
  gitIdentity: GitIdentity | null,
  comments?: DispatchComment[],
  instructions?: string,
  logUrl?: string | null,
  logToken?: string | null,
  cacheUrl?: string | null,
  pileApi?: { url: string; key: string } | null
): Record<string, string> {
  const branch = issue.branch ?? `issue-${issue.id}`;
  const repo = issue.repo ?? "";
  const identifier = issue.identifier ?? issue.id;
  const prompt = buildPrompt(
    issue,
    gitIdentity,
    comments,
    pileApi,
    instructions
  );
  return {
    ...(pileApi
      ? { PILE_API_URL: pileApi.url, PILE_API_KEY: pileApi.key }
      : {}),
    ...(logUrl && logToken
      ? { PILE_LOG_URL: logUrl, PILE_LOG_TOKEN: logToken }
      : {}),
    ...(cacheUrl ? { PILE_CACHE_URL: cacheUrl } : {}),
    CURSOR_API_KEY: apiKey,
    GITHUB_TOKEN: githubToken,
    ...(gitIdentity
      ? {
          GIT_AUTHOR_NAME: sanitizeEnv(gitIdentity.name),
          GIT_AUTHOR_EMAIL: sanitizeEnv(gitIdentity.email),
        }
      : {}),
    REPO: repo,
    BRANCH: branch,
    ISSUE_TITLE: sanitizeEnv(issue.title),
    ISSUE_IDENTIFIER: identifier,
    AGENT_LABEL: "Cursor CLI",
    MODEL: model,
    PROMPT_B64: encodeBase64(prompt),
    // Daytona mounts DAYTONA_VOLUME_ID at /home/daytona/cache; on CF sandboxes
    // this is just a local dir — harmless, and keeps the path consistent.
    npm_config_store_dir: "/home/daytona/cache/pnpm-store",
    RUNNER_PY_B64: encodeBase64(PYTHON_RUNNER),
  };
}

function sandboxName(sessionId: string): string {
  return `${NAME_PREFIX}-${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;
}

function buildRunnerCommand(): string {
  return "printf '%s' \"$RUNNER_PY_B64\" | base64 -d > /tmp/run.py && python3 /tmp/run.py";
}

export class CursorCliAgentProvider implements AgentProvider {
  readonly id = "cursor-cli";

  constructor(private env: AppEnv) {}

  private async note(
    organizationId: string | undefined,
    sessionId: string | undefined,
    type: "status" | "error" | "action",
    message: string,
    payload?: Record<string, unknown>,
    span?: ActivitySpanOptions
  ): Promise<void> {
    if (!("WORKSPACE_DURABLE_OBJECT" in this.env)) return;
    await writeAgentSessionActivity(
      this.env as WorkerEnv,
      organizationId,
      sessionId,
      type,
      message,
      payload,
      span
    );
  }

  private async openSpan(
    organizationId: string | undefined,
    sessionId: string | undefined,
    message: string,
    payload?: Record<string, unknown>
  ): Promise<string | undefined> {
    if (!("WORKSPACE_DURABLE_OBJECT" in this.env)) return undefined;
    return openAgentSessionSpan(
      this.env as WorkerEnv,
      organizationId,
      sessionId,
      message,
      payload
    );
  }

  private async closeSpan(
    organizationId: string | undefined,
    spanId: string | undefined
  ): Promise<void> {
    if (!("WORKSPACE_DURABLE_OBJECT" in this.env)) return;
    await closeAgentSessionSpan(this.env as WorkerEnv, organizationId, spanId);
  }

  private requireAuth(): string {
    const apiKey = this.env.CURSOR_API_KEY ?? this.env.AGENT_PROVIDER_TOKEN;
    if (!apiKey || typeof apiKey !== "string") {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "CURSOR_API_KEY is not configured",
      });
    }
    return apiKey;
  }

  private requireCompute(): ComputeBackend {
    return computeBackend(this.env, "cursor-cli");
  }

  private async githubToken(repo: string): Promise<string> {
    const [owner, name] = parseRepo(repo);
    const token = await getInstallationTokenForRepo(this.env, owner, name);
    if (!token) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: `Could not obtain GitHub installation token for ${repo}`,
      });
    }
    return token;
  }

  private async start(
    organizationId: string,
    issue: Issue,
    model: string,
    sessionId: string,
    gitIdentity: GitIdentity | null,
    comments?: DispatchComment[],
    pileApi?: { url: string; key: string },
    instructions?: string
  ) {
    const apiKey = this.requireAuth();
    const compute = this.requireCompute();
    // Repo-less lanes (preflight critiques, analysis) get no clone/push stage
    // and no GitHub token — the agent only reads the prompt and reports back.
    const githubToken = issue.repo ? await this.githubToken(issue.repo) : "";
    const name = sandboxName(sessionId);

    const spanId = await this.openSpan(
      organizationId,
      sessionId,
      "provision cursor-cli sandbox",
      { session: sessionId }
    );
    try {
      const existing = await compute.findSandbox(sessionId, name);
      if (existing) {
        await this.note(
          organizationId,
          sessionId,
          "status",
          "cursor-cli sandbox exists, recreating",
          { sandbox: existing.id, state: existing.state },
          { parentId: spanId }
        );
        await compute.deleteSandbox(existing);
      }

      const workerEnv = this.env as WorkerEnv;
      const sandboxEnv = buildSandboxEnv(
        issue,
        model,
        apiKey,
        githubToken,
        gitIdentity,
        comments,
        instructions,
        agentLogUrl(workerEnv, organizationId, sessionId),
        await agentLogToken(workerEnv, organizationId, sessionId),
        agentCacheUrl(workerEnv, organizationId, sessionId),
        pileApi ?? null
      );
      const sandbox = await compute.createSandbox({
        name,
        sessionId,
        organizationId,
        agentLabel: AGENT_LABEL,
        env: sandboxEnv,
      });
      await this.note(
        organizationId,
        sessionId,
        "status",
        "cursor-cli sandbox started",
        { sandbox: sandbox.id, state: sandbox.state, backend: compute.kind },
        { parentId: spanId }
      );
      await compute.startRunner(sandbox, sessionId, buildRunnerCommand());
      await this.note(
        organizationId,
        sessionId,
        "action",
        "cursor-cli runner started",
        { sandbox: sandbox.id },
        { parentId: spanId }
      );
    } catch (err) {
      await this.note(
        organizationId,
        sessionId,
        "error",
        err instanceof Error ? err.message : "cursor-cli provision failed",
        {
          error: err instanceof Error ? err.message : String(err),
        },
        { parentId: spanId }
      );
      throw err;
    } finally {
      await this.closeSpan(organizationId, spanId);
    }
  }

  async dispatch(
    organizationId: string,
    issue: Issue,
    model = DEFAULT_MODEL,
    sessionContext?: AgentDispatchContext
  ): Promise<AgentProviderSession> {
    const sessionId = sessionContext?.sessionId;
    if (!sessionId) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Missing tracker session id",
      });
    }
    const gitIdentity = sessionContext?.gitIdentity;
    // A repo-less lane (e.g. preflight critique) never commits — git identity
    // is only required when there's a repository to push to.
    if (!gitIdentity && issue.repo) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "Git identity is required for cursor-cli",
      });
    }
    const effectiveModel = model ?? this.env.CURSOR_CLI_MODEL ?? DEFAULT_MODEL;

    const startPromise = this.start(
      organizationId,
      issue,
      effectiveModel,
      sessionId,
      gitIdentity ?? null,
      sessionContext?.comments,
      sessionContext?.pileApi,
      sessionContext?.instructions
    );

    if (sessionContext?.waitUntil) {
      sessionContext.waitUntil(startPromise);
    } else {
      await startPromise;
    }

    return {
      id: sessionId,
      agentId: this.id,
      issueId: issue.id,
      status: "created",
    };
  }

  async poll(sessionId: string): Promise<AgentProviderSession> {
    const compute = this.requireCompute();
    const sandbox = await compute.findSandbox(
      sessionId,
      sandboxName(sessionId),
      RESULT_PATH
    );
    if (!sandbox) {
      return { id: sessionId, agentId: this.id, status: "created" };
    }
    if (sandbox.state === "error") {
      return {
        id: sessionId,
        agentId: this.id,
        status: "failed",
        infraFailure: true,
        result: sandbox.error ?? "compute sandbox error",
      };
    }
    if (sandbox.state !== "started") {
      return { id: sessionId, agentId: this.id, status: "created" };
    }

    const runner = await compute.runnerState(sandbox, sessionId);
    if (runner === "pending") {
      return { id: sessionId, agentId: this.id, status: "created" };
    }
    if (runner === "running") {
      return { id: sessionId, agentId: this.id, status: "running" };
    }

    const raw = await compute.readFile(sandbox, RESULT_PATH);
    let result: z.infer<typeof cursorResultSchema> | null = null;
    if (raw) {
      try {
        const parsed = cursorResultSchema.safeParse(JSON.parse(raw));
        if (parsed.success) result = parsed.data;
      } catch {
        result = null;
      }
    }
    if (!result) {
      await compute.deleteSandbox(sandbox);
      return {
        id: sessionId,
        agentId: this.id,
        status: "failed",
        infraFailure: true,
        result: `runner exited (code ${runner.exitCode}) without a result file`,
      };
    }

    const status: AgentSessionStatus =
      result.status === "completed" ? "completed" : "failed";
    const prUrl = result.prUrl?.trim() || null;
    const prState = prUrl ? "open" : null;

    await compute.deleteSandbox(sandbox);
    await this.note(
      sandbox.organizationId,
      sessionId,
      "status",
      "sandbox deleted after terminal result",
      { sandbox: sandbox.id }
    );

    return {
      id: sessionId,
      agentId: this.id,
      status,
      // The readable report (last assistant message) beats the raw
      // stream-json tail — it's what lands on issue threads and run summaries.
      result: result.report ?? result.result,
      prUrl,
      prState,
      branch: result.branch ?? null,
    };
  }

  async cancel(sessionId: string): Promise<void> {
    const compute = this.requireCompute();
    const sandbox = await compute.findSandbox(
      sessionId,
      sandboxName(sessionId),
      RESULT_PATH
    );
    if (sandbox) {
      await compute.deleteSandbox(sandbox);
      await this.note(
        sandbox.organizationId,
        sessionId,
        "status",
        "cursor-cli sandbox deleted",
        { sandbox: sandbox.id }
      );
    }
  }

  async getState(
    providerSessionId: string,
    _trackerSessionId: string
  ): Promise<AgentProviderState | null> {
    const compute = this.requireCompute();
    const sandbox = await compute.findSandbox(
      providerSessionId,
      sandboxName(providerSessionId),
      RESULT_PATH
    );
    if (!sandbox) return null;
    const runner = await compute.runnerState(sandbox, providerSessionId);
    const transcript = await compute.readFile(sandbox, "/tmp/agent.log");
    const logs =
      (transcript ? transcript.slice(-131072) : null) ??
      (await compute.runnerLogs?.(sandbox, providerSessionId)) ??
      null;
    return { provider: { state: runner, logs }, compute: sandbox };
  }

  async health(): Promise<AgentProviderHealth> {
    try {
      this.requireAuth();
      return await this.requireCompute().health();
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
