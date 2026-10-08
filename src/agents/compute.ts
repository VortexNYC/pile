import type { Sandbox } from "@cloudflare/sandbox";
import { z } from "zod";

import { VortexError } from "../platform/errors.js";
import type { AppEnv } from "../types/env.js";
import {
  daytonaConfig,
  daytonaSandboxListSchema,
  daytonaSandboxSchema,
} from "./daytona.js";

const DEFAULT_FALLBACK_TOOLBOX = "https://proxy.app.daytona.io/toolbox";
const POLL_INTERVAL_MS = 5000;
const MAX_START_POLLS = 60; // 5 minutes
const CF_SLEEP_AFTER = "4h"; // leak ceiling, above the runner's 2h timeout
// Bound every compute I/O call — a wedged sandbox or dead toolbox must fail
// fast, not hold the request/DO open indefinitely (PILE-217).
const IO_TIMEOUT_MS = 30_000;

function ioTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          computeError(`${what} timed out after ${IO_TIMEOUT_MS / 1000}s`, 504)
        ),
      IO_TIMEOUT_MS
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const daytonaProcessSessionSchema = z.object({
  sessionId: z.string(),
  commands: z
    .array(
      z.object({
        id: z.string(),
        command: z.string(),
        exitCode: z.number().optional(),
      })
    )
    .default([]),
});

const daytonaSyncExecSchema = z.object({
  result: z.string().nullish(),
  exitCode: z.number().nullish(),
});

export interface ComputeSandbox {
  id: string;
  name: string;
  state: string;
  organizationId?: string;
  error?: string | null;
  /** Process env carried from createSandbox to startRunner (Cloudflare). */
  runnerEnv?: Record<string, string>;
  /** Daytona toolbox proxy URL, when the record provides one. */
  toolboxProxyUrl?: string | null;
}

export type RunnerState = "pending" | "running" | { exitCode: number };

export interface ComputeBackend {
  readonly kind: "daytona" | "cloudflare";
  createSandbox(opts: {
    name: string;
    sessionId: string;
    organizationId: string;
    agentLabel: string;
    env: Record<string, string>;
  }): Promise<ComputeSandbox>;
  findSandbox(
    sessionId: string,
    name: string,
    resultPath?: string
  ): Promise<ComputeSandbox | null>;
  /**
   * Block until the lane's runner process is actually alive — the runner
   * binds 127.0.0.1:8787 as its readiness signal (PILE-308). Absent on
   * backends that can't probe ports; callers treat missing as best-effort.
   */
  waitForRunner?(
    sandbox: ComputeSandbox,
    processId: string,
    timeoutMs: number
  ): Promise<void>;

  startRunner(
    sandbox: ComputeSandbox,
    sessionId: string,
    command: string,
    env?: Record<string, string>
  ): Promise<void>;
  runnerState(sandbox: ComputeSandbox, sessionId: string): Promise<RunnerState>;
  readFile(sandbox: ComputeSandbox, path: string): Promise<string | null>;
  writeFile(
    sandbox: ComputeSandbox,
    path: string,
    content: string
  ): Promise<void>;
  /** Any runner process in flight for this session — used to distinguish a
   *  follow-up run from a dead lane after the primary process exits. */
  runnerBusy?(sandbox: ComputeSandbox, sessionId: string): Promise<boolean>;
  runnerLogs?(
    sandbox: ComputeSandbox,
    sessionId: string
  ): Promise<string | null>;
  deleteSandbox(sandbox: ComputeSandbox): Promise<void>;
  /**
   * Serialize the lane worktree (/workspace/repo) to an R2 backup before the
   * sandbox is destroyed. Returns a JSON string the caller stores on the
   * session row; restoreWorktree() revives a fresh sandbox from it.
   */
  backupWorktree?(sandbox: ComputeSandbox): Promise<string | null>;
  /** Spawn a sandbox under `name` and restore a stored worktree backup. */
  restoreWorktree?(name: string, backupJson: string): Promise<ComputeSandbox>;
  /**
   * Mount the repo's shared lane cache (pnpm-store tarballs) into the
   * sandbox. Returns the mount path, or null when the backend has no cache
   * storage or the mount failed — lanes then fall back to the HTTP cache.
   */
  mountCache?(
    sandbox: ComputeSandbox,
    opts: { organizationId: string; repo: string; readOnly: boolean }
  ): Promise<string | null>;
  /** Public URL for a port on the sandbox — quick tunnel, lives as long as the container. */
  previewUrl?(sandbox: ComputeSandbox, port: number): Promise<string | null>;
  health(): Promise<{ ok: boolean; message?: string }>;
}

