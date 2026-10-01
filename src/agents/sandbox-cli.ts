// Shared sandbox-CLI agent provider. Every agent that runs as a binary
// inside a Pile sandbox is the same lifecycle: provision → env → runner
// script → poll result file → git/PR handled by the runner. Per-agent
// differences are a small descriptor — credentials, driver script, model
// default, follow-up support — never a copied provider class.
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
  agentCacheUrl,
  agentGithubTokenUrl,
  agentLogToken,
  agentLogUrl,
} from "./credentials.js";
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

const RESULT_PATH = "/tmp/agent-result.json";
// Sandbox compute calls (findSandbox/createSandbox/startRunner) hang
// indefinitely when a container wedges — leaving the session `created`
// forever and holding the `waitUntil` thread. Bound the whole provision
// step; the failure propagates and the sweep's infra-retry re-drives it.
const PROVISION_TIMEOUT_MS = 5 * 60 * 1000;

const runnerResultSchema = z.object({
  status: z.enum(["completed", "failed"]).optional(),
  prUrl: z.string().optional(),
  branch: z.string().optional(),
  result: z.string().optional(),
  report: z.string().optional(),
  // The runner sets this when the run died on the substrate (git transport,
  // codeload, token mint) rather than on the task — gates the infra retry.
  infraFailure: z.boolean().optional(),
});

type RunnerResult = z.infer<typeof runnerResultSchema>;

/** What is actually different between sandbox-CLI agents. */
export interface SandboxCliDescriptor {
  /** Provider id, e.g. "cursor-cli". */
  id: string;
  /** Human-facing label stamped into commits/PRs via AGENT_LABEL. */
  displayLabel: string;
  /** Sandbox name prefix, e.g. "vortex-cursorcli". */
  namePrefix: string;
  /** Which runner driver is appended after core.py. */
  driver: "cursor" | "devin" | "codex";
  defaultModel: string;
  /** Env var that overrides defaultModel. */
  modelEnv: "CURSOR_CLI_MODEL" | "DEVIN_CLI_MODEL" | "CODEX_CLI_MODEL";
  /** Resolve the provider credential or throw CONFIG_ERROR. */
  requireAuth(env: AppEnv): string;
  /** Any extra config required beyond the credential (e.g. CODEX_CLI_ENV_ID). */
  requireConfig?(env: AppEnv): void;
  /** Credential → sandbox env vars. */
  credentialEnv(credential: string, env: AppEnv): Record<string, string>;
  /** Require a repo + git identity even for dispatch (codex cloud tasks). */
  requiresRepo?: boolean;
  /** Keep the sandbox after terminal result so follow-up prompts can resume
   *  it (devin), and check runnerBusy in poll before reading the result. */
  followup?: boolean;
  /** Prompt tail override — default tells the agent not to push (the runner
   *  does); codex cloud tasks need different wording. */
  pushInstruction?: string;
}

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

function sanitizeEnv(value: string): string {
  return value
    .replaceAll("\r\n", " ")
    .replaceAll("\n", " ")
    .replaceAll("\0", "");
}

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

