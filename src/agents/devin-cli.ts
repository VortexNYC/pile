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
import { agentGithubTokenUrl, agentLogToken } from "./credentials.js";
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

const DEFAULT_MODEL = "swe-2";
const RESULT_PATH = "/tmp/agent-result.json";
const NAME_PREFIX = "vortex-devin";
const AGENT_LABEL = "devin-cli";
// Sandbox compute calls (findSandbox/createSandbox/startRunner) hang
// indefinitely when a container wedges — leaving the session `created`
// forever and holding the `waitUntil` thread. Bound the whole provision
// step; the failure propagates and the sweep's infra-retry re-drives it.
const PROVISION_TIMEOUT_MS = 5 * 60 * 1000;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const devinResultSchema = z.object({
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

function normalizeCredentialsB64(
  value: string | undefined
): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = atob(value);
    if (decoded.includes("=")) return value;
  } catch {
    // not valid base64 — encode raw TOML below
  }
  return encodeBase64(value);
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
  const repoLines = issue.repo
    ? [`Repository: https://github.com/${repo}`, `Branch: ${branch}`]
    : [
        "This task has no code repository — your workdir is empty. Produce the deliverable as files in the workdir and summarize it in your final answer.",
      ];
  return [
    `# ${issue.title}`,
    "",
    ...repoLines,
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
  ].join("\n");
}

function sanitizeEnv(value: string): string {
  return value
    .replaceAll("\r\n", " ")
    .replaceAll("\n", " ")
    .replaceAll("\0", "");
}

const PYTHON_RUNNER = runnerBundle.core + "\n" + runnerBundle.devin;

function buildSandboxEnv(
  issue: Issue,
  model: string,
  credentialsB64: string,
  githubToken: string,
  gitIdentity: GitIdentity | null,
  comments?: DispatchComment[],
  instructions?: string,
  extraEnv?: Record<string, string>,
  lane?: { tokenUrl: string | null; token: string | null }
): Record<string, string> {
  const branch = issue.branch ?? `issue-${issue.id}`;
  const repo = issue.repo ?? "";
  const identifier = issue.identifier ?? issue.id;
  const prompt = buildPrompt(issue, gitIdentity, comments, instructions);
  return {
    DEVIN_CREDENTIALS_B64: credentialsB64,
    GITHUB_TOKEN: githubToken,
    GIT_AUTHOR_NAME: sanitizeEnv(gitIdentity?.name ?? "Devin"),
    GIT_AUTHOR_EMAIL: sanitizeEnv(gitIdentity?.email ?? "devin@pile.nyc"),
    REPO: repo,
    BRANCH: branch,
    ISSUE_TITLE: sanitizeEnv(issue.title),
    ISSUE_IDENTIFIER: identifier,
    AGENT_LABEL: "Devin",
    MODEL: model,
    PROMPT_B64: encodeBase64(prompt),
    // Daytona mounts DAYTONA_VOLUME_ID at /home/daytona/cache; on CF sandboxes
    // this is just a local dir — harmless, and keeps the path consistent.
    npm_config_store_dir: "/home/daytona/cache/pnpm-store",
    RUNNER_PY_B64: encodeBase64(PYTHON_RUNNER),
    ...(lane?.tokenUrl && lane.token
      ? { PILE_TOKEN_URL: lane.tokenUrl, LANE_TOKEN: lane.token }
      : {}),
    ...extraEnv,
  };
}