function computeError(message: string, status = 502): VortexError {
  return new VortexError({ code: "AGENT_ERROR", status, message });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodeUtf8Base64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bin = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(bin);
}

// ---------------------------------------------------------------------------
// Daytona
// ---------------------------------------------------------------------------

class DaytonaBackend implements ComputeBackend {
  readonly kind = "daytona" as const;

  constructor(
    private env: AppEnv,
    private config: { apiKey: string; apiUrl: string }
  ) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.config.apiUrl}${path}`, {
      signal: AbortSignal.timeout(IO_TIMEOUT_MS),
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        ...init?.headers,
      },
    });
  }

  async createSandbox(opts: {
    name: string;
    sessionId: string;
    organizationId: string;
    agentLabel: string;
    env: Record<string, string>;
  }): Promise<ComputeSandbox> {
    const res = await this.request("/sandbox", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: opts.name,
        snapshot: this.env.DAYTONA_SNAPSHOT ?? "daytona-vm-small",
        env: opts.env,
        labels: {
          "vortex.session": opts.sessionId,
          "vortex.org": opts.organizationId,
          "vortex.agent": opts.agentLabel,
        },
        autoStopInterval: 240, // leak ceiling: 4h, above the runner's 2h timeout
        autoDeleteInterval: -1,
        ...(this.env.DAYTONA_VOLUME_ID
          ? {
              volumes: [
                {
                  volumeId: this.env.DAYTONA_VOLUME_ID,
                  mountPath: "/home/daytona/cache",
                },
              ],
            }
          : {}),
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw computeError(
        `Daytona sandbox create failed: ${res.status} ${text}`
      );
    }
    const created = daytonaSandboxSchema.parse(await res.json());
    return this.waitForStarted(created.id).then((s) => ({
      id: s.id,
      name: s.name,
      state: s.state,
      organizationId: s.labels?.["vortex.org"],
      error: s.error ?? null,
      toolboxProxyUrl: s.toolboxProxyUrl,
    }));
  }

  private async waitForStarted(
    sandboxId: string
  ): Promise<z.infer<typeof daytonaSandboxSchema>> {
    const poll = async (
      i: number
    ): Promise<z.infer<typeof daytonaSandboxSchema>> => {
      if (i >= MAX_START_POLLS) {
        throw computeError("Daytona sandbox did not start in time", 504);
      }
      const res = await this.request(`/sandbox/${sandboxId}`);
      if (!res.ok) {
        const text = await res.text();
        throw computeError(`Daytona sandbox get failed: ${res.status} ${text}`);
      }
      const sandbox = daytonaSandboxSchema.parse(await res.json());
      if (sandbox.state === "started") return sandbox;
      if (sandbox.state === "error") {
        throw computeError(
          `Daytona sandbox failed: ${sandbox.error ?? "unknown error"}`
        );
      }
      await delay(POLL_INTERVAL_MS);
      return poll(i + 1);
    };
    return poll(0);
  }

  async findSandbox(
    sessionId: string,
    name: string
  ): Promise<ComputeSandbox | null> {
    const res = await this.request("/sandbox");
    if (!res.ok) {
      const text = await res.text();
      throw computeError(`Daytona sandbox list failed: ${res.status} ${text}`);
    }
    const list = daytonaSandboxListSchema.parse(await res.json());
    const sandbox =
      list.items.find(
        (s) => s.labels?.["vortex.session"] === sessionId || s.name === name
      ) ?? null;
    if (!sandbox) return null;
    return {
      id: sandbox.id,
      name: sandbox.name,
      state: sandbox.state,
      organizationId: sandbox.labels?.["vortex.org"],
      error: sandbox.error ?? null,
      toolboxProxyUrl: sandbox.toolboxProxyUrl,
    };
  }

  private toolbox(sandbox: ComputeSandbox) {
    return `${sandbox.toolboxProxyUrl ?? DEFAULT_FALLBACK_TOOLBOX}/${sandbox.id}`;
  }

  async startRunner(
    sandbox: ComputeSandbox,
    sessionId: string,
    command: string,
    env?: Record<string, string>
  ): Promise<void> {
    const base = this.toolbox(sandbox);
    // Toolbox exec has no per-command env — write a sourced env file and
    // prefix the command instead. Values are single-quote escaped.
    if (env && Object.keys(env).length > 0) {
      const envPath = `/tmp/pile-env-${sessionId.replace(/[^a-zA-Z0-9-]/g, "")}.sh`;
      const body = Object.entries(env)
        .map(([k, v]) => `export ${k}='${v.replaceAll("'", "'\\''")}'`)
        .join("\n");
      await this.writeFile(sandbox, envPath, body);
      command = `set -a && . ${envPath} && set +a && rm -f ${envPath}; ${command}`;
    }
    const createRes = await fetch(`${base}/process/session`, {
      signal: AbortSignal.timeout(IO_TIMEOUT_MS),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ sessionId }),
    });
    if (!createRes.ok && createRes.status !== 409) {
      const text = await createRes.text();
      throw computeError(
        `Daytona process session create failed: ${createRes.status} ${text}`
      );
    }
    const execRes = await fetch(`${base}/process/session/${sessionId}/exec`, {
      signal: AbortSignal.timeout(IO_TIMEOUT_MS),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ command, runAsync: true }),
    });
    if (!execRes.ok) {
      const text = await execRes.text();
      throw computeError(
        `Daytona process exec failed: ${execRes.status} ${text}`
      );
    }
  }

  async runnerState(
    sandbox: ComputeSandbox,
    sessionId: string
  ): Promise<RunnerState> {
    const base = this.toolbox(sandbox);
    const res = await fetch(`${base}/process/session/${sessionId}`, {
      signal: AbortSignal.timeout(IO_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });
    if (res.status === 404) return "pending";
    if (!res.ok) {
      const text = await res.text();
      throw computeError(
        `Daytona process session get failed: ${res.status} ${text}`
      );
    }
    const session = daytonaProcessSessionSchema.parse(await res.json());
    const completed = session.commands.find(
      (c) => typeof c.exitCode === "number"
    );
    if (!completed || completed.exitCode === undefined) return "running";
    return { exitCode: completed.exitCode };
  }

  async readFile(
    sandbox: ComputeSandbox,
    path: string
  ): Promise<string | null> {
    const base = this.toolbox(sandbox);
    const res = await fetch(`${base}/process/execute`, {
      signal: AbortSignal.timeout(IO_TIMEOUT_MS),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ command: `cat ${path}`, cwd: "/" }),
    });
    if (!res.ok) return null;
    const data = daytonaSyncExecSchema.parse(await res.json());
    if (data.exitCode !== 0 || !data.result) return null;
    return data.result;
  }

  async writeFile(
    sandbox: ComputeSandbox,
    path: string,
    content: string
  ): Promise<void> {
    const base = this.toolbox(sandbox);
    const res = await fetch(`${base}/process/execute`, {
      signal: AbortSignal.timeout(IO_TIMEOUT_MS),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        command: `python3 -c "import base64,sys;open(sys.argv[1],'wb').write(base64.b64decode(sys.argv[2]))" ${path} ${encodeUtf8Base64(content)}`,
        cwd: "/",
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw computeError(`Daytona writeFile failed: ${res.status} ${text}`);
    }
    const data = daytonaSyncExecSchema.parse(await res.json());
    if (data.exitCode !== 0) {
      throw computeError(
        `Daytona writeFile exited ${data.exitCode}: ${data.result ?? ""}`
      );
    }
  }

  async runnerBusy(
    sandbox: ComputeSandbox,
    sessionId: string
  ): Promise<boolean> {
    const base = this.toolbox(sandbox);
    // The runner uses one process session per attempt: `${sessionId}` for the
    // primary run and `${sessionId}-fu` for follow-ups. Busy = any tracked
    // session has a command that hasn't reported an exit code.
    for (const pid of [sessionId, `${sessionId}-fu`]) {
      const res = await fetch(`${base}/process/session/${pid}`, {
        signal: AbortSignal.timeout(IO_TIMEOUT_MS),
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
      }).catch(() => null);
      if (!res?.ok) continue;
      const parsed = daytonaProcessSessionSchema.safeParse(await res.json());
      if (
        parsed.success &&
        parsed.data.commands.some((c) => c.exitCode === undefined)
      ) {
        return true;
      }
    }
    return false;
  }

  async deleteSandbox(sandbox: ComputeSandbox): Promise<void> {
    const res = await this.request(`/sandbox/${sandbox.id}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw computeError(
        `Daytona sandbox delete failed: ${res.status} ${text}`
      );
    }
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    const res = await this.request("/sandbox");
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, message: `${res.status} ${text.slice(0, 200)}` };
    }
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Cloudflare Sandbox (Workers Containers)
// ---------------------------------------------------------------------------