function buildPrompt(
  issue: Issue,
  gitIdentity: GitIdentity | null,
  comments: DispatchComment[] | undefined,
  pileApi: { url: string; key: string } | null,
  instructions: string | undefined,
  pushInstruction: string
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
    pushInstruction,
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

const DEFAULT_PUSH_INSTRUCTION =
  "Implement the requested change. Verify proportionate to the diff: always run the project's lint/typecheck (for example `pnpm run check`) when the toolchain exists; when you change code, add or extend tests covering the change and run the relevant suites; skip tests entirely when the diff is docs/config-only. Do not burn time on suites that need network egress the sandbox lacks — note the limitation and move on. Make commits with clear messages. Do not push and do not open a pull request — the runner handles that after you exit.";

export class SandboxCliAgentProvider implements AgentProvider {
  readonly id: string;
  readonly keepsTerminalSandbox: boolean;

  constructor(
    private env: AppEnv,
    private d: SandboxCliDescriptor
  ) {
    this.id = d.id;
    this.keepsTerminalSandbox = d.followup === true;
  }

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

  private requireCompute(): ComputeBackend {
    return computeBackend(this.env, this.d.id);
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

  private sandboxName(sessionId: string): string {
    return `${this.d.namePrefix}-${sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;
  }

  private buildSandboxEnv(
    issue: Issue,
    model: string,
    credential: string,
    githubToken: string,
    gitIdentity: GitIdentity | null,
    options: {
      comments?: DispatchComment[];
      instructions?: string;
      pileApi?: { url: string; key: string } | null;
      lane?: { tokenUrl: string | null; token: string | null };
      log?: { url: string | null; token: string | null };
      cacheUrl?: string | null;
      extra?: Record<string, string>;
    }
  ): Record<string, string> {
    const prompt = buildPrompt(
      issue,
      gitIdentity,
      options.comments,
      options.pileApi ?? null,
      options.instructions,
      this.d.pushInstruction ?? DEFAULT_PUSH_INSTRUCTION
    );
    return {
      ...this.d.credentialEnv(credential, this.env),
      ...(options.pileApi
        ? {
            PILE_API_URL: options.pileApi.url,
            PILE_API_KEY: options.pileApi.key,
          }
        : {}),
      ...(options.log?.url && options.log.token
        ? { PILE_LOG_URL: options.log.url, PILE_LOG_TOKEN: options.log.token }
        : {}),
      ...(options.cacheUrl ? { PILE_CACHE_URL: options.cacheUrl } : {}),
      ...(options.lane?.tokenUrl && options.lane.token
        ? {
            PILE_TOKEN_URL: options.lane.tokenUrl,
            LANE_TOKEN: options.lane.token,
          }
        : {}),
      GITHUB_TOKEN: githubToken,
      GIT_AUTHOR_NAME: sanitizeEnv(gitIdentity?.name ?? this.d.displayLabel),
      GIT_AUTHOR_EMAIL: sanitizeEnv(
        gitIdentity?.email ??
          `${this.d.displayLabel.toLowerCase().replace(/\s+/g, "")}@pile.nyc`
      ),
      REPO: issue.repo ?? "",
      BRANCH: issue.branch ?? `issue-${issue.id}`,
      ISSUE_TITLE: sanitizeEnv(issue.title),
      ISSUE_IDENTIFIER: issue.identifier ?? issue.id,
      AGENT_LABEL: this.d.displayLabel,
      MODEL: model,
      PROMPT_B64: encodeBase64(prompt),
      // Daytona mounts DAYTONA_VOLUME_ID at /home/daytona/cache; on CF
      // sandboxes this is just a local dir — harmless, keeps the path
      // consistent for the runner's pnpm-store cache.
      npm_config_store_dir: "/home/daytona/cache/pnpm-store",
      RUNNER_PY_B64: encodeBase64(
        runnerBundle.core + "\n" + runnerBundle[this.d.driver]
      ),
      ...options.extra,
    };
  }

  private async start(
    organizationId: string,
    issue: Issue,
    model: string,
    sessionId: string,
    gitIdentity: GitIdentity | null,
    sessionContext?: AgentDispatchContext
  ) {
    const credential = this.d.requireAuth(this.env);
    this.d.requireConfig?.(this.env);
    const compute = this.requireCompute();
    // Repo-less lanes (preflight critiques, analysis) get no clone/push stage
    // and no GitHub token — the agent only reads the prompt and reports back.
    const githubToken = issue.repo ? await this.githubToken(issue.repo) : "";
    const name = this.sandboxName(sessionId);

    const spanId = await this.openSpan(
      organizationId,
      sessionId,
      `provision ${this.id} sandbox`,
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
              `${this.id} sandbox exists, recreating`,
              { sandbox: existing.id, state: existing.state },
              { parentId: spanId }
            );
            await compute.deleteSandbox(existing);
          }

          const workerEnv = this.env as WorkerEnv;
          const logToken = await agentLogToken(
            workerEnv,
            organizationId,
            sessionId
          );
          const sandboxEnv = this.buildSandboxEnv(
            issue,
            model,
            credential,
            githubToken,
            gitIdentity,
            {
              comments: sessionContext?.comments,
              instructions: sessionContext?.instructions,
              pileApi: sessionContext?.pileApi ?? null,
              extra: sessionContext?.extraEnv,
              log: {
                url: agentLogUrl(workerEnv, organizationId, sessionId),
                token: logToken,
              },
              cacheUrl: agentCacheUrl(workerEnv, organizationId, sessionId),
              lane: {
                tokenUrl: agentGithubTokenUrl(
                  workerEnv,
                  organizationId,
                  sessionId
                ),
                token: logToken,
              },
            }
          );
          const sandbox = await compute.createSandbox({
            name,
            sessionId,
            organizationId,
            agentLabel: this.id,
            env: sandboxEnv,
          });
          await this.note(
            organizationId,
            sessionId,
            "status",
            `${this.id} sandbox started`,
            {
              sandbox: sandbox.id,
              state: sandbox.state,
              backend: compute.kind,
            },
            { parentId: spanId }
          );
          await compute.startRunner(
            sandbox,
            sessionId,
            "printf '%s' \"$RUNNER_PY_B64\" | base64 -d > /tmp/run.py && python3 /tmp/run.py"
          );
          await this.note(
            organizationId,
            sessionId,
            "action",
            `${this.id} runner started`,
            { sandbox: sandbox.id },
            { parentId: spanId }
          );
        })(),
        PROVISION_TIMEOUT_MS,
        `${this.id} provision`
      );
    } catch (err) {
      await this.note(
        organizationId,
        sessionId,
        "error",
        err instanceof Error ? err.message : `${this.id} provision failed`,
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
    model?: string,
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
    if (this.d.requiresRepo && !issue.repo) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Issue must have a repository",
      });
    }
    const gitIdentity = sessionContext?.gitIdentity;
    // A repo-less lane (e.g. preflight critique) never commits — git identity
    // is only required when there's a repository to push to, unless the
    // provider's run mechanism needs it regardless.
    if (!gitIdentity && (issue.repo || this.d.requiresRepo)) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: `Git identity is required for ${this.id}`,
      });
    }
    const envModel = this.env[this.d.modelEnv];
    const effectiveModel =
      model ??
      (typeof envModel === "string" ? envModel : undefined) ??
      this.d.defaultModel;

    const startPromise = this.start(
      organizationId,
      issue,
      effectiveModel,
      sessionId,
      gitIdentity ?? null,
      sessionContext
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
      this.sandboxName(sessionId),
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
    if (
      this.d.followup &&
      (await compute.runnerBusy?.(sandbox, sessionId)) === true
    ) {
      return { id: sessionId, agentId: this.id, status: "running" };
    }

    const raw = await compute.readFile(sandbox, RESULT_PATH);
    let result: RunnerResult | null = null;
    if (raw) {
      try {
        const parsed = runnerResultSchema.safeParse(JSON.parse(raw));
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

    if (this.d.followup) {
      // Keep the sandbox — sleepAfter parks it and the sweep's
      // terminal-sandbox reaper destroys it after the resume window.
      // Deleting here would make sendPrompt/follow-ups impossible.
      await this.note(
        sandbox.organizationId,
        sessionId,
        "status",
        "sandbox kept alive for follow-up prompts",
        { sandbox: sandbox.id }
      );
    } else {
      await compute.deleteSandbox(sandbox);
      await this.note(
        sandbox.organizationId,
        sessionId,
        "status",
        "sandbox deleted after terminal result",
        { sandbox: sandbox.id }
      );
    }

    return {
      id: sessionId,
      agentId: this.id,
      status,
      // The readable report (last assistant message) beats the raw
      // stream-json tail — it's what lands on issue threads and summaries.
      result: result.report ?? result.result,
      prUrl,
      prState,
      branch: result.branch ?? null,
      infraFailure: result.infraFailure,
    };
  }

  /**
   * Follow-up prompt: inject into a running runner via /tmp/followups, or
   * start a `${sessionId}-fu-*` process on the kept sandbox in FOLLOWUP
   * mode — skips clone, resumes the branch, runs the new instruction,
   * commits/pushes, rewrites the result file.
   */
  async sendPrompt(
    trackerSessionId: string,
    prompt: string,
    issue: Issue,
    gitIdentity?: GitIdentity | null
  ): Promise<boolean> {
    if (!this.d.followup) return false;
    const compute = this.requireCompute();
    const sandbox = await compute.findSandbox(
      trackerSessionId,
      this.sandboxName(trackerSessionId),
      RESULT_PATH
    );
    if (!sandbox || sandbox.state !== "started") return false;
    if ((await compute.runnerBusy?.(sandbox, trackerSessionId)) === true) {
      // Mid-run injection: the runner's watcher thread feeds files dropped in
      // /tmp/followups into the live agent process's stdin (and drains any
      // never-consumed leftovers as continuation runs after it exits).
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

    const credential = this.d.requireAuth(this.env);
    const githubToken = issue.repo ? await this.githubToken(issue.repo) : "";
    const followupId = `${trackerSessionId}-fu-${Date.now().toString(36)}`;
    const followupEnv = this.buildSandboxEnv(
      issue,
      this.defaultModel(),
      credential,
      githubToken,
      gitIdentity ?? {
        id: "followup",
        organizationId: "",
        repo: issue.repo ?? "",
        name: this.d.displayLabel,
        email: `${this.d.displayLabel.toLowerCase().replace(/\s+/g, "")}@pile.nyc`,
        githubUsername: null,
        signingKeyRef: null,
        createdAt: "",
        updatedAt: "",
      },
      {
        instructions: prompt,
        extra: { FOLLOWUP: "1" },
        // org may be absent when the sandbox was found via result file — no
        // lane token without it, refresh just no-ops in the runner.
        lane: sandbox.organizationId
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
          : undefined,
      }
    );

    await compute.startRunner(
      sandbox,
      followupId,
      "printf '%s' \"$RUNNER_PY_B64\" | base64 -d > /tmp/run.py && python3 /tmp/run.py",
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
    const name = this.sandboxName(sessionId);
    const sandbox = await compute.findSandbox(sessionId, name, RESULT_PATH);
    // findSandbox can miss a sleeping/idle container (process record gone,
    // result file unreadable) while the DO is still billing an instance.
    // Destroy by name regardless — backends tolerate deleting the unknown.
    const target = sandbox ?? { id: name, name, state: "started" as const };
    try {
      await compute.deleteSandbox(target);
      await this.note(
        target.organizationId ?? sandbox?.organizationId,
        sessionId,
        "status",
        `${this.id} sandbox deleted`,
        { sandbox: target.id }
      );
    } catch (err) {
      await this.note(
        undefined,
        sessionId,
        "status",
        `${this.id} sandbox delete failed`,
        {
          sandbox: name,
          error: err instanceof Error ? err.message : String(err),
        }
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
      this.sandboxName(providerSessionId),
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

  private defaultModel(): string {
    const envModel = this.env[this.d.modelEnv];
    return typeof envModel === "string" && envModel
      ? envModel
      : this.d.defaultModel;
  }

  async health(): Promise<AgentProviderHealth> {
    try {
      this.d.requireAuth(this.env);
      this.d.requireConfig?.(this.env);
      return await this.requireCompute().health();
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
