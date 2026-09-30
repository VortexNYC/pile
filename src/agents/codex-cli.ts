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

const DEFAULT_MODEL = "gpt-reserve";
const RESULT_PATH = "/tmp/agent-result.json";
const NAME_PREFIX = "vortex-codex";
const AGENT_LABEL = "codex-cli";

const codexResultSchema = z.object({
  status: z.enum(["completed", "failed"]).optional(),
  prUrl: z.string().optional(),
  branch: z.string().optional(),
  result: z.string().optional(),
});

function encodeBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(bin);
}

function normalizeAuthB64(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = atob(value);
    JSON.parse(decoded);
    return value;
  } catch {
    return encodeBase64(value);
  }
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
    "Implement the requested change. Verify proportionate to the diff: always run the project's lint/typecheck (for example `pnpm run check`) when the toolchain exists; when you change code, add or extend tests covering the change and run the relevant suites; skip tests entirely when the diff is docs/config-only. Do not burn time on suites that need network egress the sandbox lacks — note the limitation and move on. Make commits with clear messages. Push your changes to the current branch and open a GitHub pull request. Include the full PR URL in your final message.",
    "Do not attempt to update Pile yourself — an external system will poll your session and write the status back automatically.",
  ].join("\n");
}

function sanitizeEnv(value: string): string {
  return value
    .replaceAll("\r\n", " ")
    .replaceAll("\n", " ")
    .replaceAll("\0", "");
}

const PYTHON_RUNNER = runnerBundle.core + "\n" + runnerBundle.codex;

function buildSandboxEnv(
  issue: Issue,
  model: string,
  authB64: string,
  githubToken: string,
  gitIdentity: GitIdentity,
  envId: string,
  comments?: DispatchComment[],
  instructions?: string
): Record<string, string> {
  const branch = issue.branch ?? `issue-${issue.id}`;
  const repo = issue.repo ?? "";
  const identifier = issue.identifier ?? issue.id;
  const prompt = buildPrompt(issue, gitIdentity, comments, instructions);
  return {
    CODEX_AUTH_JSON_B64: authB64,
    CODEX_CLI_ENV_ID: envId,
    GITHUB_TOKEN: githubToken,
    GIT_AUTHOR_NAME: sanitizeEnv(gitIdentity.name),
    GIT_AUTHOR_EMAIL: sanitizeEnv(gitIdentity.email),
    REPO: repo,
    BRANCH: branch,
    ISSUE_TITLE: sanitizeEnv(issue.title),
    ISSUE_IDENTIFIER: identifier,
    AGENT_LABEL: "Codex Cloud",
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

export class CodexCliAgentProvider implements AgentProvider {
  readonly id = "codex-cli";

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
    const auth = normalizeAuthB64(this.env.CODEX_AUTH_JSON_B64);
    if (!auth) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "CODEX_AUTH_JSON_B64 is not configured",
      });
    }
    return auth;
  }

  private requireCompute(): ComputeBackend {
    return computeBackend(this.env, "codex-cli");
  }

  private requireEnvId(): string {
    const envId = this.env.CODEX_CLI_ENV_ID;
    if (!envId) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "CODEX_CLI_ENV_ID is not configured",
      });
    }
    return envId;
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
    gitIdentity: GitIdentity,
    comments?: DispatchComment[],
    instructions?: string
  ) {
    const authB64 = this.requireAuth();
    const compute = this.requireCompute();
    const envId = this.requireEnvId();
    if (!issue.repo) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Issue must have a repository",
      });
    }
    const githubToken = await this.githubToken(issue.repo);
    const name = sandboxName(sessionId);

    const spanId = await this.openSpan(
      organizationId,
      sessionId,
      "provision codex-cli sandbox",
      { session: sessionId }
    );
    try {
      const existing = await compute.findSandbox(sessionId, name);
      if (existing) {
        await this.note(
          organizationId,
          sessionId,
          "status",
          "codex-cli sandbox exists, recreating",
          { sandbox: existing.id, state: existing.state },
          { parentId: spanId }
        );
        await compute.deleteSandbox(existing);
      }

      const sandboxEnv = buildSandboxEnv(
        issue,
        model,
        authB64,
        githubToken,
        gitIdentity,
        envId,
        comments,
        instructions
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
        "codex-cli sandbox started",
        { sandbox: sandbox.id, state: sandbox.state, backend: compute.kind },
        { parentId: spanId }
      );
      await compute.startRunner(sandbox, sessionId, buildRunnerCommand());
      await this.note(
        organizationId,
        sessionId,
        "action",
        "codex-cli runner started",
        { sandbox: sandbox.id },
        { parentId: spanId }
      );
    } catch (err) {
      await this.note(
        organizationId,
        sessionId,
        "error",
        err instanceof Error ? err.message : "codex-cli provision failed",
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
    if (!gitIdentity) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "Git identity is required for codex-cli",
      });
    }
    const effectiveModel = model ?? this.env.CODEX_CLI_MODEL ?? DEFAULT_MODEL;

    const startPromise = this.start(
      organizationId,
      issue,
      effectiveModel,
      sessionId,
      gitIdentity,
      sessionContext?.comments,
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
    let result: z.infer<typeof codexResultSchema> | null = null;
    if (raw) {
      try {
        const parsed = codexResultSchema.safeParse(JSON.parse(raw));
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
      result: result.result,
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
        "codex-cli sandbox deleted",
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
      this.requireEnvId();
      return await this.requireCompute().health();
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