function sandboxName(sessionId: string): string {
  return `${NAME_PREFIX}-${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;
}

function buildRunnerCommand(): string {
  return "printf '%s' \"$RUNNER_PY_B64\" | base64 -d > /tmp/run.py && python3 /tmp/run.py";
}

export class DevinCliAgentProvider implements AgentProvider {
  readonly id = "devin-cli";

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
    const creds = normalizeCredentialsB64(this.env.DEVIN_CLI_CREDENTIALS_B64);
    if (!creds) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "DEVIN_CLI_CREDENTIALS_B64 is not configured",
      });
    }
    return creds;
  }

  private requireCompute(): ComputeBackend {
    return computeBackend(this.env, "devin-cli");
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
    instructions?: string,
    extraEnv?: Record<string, string>
  ) {
    const credentialsB64 = this.requireAuth();
    const compute = this.requireCompute();
    const githubToken = issue.repo ? await this.githubToken(issue.repo) : "";
    const name = sandboxName(sessionId);

    const spanId = await this.openSpan(
      organizationId,
      sessionId,
      "provision devin-cli sandbox",
      { session: sessionId }
    );
    try {
      await withTimeout(
        (async () => {
          const existing = await compute.findSandbox(sessionId, name);
          if (existing) {
            await this.note(
              organizationId,
              sessionId,
              "status",
              "devin-cli sandbox exists, recreating",
              { sandbox: existing.id, state: existing.state },
              { parentId: spanId }
            );
            await compute.deleteSandbox(existing);
          }

          const workerEnv = this.env as WorkerEnv;
          const sandboxEnv = buildSandboxEnv(
            issue,
            model,
            credentialsB64,
            githubToken,
            gitIdentity,
            comments,
            instructions,
            extraEnv,
            {
              tokenUrl: agentGithubTokenUrl(
                workerEnv,
                organizationId,
                sessionId
              ),
              token: await agentLogToken(workerEnv, organizationId, sessionId),
            }
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
            "devin-cli sandbox started",
            {
              sandbox: sandbox.id,
              state: sandbox.state,
              backend: compute.kind,
            },
            { parentId: spanId }
          );
          await compute.startRunner(sandbox, sessionId, buildRunnerCommand());
          await this.note(
            organizationId,
            sessionId,
            "action",
            "devin-cli runner started",
            { sandbox: sandbox.id },
            { parentId: spanId }
          );
        })(),
        PROVISION_TIMEOUT_MS,
        "devin-cli provision"
      );
    } catch (err) {
      await this.note(
        organizationId,
        sessionId,
        "error",
        err instanceof Error ? err.message : "devin-cli provision failed",
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
        message: "Git identity is required for devin-cli",
      });
    }
    const effectiveModel = model ?? this.env.DEVIN_CLI_MODEL ?? DEFAULT_MODEL;

    const startPromise = this.start(
      organizationId,
      issue,
      effectiveModel,
      sessionId,
      gitIdentity,
      sessionContext?.comments,
      sessionContext?.instructions,
      sessionContext?.extraEnv
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

    // The primary process exited — but a follow-up run (sendPrompt) may be
    // in flight under a `${sessionId}-fu-*` sibling process id.
    const followupActive =
      (await compute.runnerBusy?.(sandbox, sessionId)) === true;
    if (followupActive) {
      return { id: sessionId, agentId: this.id, status: "running" };
    }

    const raw = await compute.readFile(sandbox, RESULT_PATH);
    let result: z.infer<typeof devinResultSchema> | null = null;
    if (raw) {
      try {
        const parsed = devinResultSchema.safeParse(JSON.parse(raw));
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

    // Keep the sandbox — sleepAfter parks it inside ~4h and the sweep's
    // terminal-sandbox reaper destroys it after the resume window. Deleting
    // here would make sendPrompt/follow-ups impossible (PILE-210).
    await this.note(
      sandbox.organizationId,
      sessionId,
      "status",
      "sandbox kept alive for follow-up prompts",
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

  /**
   * Follow-up prompt (PILE-210): start a `${sessionId}-fu-*` process on the
   * kept sandbox in FOLLOWUP mode — skips clone, resumes the branch, runs
   * devin with the new instruction, commits/pushes, rewrites the result file.
   * startProcess registers the process record before resolving, so a poll
   * that lands mid-run sees runnerBusy()=true instead of the stale result.
   */
  async sendPrompt(
    trackerSessionId: string,
    prompt: string,
    issue: Issue,
    gitIdentity?: GitIdentity | null
  ): Promise<boolean> {
    const compute = this.requireCompute();
    const sandbox = await compute.findSandbox(
      trackerSessionId,
      sandboxName(trackerSessionId),
      RESULT_PATH
    );
    if (!sandbox || sandbox.state !== "started") return false;
    if ((await compute.runnerBusy?.(sandbox, trackerSessionId)) === true) {
      // Mid-run injection: the runner's watcher thread feeds files dropped in
      // /tmp/followups into the live devin process's stdin (and drains any
      // never-consumed leftovers as continuation runs after the primary exits).
      await compute.writeFile(
        sandbox,
        `/tmp/followups/${Date.now().toString(36)}.prompt`,
        prompt
      );
      await this.note(
        sandbox.organizationId,
        trackerSessionId,
        "action",
        "follow-up prompt injected into running sandbox",
        { channel: "stdin" }
      );
      return true;
    }

    const credentialsB64 = this.requireAuth();
    const githubToken = issue.repo ? await this.githubToken(issue.repo) : "";
    const followupId = `${trackerSessionId}-fu-${Date.now().toString(36)}`;

    const followupEnv = buildSandboxEnv(
      issue,
      this.env.DEVIN_CLI_MODEL ?? DEFAULT_MODEL,
      credentialsB64,
      githubToken,
      gitIdentity ?? {
        id: "followup",
        organizationId: "",
        repo: issue.repo ?? "",
        name: "Devin",
        email: "devin@pile.nyc",
        githubUsername: null,
        signingKeyRef: null,
        createdAt: "",
        updatedAt: "",
      },
      undefined,
      prompt,
      { FOLLOWUP: "1" },
      // org may be absent when the sandbox was found via result file — no
      // lane token without it, refresh just no-ops in the runner.
      sandbox.organizationId
        ? {
            tokenUrl: agentGithubTokenUrl(
              this.env as WorkerEnv,
              sandbox.organizationId,
              trackerSessionId
            ),
            token: await agentLogToken(
              this.env as WorkerEnv,
              sandbox.organizationId,
              trackerSessionId
            ),
          }
        : undefined
    );

    await compute.startRunner(
      sandbox,
      followupId,
      buildRunnerCommand(),
      followupEnv
    );
    await this.note(
      sandbox.organizationId,
      trackerSessionId,
      "action",
      "follow-up prompt delivered to live sandbox",
      { followupId }
    );
    return true;
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
        "devin-cli sandbox deleted",
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