export type SandboxHandle = Pick<
  Sandbox,
  | "getProcess"
  | "listProcesses"
  | "startProcess"
  | "readFile"
  | "writeFile"
  | "destroy"
  | "getProcessLogs"
  | "createBackup"
  | "restoreBackup"
  | "exec"
  | "tunnels"
  | "mountBucket"
  | "unmountBucket"
>;

export const LANE_CACHE_MOUNT = "/mnt/pile-cache";

const cacheSegment = (value: string) => {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, "_");
  return /^\.+$/.test(safe) ? "_" : safe;
};

/**
 * Bucket prefix a lane's cache mount is scoped to: one per (workspace, repo),
 * so lanes on the same repo share warm caches and nothing crosses tenants.
 * The R2 egress handler enforces the prefix outside the container.
 */
export function laneCachePrefix(organizationId: string, repo: string): string {
  const segments = repo.split("/").filter(Boolean).map(cacheSegment);
  return `/${cacheSegment(organizationId)}/${segments.join("/")}/`;
}

export class CloudflareBackend implements ComputeBackend {
  readonly kind = "cloudflare" as const;

  constructor(
    private getHandle: (name: string) => Promise<SandboxHandle>,
    private env?: AppEnv
  ) {}

  /**
   * Shared account-level admission (PILE-302): cloudflare-ci's scheduler DO
   * is the one ledger that sees CI containers AND lane sandboxes, so a pile
   * spawn can't race a CI build into "WebSocket upgrade failed: 503" land.
   * Opt-in via CF_ADMISSION_URL/TOKEN; unreachable endpoints fail open —
   * a dead admission service must not take the lane fleet down with it.
   */
  private async admit(name: string): Promise<void> {
    const url = this.env?.CF_ADMISSION_URL;
    const token = this.env?.CF_ADMISSION_TOKEN;
    if (!url || !token) return;
    try {
      const res = await fetch(`${url}/admin/sandbox/admit`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name, pool: "EXTERNAL", ttlMs: 2 * 3600_000 }),
      });
      if (res.status === 429) {
        const detail = (await res.json().catch(() => null)) as {
          reason?: string;
        } | null;
        throw new VortexError({
          code: "RATE_LIMITED",
          status: 503,
          message: `sandbox admission denied: ${detail?.reason ?? "account capacity"}`,
        });
      }
      if (!res.ok) {
        console.warn("sandbox admission endpoint failed-open", res.status);
      }
    } catch (err) {
      if (err instanceof VortexError) throw err;
      console.warn("sandbox admission unreachable — failing open", err);
    }
  }

  private async releaseAdmission(name: string): Promise<void> {
    const url = this.env?.CF_ADMISSION_URL;
    const token = this.env?.CF_ADMISSION_TOKEN;
    if (!url || !token) return;
    await fetch(`${url}/admin/sandbox/release`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name }),
    }).catch(() => {});
  }

  private sandbox(name: string): Promise<SandboxHandle> {
    return this.getHandle(name);
  }

  async createSandbox(opts: {
    name: string;
    sessionId: string;
    organizationId: string;
    agentLabel: string;
    env: Record<string, string>;
  }): Promise<ComputeSandbox> {
    await this.admit(opts.name);
    return {
      id: opts.name,
      name: opts.name,
      state: "started",
      organizationId: opts.organizationId,
      runnerEnv: opts.env,
    };
  }

  async findSandbox(
    sessionId: string,
    name: string,
    resultPath?: string
  ): Promise<ComputeSandbox | null> {
    const sandbox = await ioTimeout(this.sandbox(name), "sandbox handle");
    const proc = await ioTimeout(
      sandbox.getProcess(sessionId),
      "sandbox getProcess"
    ).catch(() => null);
    if (proc) return { id: name, name, state: "started" };
    // Process records can disappear after exit or a container sleep/restart.
    // The result file surviving is proof the sandbox (and its disk) is alive.
    if (
      resultPath &&
      (await this.readFile({ id: name, name, state: "started" }, resultPath))
    ) {
      return { id: name, name, state: "started" };
    }
    return null;
  }

  async startRunner(
    sandbox: ComputeSandbox,
    sessionId: string,
    command: string,
    env?: Record<string, string>
  ): Promise<void> {
    const handle = await ioTimeout(
      this.sandbox(sandbox.name),
      "sandbox handle"
    );
    await ioTimeout(
      handle.startProcess(command, {
        processId: sessionId,
        env: env ?? sandbox.runnerEnv,
        autoCleanup: false,
      }),
      "sandbox startProcess"
    );
  }

  async runnerBusy(
    sandbox: ComputeSandbox,
    sessionId: string
  ): Promise<boolean> {
    // Follow-up runs use `${sessionId}-fu` process ids — any live process
    // under the session prefix counts, not just the primary one.
    const handle = await ioTimeout(
      this.sandbox(sandbox.name),
      "sandbox handle"
    );
    const processes = await ioTimeout(
      handle.listProcesses(),
      "sandbox listProcesses"
    ).catch(() => []);
    for (const proc of processes) {
      if (!proc.id.startsWith(sessionId)) continue;
      const status = await ioTimeout(proc.getStatus(), "process status").catch(
        () => null
      );
      if (status === "starting" || status === "running") return true;
    }
    return false;
  }

  async runnerState(
    sandbox: ComputeSandbox,
    sessionId: string
  ): Promise<RunnerState> {
    const proc = await ioTimeout(
      (
        await ioTimeout(this.sandbox(sandbox.name), "sandbox handle")
      ).getProcess(sessionId),
      "sandbox getProcess"
    );
    // A missing record on a live sandbox means the runner exited (or its
    // record was lost to a container sleep) — let the result file decide.
    if (!proc) return { exitCode: 1 };
    const status = await ioTimeout(proc.getStatus(), "process status");
    if (status === "starting" || status === "running") return "running";
    return { exitCode: proc.exitCode ?? (status === "completed" ? 0 : 1) };
  }

  async readFile(
    sandbox: ComputeSandbox,
    path: string
  ): Promise<string | null> {
    try {
      const handle = await this.sandbox(sandbox.name);
      const res = await ioTimeout(handle.readFile(path), "sandbox readFile");
      return res.success && res.content ? res.content : null;
    } catch {
      return null;
    }
  }

  async writeFile(
    sandbox: ComputeSandbox,
    path: string,
    content: string
  ): Promise<void> {
    const res = await ioTimeout(
      (await ioTimeout(this.sandbox(sandbox.name), "sandbox handle")).writeFile(
        path,
        content
      ),
      "sandbox writeFile"
    );
    if (!res.success) {
      throw computeError(`Cloudflare writeFile failed: ${path}`);
    }
  }

  async runnerLogs(
    sandbox: ComputeSandbox,
    sessionId: string
  ): Promise<string | null> {
    try {
      const logs = await ioTimeout(
        (
          await ioTimeout(this.sandbox(sandbox.name), "sandbox handle")
        ).getProcessLogs(sessionId),
        "sandbox getProcessLogs"
      );
      const tail = `${logs.stdout}\n${logs.stderr}`.trim();
      return tail ? tail.slice(-4000) : null;
    } catch {
      return null;
    }
  }

  async waitForRunner(
    sandbox: ComputeSandbox,
    processId: string,
    timeoutMs: number
  ): Promise<void> {
    const handle = await ioTimeout(
      this.sandbox(sandbox.name),
      "sandbox handle"
    );
    // Process records take a beat to register after startProcess resolves —
    // poll until the runner's record exists, then wait on its health port.
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const proc = await handle.getProcess(processId);
      if (proc) {
        await ioTimeout(
          proc.waitForPort(8787, { timeout: deadline - Date.now() }),
          "runner waitForPort"
        );
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(`runner process ${processId} never registered`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async backupWorktree(sandbox: ComputeSandbox): Promise<string | null> {
    try {
      const handle = await ioTimeout(
        this.sandbox(sandbox.name),
        "sandbox handle"
      );
      // Backups only allow /workspace|/home|/tmp|/var/tmp|/app roots — the
      // lane worktree lives at $HOME/repo (/root, not allowed), so stage a
      // copy under /tmp first. Credentials stay in $HOME, outside the backup.
      await ioTimeout(
        handle.exec(
          "rm -rf /tmp/pile-worktree && mkdir -p /tmp/pile-worktree && cp -a /root/repo/. /tmp/pile-worktree/"
        ),
        "sandbox backup staging"
      );
      const backup = await ioTimeout(
        handle.createBackup({
          dir: "/tmp/pile-worktree",
          gitignore: true,
          excludes: ["node_modules", ".cache", "*.log"],
          name: `lane-${sandbox.name}`,
        }),
        "sandbox createBackup"
      );
      return JSON.stringify(backup);
    } catch {
      // A wedged or already-gone sandbox just means no backup — the caller
      // falls back to cold dispatch, same as before this existed.
      return null;
    }
  }

  async restoreWorktree(
    name: string,
    backupJson: string
  ): Promise<ComputeSandbox> {
    await this.admit(name);
    const handle = await ioTimeout(this.sandbox(name), "sandbox handle");
    await ioTimeout(
      handle.restoreBackup(JSON.parse(backupJson)),
      "sandbox restoreBackup"
    );
    // The backup restores into its staged /tmp path — land it at the lane's
    // real worktree so the follow-up runner sees the branch as it left it.
    await ioTimeout(
      handle.exec("mkdir -p /root && cp -a /tmp/pile-worktree /root/repo"),
      "sandbox restore copy"
    );
    return { id: name, name, state: "started" };
  }

  async mountCache(
    sandbox: ComputeSandbox,
    opts: { organizationId: string; repo: string; readOnly: boolean }
  ): Promise<string | null> {
    if (!this.env?.LANE_CACHE_BUCKET) return null;
    try {
      const handle = await ioTimeout(
        this.sandbox(sandbox.name),
        "sandbox handle"
      );
      // R2-binding mount: the Sandbox DO serves s3fs from the Worker binding,
      // so no bucket credential ever enters the container.
      const mount = () =>
        ioTimeout(
          handle.mountBucket("LANE_CACHE_BUCKET", LANE_CACHE_MOUNT, {
            prefix: laneCachePrefix(opts.organizationId, opts.repo),
            readOnly: opts.readOnly,
          }),
          "sandbox mountBucket"
        );
      try {
        await mount();
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("already in use"))) {
          throw err;
        }
        // A live sandbox keeps its provision-time mount. Reuse it, but a lane
        // whose permissions tightened since must not keep write access.
        if (opts.readOnly) {
          await ioTimeout(
            handle.unmountBucket(LANE_CACHE_MOUNT),
            "sandbox unmountBucket"
          );
          await mount();
        }
      }
      return LANE_CACHE_MOUNT;
    } catch (err) {
      console.warn("lane cache mount failed — using HTTP cache", err);
      return null;
    }
  }

  async previewUrl(
    sandbox: ComputeSandbox,
    port: number
  ): Promise<string | null> {
    try {
      const handle = await ioTimeout(
        this.sandbox(sandbox.name),
        "sandbox handle"
      );
      const info = await ioTimeout(
        handle.tunnels.get(port),
        "sandbox tunnel get"
      );
      return info.url;
    } catch {
      return null;
    }
  }

  async deleteSandbox(sandbox: ComputeSandbox): Promise<void> {
    try {
      await ioTimeout(
        (
          await ioTimeout(this.sandbox(sandbox.name), "sandbox handle")
        ).destroy(),
        "sandbox destroy"
      );
    } finally {
      await this.releaseAdmission(sandbox.name);
    }
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const SANDBOX_BINDING_BY_AGENT = {
  "cursor-cli": "SANDBOX_CURSOR",
  "devin-cli": "SANDBOX_DEVIN",
  "codex-cli": "SANDBOX_CODEX",
} as const;

export function computeBackend(env: AppEnv, agentId?: string): ComputeBackend {
  const provider = env.COMPUTE_PROVIDER ?? "daytona";
  if (provider === "cloudflare") {
    // Per-provider image/binding first; fall back to the shared SANDBOX
    // binding so single-image self-host setups keep working.
    const specific = agentId
      ? (
          SANDBOX_BINDING_BY_AGENT as Record<
            string,
            "SANDBOX_CURSOR" | "SANDBOX_DEVIN" | "SANDBOX_CODEX" | undefined
          >
        )[agentId]
      : undefined;
    const ns = (specific ? env[specific] : undefined) ?? env.SANDBOX;
    if (!ns) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message:
          "COMPUTE_PROVIDER=cloudflare requires a SANDBOX binding (or a per-provider SANDBOX_* binding)",
      });
    }
    return new CloudflareBackend(async (name) => {
      // Lazy: @cloudflare/sandbox pulls in cloudflare: specifiers that plain
      // Node (openapi/mcp generators) cannot resolve.
      const { getSandbox } = await import("@cloudflare/sandbox");
      return getSandbox(ns, name, {
        sleepAfter: CF_SLEEP_AFTER,
        normalizeId: true,
      });
    }, env);
  }
  const config = daytonaConfig(env);
  if (!config) {
    throw new VortexError({
      code: "CONFIG_ERROR",
      status: 500,
      message: "DAYTONA_API_KEY is not configured",
    });
  }
  return new DaytonaBackend(env, config);
}
