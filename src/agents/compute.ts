import type { Sandbox } from "@cloudflare/sandbox";
import { z } from "zod";

import { VortexError } from "../platform/errors.js";
import type { AppEnv } from "../types/env.js";
import {
  daytonaConfig,
  daytonaSandboxListSchema,
  daytonaSandboxSchema,
} from "./daytona.js";
import type { LaneSandboxBase } from "./lane-sandbox.js";

const DEFAULT_FALLBACK_TOOLBOX = "https://proxy.app.daytona.io/toolbox";
const POLL_INTERVAL_MS = 5000;
const MAX_START_POLLS = 60; // 5 minutes
const CF_SLEEP_AFTER = "4h"; // leak ceiling, above the runner's 2h timeout
// Bound every compute I/O call — a wedged sandbox or dead toolbox must fail
// fast, not hold the request/DO open indefinitely (PILE-217).
const IO_TIMEOUT_MS = 30_000;
// A sandbox create can legitimately run past the shared I/O bound while
// Daytona schedules and boots the VM — aborting at 30s kills healthy
// creates (PILE-466). The POST gets its own ceiling; every other call
// stays at 30s.
const CREATE_TIMEOUT_MS = 120_000;
// The toolbox can lag the sandbox's "started" state by a few seconds —
// right after start, the process-session create 400s with
// SANDBOX_NOT_RUNNING or an unresolvable container IP. Bound the retries
// so a real failure still fails fast.
const SESSION_CREATE_MAX_RETRIES = 3;

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

export interface SandboxFile {
  path: string;
  content: string;
  /** Octal permission bits applied after the write (e.g. 0o600 for the
   *  lane env file). */
  mode?: number;
}

/** Shell-sourceable env file: one `export K='v'` per entry. */
export function serializeLaneEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `export ${k}='${v.replaceAll("'", "'\\''")}'`)
    .join("\n");
}

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
  /** PILE-471 — list sandboxes by label prefix for the orphan sweep:
   *  sandboxes whose owning session is terminal get reaped. */
  listSandboxes?(
    labelPrefix: string
  ): Promise<Array<ComputeSandbox & { labels?: Record<string, string> }>>;
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
  getFile(sandbox: ComputeSandbox, path: string): Promise<string | null>;
  /** Write whole files into the sandbox over the backend's file API —
   *  content never traverses argv or env, so multi-hundred-KB payloads
   *  (prompts, the runner bundle) don't hit the execve per-string cap
   *  (PILE-595). */
  putFiles(sandbox: ComputeSandbox, files: SandboxFile[]): Promise<void>;
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
  /**
   * Persist the lane cache dir back so the next lane on the same org+repo
   * starts warm. Only meaningful on backends whose mountCache is a restore
   * (not a live mount) — 0.12's s3fs mount writes through and skips this.
   */
  saveCache?(
    sandbox: ComputeSandbox,
    opts: { organizationId: string; repo: string }
  ): Promise<void>;
  /** Public URL for a port on the sandbox — quick tunnel, lives as long as the container. */
  previewUrl?(sandbox: ComputeSandbox, port: number): Promise<string | null>;
  health(): Promise<{ ok: boolean; message?: string }>;
}

// PILE-452 — every failure the compute substrate returns is infra-class:
// sandbox create/provision/IP-resolution errors mean the provider fleet is
// saturated, not that the lane's task failed. The flag lets dispatchAgent
// mark infraFailure (the retry path + fleet breaker) without string
// matching — Daytona answers 400s to spawn failures, which the old
// status-only check (503/504) misclassified as task failures.
export class ComputeError extends VortexError {
  readonly infra = true;
}

/** True for compute-substrate failures, including RPC-serialized copies
 *  that lost the ComputeError prototype but kept its own properties. */
export function isComputeInfraError(error: unknown): boolean {
  if (error instanceof ComputeError) return true;
  return (
    error instanceof Error &&
    (error as { infra?: unknown }).infra === true &&
    (error as { code?: unknown }).code === "AGENT_ERROR"
  );
}

/** Coerce any provision-path throw into an infra-class error. Failures that
 *  never reached the backend — I/O timeouts, DNS ("failed to resolve
 *  container IP"), provision deadline rejects — arrive as plain Errors and
 *  would otherwise classify as task failures. */
export function asComputeInfraError(error: unknown): ComputeError {
  if (error instanceof ComputeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof VortexError ? error.status : 502;
  return new ComputeError({ code: "AGENT_ERROR", status, message });
}

// Daytona returns 400s for quota and concurrency rejections too — call them
// out so the session result says what actually blocked the spawn instead of
// a bare "400 <body>".
const DAYTONA_QUOTA_RE =
  /quota|concurr|capacity|rate.?limit|too many|limit exceeded|max.*sandboxes/i;

function daytonaFailure(what: string, status: number, body: string): string {
  if (status === 429 || DAYTONA_QUOTA_RE.test(body)) {
    return `${what}: Daytona quota/concurrency limit (status ${status}): ${body}`;
  }
  return `${what}: ${status} ${body}`;
}

function computeError(message: string, status = 502): ComputeError {
  return new ComputeError({ code: "AGENT_ERROR", status, message });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Daytona
// ---------------------------------------------------------------------------

export class DaytonaBackend implements ComputeBackend {
  readonly kind = "daytona" as const;

  constructor(
    private env: AppEnv,
    private config: { apiKey: string; apiUrl: string }
  ) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    // PILE-472 — one automatic retry on recoverable responses: 429 honors
    // the Retry-After header, 5xx a short backoff. Non-recoverable errors
    // (4xx) pass straight through to the caller's error handling.
    const doFetch = () =>
      fetch(`${this.config.apiUrl}${path}`, {
        signal: AbortSignal.timeout(IO_TIMEOUT_MS),
        ...init,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          ...init?.headers,
        },
      });
    try {
      let res = await doFetch();
      const recoverable = res.status === 429 || res.status >= 500;
      if (recoverable) {
        const retryAfter = res.headers.get("retry-after");
        const waitMs = retryAfter
          ? Math.min(Number(retryAfter) * 1000 || 2000, 15000)
          : 1500;
        await delay(waitMs);
        res = await doFetch();
      }
      return res;
    } catch (err) {
      throw computeError(
        `Daytona request failed (${path}): ${err instanceof Error ? err.message : String(err)}`,
        504
      );
    }
  }

  async createSandbox(opts: {
    name: string;
    sessionId: string;
    organizationId: string;
    agentLabel: string;
    env: Record<string, string>;
  }): Promise<ComputeSandbox> {
    const res = await this.request("/sandbox", {
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: opts.name,
        snapshot: this.env.DAYTONA_SNAPSHOT ?? "daytona-vm-small",
        // PILE-475 — warm pools only claim sandboxes with no custom env,
        // volumes, or secrets. Lane secrets ride /tmp/pile/lane.env via
        // putFiles instead, so omit the key entirely when the env is empty;
        // keeping DAYTONA_VOLUME_ID unset is the other eligibility gate.
        ...(Object.keys(opts.env).length > 0 ? { env: opts.env } : {}),
        labels: {
          "vortex.session": opts.sessionId,
          "vortex.org": opts.organizationId,
          "vortex.agent": opts.agentLabel,
        },
        autoStopInterval: 240, // leak ceiling: 4h, above the runner's 2h timeout
        // PILE-471 — a lane's whole lifetime is bounded: 3h wall clock, and
        // the sandbox deletes itself a day after it stops.
        ttlMinutes: 180,
        autoDeleteInterval: 1440,
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
      // PILE-472 — a create that failed on a transport timeout may have
      // actually landed server-side. Before surfacing the failure, adopt
      // the sandbox by name so a retried dispatch doesn't orphan it.
      const adopted = await this.findSandbox(opts.sessionId, opts.name).catch(
        () => null
      );
      if (adopted) return adopted;
      throw computeError(
        daytonaFailure("Daytona sandbox create failed", res.status, text)
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
        throw computeError(
          daytonaFailure("Daytona sandbox get failed", res.status, text)
        );
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
    // PILE-472 — the sandbox list paginates; a full fleet can push the
    // lane's sandbox off page one. Walk pages until it surfaces or runs out.
    let sandbox: z.infer<typeof daytonaSandboxSchema> | null = null;
    let page = 1;
    for (;;) {
      const res = await this.request(`/sandbox?page=${page}`);
      if (!res.ok) {
        const text = await res.text();
        throw computeError(
          daytonaFailure("Daytona sandbox list failed", res.status, text)
        );
      }
      const list = daytonaSandboxListSchema.parse(await res.json());
      const found = list.items.find(
        (s) => s.labels?.["vortex.session"] === sessionId || s.name === name
      );
      if (found) {
        sandbox = found;
        break;
      }
      if (list.items.length === 0 || page >= 10) break;
      page += 1;
    }
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

  async listSandboxes(
    labelPrefix: string
  ): Promise<Array<ComputeSandbox & { labels?: Record<string, string> }>> {
    // The list paginates (see findSandbox): orphans past page one would
    // never be swept otherwise. Same 10-page bound as findSandbox.
    const items: z.infer<typeof daytonaSandboxSchema>[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const res = await this.request(`/sandbox?page=${page}`);
      if (!res.ok) {
        const text = await res.text();
        throw computeError(
          `Daytona sandbox list failed: ${res.status} ${text}`
        );
      }
      const list = daytonaSandboxListSchema.parse(await res.json());
      items.push(...list.items);
      if (list.items.length === 0) break;
    }
    return items
      .filter((s) =>
        Object.keys(s.labels ?? {}).some((k) => k.startsWith(labelPrefix))
      )
      .map((s) => ({
        id: s.id,
        name: s.name,
        state: s.state,
        organizationId: s.labels?.["vortex.org"],
        error: s.error ?? null,
        toolboxProxyUrl: s.toolboxProxyUrl,
        labels: s.labels ?? {},
      }));
  }

  private toolbox(sandbox: ComputeSandbox) {
    return `${sandbox.toolboxProxyUrl ?? DEFAULT_FALLBACK_TOOLBOX}/${sandbox.id}`;
  }

  /** Toolbox calls bypass `request` (different host); the same I/O bound +
   *  infra classification applies — a dead toolbox or unresolvable sandbox
   *  IP is a substrate failure, not a task failure. */
  private async toolboxFetch(
    url: string,
    init?: RequestInit
  ): Promise<Response> {
    try {
      return await fetch(url, {
        signal: AbortSignal.timeout(IO_TIMEOUT_MS),
        ...init,
        headers: {
          // FormData bodies carry their own multipart boundary — forcing a
          // JSON content type would corrupt the upload.
          ...(init?.body instanceof FormData
            ? {}
            : { "Content-Type": "application/json" }),
          Authorization: `Bearer ${this.config.apiKey}`,
          ...init?.headers,
        },
      });
    } catch (err) {
      throw computeError(
        `Daytona toolbox request failed: ${err instanceof Error ? err.message : String(err)}`,
        504
      );
    }
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
      await this.putFiles(sandbox, [
        { path: envPath, content: serializeLaneEnv(env) },
      ]);
      command = `set -a && . ${envPath} && set +a && rm -f ${envPath}; ${command}`;
    }
    for (let i = 0; i <= SESSION_CREATE_MAX_RETRIES; i++) {
      if (i > 0) await delay(2_000 * 2 ** (i - 1)); // 2s, 4s, 8s
      const createRes = await this.toolboxFetch(`${base}/process/session`, {
        method: "POST",
        body: JSON.stringify({ sessionId }),
      });
      if (createRes.ok || createRes.status === 409) break;
      const text = await createRes.text();
      const retryable =
        createRes.status === 400 &&
        (text.includes("SANDBOX_NOT_RUNNING") ||
          text.includes("failed to resolve container IP"));
      if (!retryable || i === SESSION_CREATE_MAX_RETRIES) {
        throw computeError(
          daytonaFailure(
            "Daytona process session create failed",
            createRes.status,
            text
          )
        );
      }
    }
    const execRes = await this.toolboxFetch(
      `${base}/process/session/${sessionId}/exec`,
      {
        method: "POST",
        body: JSON.stringify({ command, runAsync: true }),
      }
    );
    if (!execRes.ok) {
      const text = await execRes.text();
      throw computeError(
        daytonaFailure("Daytona process exec failed", execRes.status, text)
      );
    }
  }

  async runnerState(
    sandbox: ComputeSandbox,
    sessionId: string
  ): Promise<RunnerState> {
    const base = this.toolbox(sandbox);
    const res = await this.toolboxFetch(`${base}/process/session/${sessionId}`);
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

  async getFile(sandbox: ComputeSandbox, path: string): Promise<string | null> {
    const base = this.toolbox(sandbox);
    const res = await this.toolboxFetch(`${base}/process/execute`, {
      method: "POST",
      body: JSON.stringify({ command: `cat ${path}`, cwd: "/" }),
    });
    if (!res.ok) return null;
    const data = daytonaSyncExecSchema.parse(await res.json());
    if (data.exitCode !== 0 || !data.result) return null;
    return data.result;
  }

  private async uploadFile(
    sandbox: ComputeSandbox,
    file: SandboxFile
  ): Promise<void> {
    const base = this.toolbox(sandbox);
    const res = await this.toolboxFetch(
      `${base}/files/upload-v2?path=${encodeURIComponent(file.path)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file.content,
      }
    );
    if (res.ok) return;
    if (res.status === 404) {
      // Older toolbox images lack upload-v2 — the legacy endpoint takes a
      // multipart `file` part instead of a raw body.
      const form = new FormData();
      form.set("file", new Blob([file.content]), "file");
      const legacy = await this.toolboxFetch(
        `${base}/files/upload?path=${encodeURIComponent(file.path)}`,
        { method: "POST", body: form }
      );
      if (legacy.ok) return;
      const legacyText = await legacy.text();
      throw computeError(
        daytonaFailure(
          `Daytona file upload ${file.path} failed`,
          legacy.status,
          legacyText
        )
      );
    }
    const text = await res.text();
    throw computeError(
      daytonaFailure(
        `Daytona file upload ${file.path} failed`,
        res.status,
        text
      )
    );
  }

  async putFiles(sandbox: ComputeSandbox, files: SandboxFile[]): Promise<void> {
    const base = this.toolbox(sandbox);
    for (const file of files) {
      await this.uploadFile(sandbox, file);
      if (file.mode === undefined) continue;
      const res = await this.toolboxFetch(`${base}/process/execute`, {
        method: "POST",
        body: JSON.stringify({
          command: `chmod ${file.mode.toString(8)} ${file.path}`,
          cwd: "/",
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw computeError(
          `Daytona chmod ${file.path} failed: ${res.status} ${text}`
        );
      }
      const data = daytonaSyncExecSchema.parse(await res.json());
      if (data.exitCode !== 0) {
        throw computeError(
          `Daytona chmod ${file.path} exited ${data.exitCode}: ${data.result ?? ""}`
        );
      }
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
        daytonaFailure("Daytona sandbox delete failed", res.status, text)
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

async function cfAdmit(env: AppEnv | undefined, name: string): Promise<void> {
  const url = env?.CF_ADMISSION_URL;
  const token = env?.CF_ADMISSION_TOKEN;
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

async function cfReleaseAdmission(
  env: AppEnv | undefined,
  name: string
): Promise<void> {
  const url = env?.CF_ADMISSION_URL;
  const token = env?.CF_ADMISSION_TOKEN;
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
    return cfAdmit(this.env, name);
  }

  private async releaseAdmission(name: string): Promise<void> {
    return cfReleaseAdmission(this.env, name);
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
      (await this.getFile({ id: name, name, state: "started" }, resultPath))
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

  async getFile(sandbox: ComputeSandbox, path: string): Promise<string | null> {
    try {
      const handle = await this.sandbox(sandbox.name);
      const res = await ioTimeout(handle.readFile(path), "sandbox readFile");
      return res.success && res.content ? res.content : null;
    } catch {
      return null;
    }
  }

  async putFiles(sandbox: ComputeSandbox, files: SandboxFile[]): Promise<void> {
    const handle = await ioTimeout(
      this.sandbox(sandbox.name),
      "sandbox handle"
    );
    for (const file of files) {
      const res = await ioTimeout(
        handle.writeFile(file.path, file.content),
        "sandbox writeFile"
      );
      if (!res.success) {
        throw computeError(`Cloudflare writeFile failed: ${file.path}`);
      }
      if (file.mode !== undefined) {
        await ioTimeout(
          handle.exec(`chmod ${file.mode.toString(8)} ${file.path}`),
          "sandbox chmod"
        );
      }
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

/**
 * sandbox-sdk 1.0 backend (PILE-473/474): the lane sandbox is a DO with RPC
 * methods (`LaneSandboxBase`) instead of the 0.12 `getSandbox` handle, so
 * this backend talks to `SANDBOX_LANE*` bindings directly. Selected per
 * deployment via `LANE_SDK=v1`; the 0.12 classes and bindings stay live for
 * rollback. Lane cache mounts and worktree backups aren't wired yet — lanes
 * on v1 fall back to the HTTP pnpm-store cache and cold continuation.
 */
export class LaneSandboxBackend implements ComputeBackend {
  readonly kind = "cloudflare" as const;

  constructor(
    private ns: DurableObjectNamespace<LaneSandboxBase>,
    private env?: AppEnv
  ) {}

  private stub(name: string): DurableObjectStub<LaneSandboxBase> {
    return this.ns.getByName(name);
  }

  async createSandbox(opts: {
    name: string;
    sessionId: string;
    organizationId: string;
    agentLabel: string;
    env: Record<string, string>;
  }): Promise<ComputeSandbox> {
    await cfAdmit(this.env, opts.name);
    await ioTimeout(this.stub(opts.name).provision(), "lane provision");
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
    const stub = this.stub(name);
    if (await ioTimeout(stub.hasProcess(sessionId), "sandbox hasProcess")) {
      return { id: name, name, state: "started" };
    }
    if (
      resultPath &&
      (await this.getFile({ id: name, name, state: "started" }, resultPath))
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
    await ioTimeout(
      this.stub(sandbox.name).spawn({
        processId: sessionId,
        command,
        env: env ?? sandbox.runnerEnv,
      }),
      "lane spawn"
    );
  }

  async runnerBusy(
    sandbox: ComputeSandbox,
    sessionId: string
  ): Promise<boolean> {
    return ioTimeout(
      this.stub(sandbox.name).sessionBusy(sessionId),
      "lane sessionBusy"
    ).catch(() => false);
  }

  async runnerState(
    sandbox: ComputeSandbox,
    sessionId: string
  ): Promise<RunnerState> {
    const state = await ioTimeout(
      this.stub(sandbox.name).processState(sessionId),
      "lane processState"
    );
    return state.running ? "running" : { exitCode: state.exitCode ?? 1 };
  }

  async getFile(sandbox: ComputeSandbox, path: string): Promise<string | null> {
    return ioTimeout(
      this.stub(sandbox.name).readFile(path),
      "lane readFile"
    ).catch(() => null);
  }

  async putFiles(sandbox: ComputeSandbox, files: SandboxFile[]): Promise<void> {
    await ioTimeout(this.stub(sandbox.name).putFiles(files), "lane putFiles");
  }

  async runnerLogs(
    sandbox: ComputeSandbox,
    sessionId: string
  ): Promise<string | null> {
    const id = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
    return ioTimeout(
      this.stub(sandbox.name).tail(`/tmp/pile/proc/${id}.log`),
      "lane runner log tail"
    ).catch(() => null);
  }

  async waitForRunner(
    sandbox: ComputeSandbox,
    processId: string,
    timeoutMs: number
  ): Promise<void> {
    const stub = this.stub(sandbox.name);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await ioTimeout(stub.probe(8787), "runner probe")) return;
      if (Date.now() >= deadline) {
        throw new Error(`runner process ${processId} never registered`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  async deleteSandbox(sandbox: ComputeSandbox): Promise<void> {
    try {
      await ioTimeout(this.stub(sandbox.name).destroy(), "lane destroy");
    } finally {
      await cfReleaseAdmission(this.env, sandbox.name);
    }
  }

  // v1 parity (LANE_CACHE_BUCKET + DirectoryBackup): mountCache restores the
  // shared cache into the lane; saveCache persists it for the next lane on
  // the same org+repo. backupWorktree/restoreWorktree mirror the Daytona
  // shape — stage under /tmp, DirectoryBackup of the staged dir.
  async mountCache(
    sandbox: ComputeSandbox,
    opts: { organizationId: string; repo: string; readOnly: boolean }
  ): Promise<string | null> {
    if (!this.env?.LANE_CACHE_BUCKET) return null;
    return ioTimeout(
      this.stub(sandbox.name).restoreCache(
        laneCachePrefix(opts.organizationId, opts.repo),
        LANE_CACHE_MOUNT
      ),
      "lane restoreCache"
    ).catch(() => null);
  }

  async saveCache(
    sandbox: ComputeSandbox,
    opts: { organizationId: string; repo: string }
  ): Promise<void> {
    if (!this.env?.LANE_CACHE_BUCKET) return;
    await ioTimeout(
      this.stub(sandbox.name).saveCache(
        laneCachePrefix(opts.organizationId, opts.repo),
        LANE_CACHE_MOUNT
      ),
      "lane saveCache"
    ).catch(() => undefined);
  }

  async backupWorktree(sandbox: ComputeSandbox): Promise<string | null> {
    return ioTimeout(
      this.stub(sandbox.name).backupWorktreeDir(),
      "lane backupWorktree"
    ).catch(() => null);
  }

  async restoreWorktree(
    name: string,
    backupJson: string
  ): Promise<ComputeSandbox> {
    await cfAdmit(this.env, name);
    await ioTimeout(this.stub(name).provision(), "lane provision");
    await ioTimeout(
      this.stub(name).restoreWorktreeDir(backupJson),
      "lane restoreWorktree"
    );
    return { id: name, name, state: "started" };
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true, message: "provider=cloudflare sdk=v1" };
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

const LANE_V1_BINDING_BY_AGENT = {
  "cursor-cli": "SANDBOX_LANE_CURSOR",
  "devin-cli": "SANDBOX_LANE_DEVIN",
  "codex-cli": "SANDBOX_LANE_CODEX",
} as const;

// PILE-473/474 — wraps a primary backend and, on an infra-class create
// failure (Daytona down, env-size cap, pool wedge), retries once on the
// fallback. Only createSandbox swaps backends: a live sandbox can't be
// transplanted mid-session, so post-create calls stick with whoever
// spawned it.
export class FailoverBackend implements ComputeBackend {
  get kind(): ComputeBackend["kind"] {
    return this.switched ? this.fallback.kind : this.primary.kind;
  }
  private switched = false;

  constructor(
    private primary: ComputeBackend,
    private fallback: ComputeBackend
  ) {}

  private pick(): ComputeBackend {
    return this.switched ? this.fallback : this.primary;
  }

  async createSandbox(opts: Parameters<ComputeBackend["createSandbox"]>[0]) {
    if (this.switched) return this.fallback.createSandbox(opts);
    try {
      return await this.primary.createSandbox(opts);
    } catch (error) {
      // Config errors are deterministic — retrying on another substrate
      // won't fix a missing credential.
      if (error instanceof VortexError && error.code === "CONFIG_ERROR") {
        throw error;
      }
      this.switched = true;
      console.error(
        `[pile] compute failover: ${this.primary.kind} create failed — ` +
          `retrying on ${this.fallback.kind}`,
        error instanceof Error ? error.message : error
      );
      return this.fallback.createSandbox(opts);
    }
  }

  async findSandbox(
    ...a: Parameters<ComputeBackend["findSandbox"]>[0] extends never
      ? never
      : [string, string, string?]
  ): Promise<ComputeSandbox | null> {
    if (this.switched) {
      try {
        return await this.fallback.findSandbox(...a);
      } catch (err) {
        console.warn(
          "[pile] compute failover: fallback findSandbox failed",
          err
        );
        return null;
      }
    }
    let primaryErr: unknown;
    try {
      const found = await this.primary.findSandbox(...a);
      if (found) return found;
    } catch (err) {
      primaryErr = err;
    }
    try {
      const fallbackFound = await this.fallback.findSandbox(...a);
      if (fallbackFound) {
        this.switched = true;
        return fallbackFound;
      }
      return null;
    } catch (fallbackErr) {
      console.warn(
        "[pile] compute failover: fallback findSandbox probe failed",
        fallbackErr
      );
      if (primaryErr !== undefined) throw primaryErr;
      return null;
    }
  }
  startRunner(...a: [ComputeSandbox, string, string, Record<string, string>?]) {
    return this.pick().startRunner(...a);
  }
  runnerBusy(...a: [ComputeSandbox, string]) {
    return this.pick().runnerBusy?.(...a) ?? Promise.resolve(false);
  }
  runnerState(...a: [ComputeSandbox, string]) {
    return this.pick().runnerState(...a);
  }
  getFile(...a: [ComputeSandbox, string]) {
    return this.pick().getFile(...a);
  }
  putFiles(...a: [ComputeSandbox, SandboxFile[]]) {
    return this.pick().putFiles(...a);
  }
  runnerLogs(...a: [ComputeSandbox, string]) {
    return this.pick().runnerLogs?.(...a) ?? Promise.resolve(null);
  }
  waitForRunner(...a: [ComputeSandbox, string, number]) {
    return this.pick().waitForRunner?.(...a) ?? Promise.resolve();
  }
  deleteSandbox(...a: [ComputeSandbox]) {
    return this.pick().deleteSandbox?.(...a) ?? Promise.resolve();
  }
  backupWorktree(...a: [ComputeSandbox]) {
    return this.pick().backupWorktree?.(...a) ?? Promise.resolve(null);
  }
  restoreWorktree(...a: [string, string]) {
    return (
      this.pick().restoreWorktree?.(...a) ??
      Promise.reject(new Error("no restoreWorktree"))
    );
  }
  mountCache(
    ...a: [
      ComputeSandbox,
      { organizationId: string; repo: string; readOnly: boolean },
    ]
  ) {
    return this.pick().mountCache?.(...a) ?? Promise.resolve(null);
  }
  saveCache(...a: [ComputeSandbox, { organizationId: string; repo: string }]) {
    return this.pick().saveCache?.(...a) ?? Promise.resolve();
  }
  previewUrl(...a: [ComputeSandbox, number]) {
    return this.pick().previewUrl?.(...a) ?? Promise.resolve(null);
  }
  listSandboxes(...a: [string]) {
    return this.pick().listSandboxes?.(...a) ?? Promise.resolve([]);
  }
  health() {
    return this.pick().health();
  }
}

/** Narrow a session row's `compute_backend` column (TEXT, nullable) to the
 *  pin `computeBackend` accepts — anything unexpected falls back to the
 *  live flag rather than pinning a lane to garbage. */
export function toComputePin(
  value: string | null | undefined
): ComputeBackend["kind"] | undefined {
  return value === "daytona" || value === "cloudflare" ? value : undefined;
}

function resolveLaneV1Binding(env: AppEnv, agentId?: string) {
  const specific = agentId
    ? (
        LANE_V1_BINDING_BY_AGENT as Record<
          string,
          | "SANDBOX_LANE_CURSOR"
          | "SANDBOX_LANE_DEVIN"
          | "SANDBOX_LANE_CODEX"
          | undefined
        >
      )[agentId]
    : undefined;
  return (specific ? env[specific] : undefined) ?? env.SANDBOX_LANE;
}

export function computeBackend(
  env: AppEnv,
  agentId?: string,
  /** PILE-474 — the backend pinned on the session row at start(); a
   *  COMPUTE_PROVIDER flip mid-flight must not retarget in-flight lanes. */
  pinned?: ComputeBackend["kind"]
): ComputeBackend {
  const provider = pinned ?? env.COMPUTE_PROVIDER ?? "daytona";
  if (provider === "cloudflare") {
    // sandbox-sdk 1.0 lanes (PILE-473/474 / VTX-602): LANE_SDK=v1 routes
    // through the LaneSandbox DOs on SANDBOX_LANE* bindings, with optional
    // bidirectional failover to Daytona when LANE_FAILOVER=v1 and
    // DAYTONA_API_KEY is configured.
    if (env.LANE_SDK === "v1") {
      const ns = resolveLaneV1Binding(env, agentId);
      if (!ns) {
        throw new VortexError({
          code: "CONFIG_ERROR",
          status: 500,
          message:
            "LANE_SDK=v1 requires a SANDBOX_LANE binding (or a per-provider SANDBOX_LANE_* binding)",
        });
      }
      const laneV1 = new LaneSandboxBackend(ns, env);
      if (env.LANE_FAILOVER === "v1") {
        const dConfig = daytonaConfig(env);
        if (dConfig) {
          return new FailoverBackend(laneV1, new DaytonaBackend(env, dConfig));
        }
      }
      return laneV1;
    }
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
  const daytona = new DaytonaBackend(env, config);
  // LANE_FAILOVER=v1 wraps Daytona with a lane-pool fallback: an infra-class
  // create failure (Daytona down, payload cap, wedge) retries once on the
  // v1 LaneSandbox backend instead of killing the lane (PILE-473/474).
  if (env.LANE_FAILOVER === "v1") {
    const specific = agentId
      ? (
          LANE_V1_BINDING_BY_AGENT as Record<
            string,
            | "SANDBOX_LANE_CURSOR"
            | "SANDBOX_LANE_DEVIN"
            | "SANDBOX_LANE_CODEX"
            | undefined
          >
        )[agentId]
      : undefined;
    const ns = (specific ? env[specific] : undefined) ?? env.SANDBOX_LANE;
    if (ns) {
      return new FailoverBackend(daytona, new LaneSandboxBackend(ns, env));
    }
  }
  return daytona;
}

/** PILE-471 — label-based orphan sweep: `vortex.*`-labeled sandboxes owned
 *  by `opts.organizationId` whose session row is terminal or missing get
 *  deleted. The sweep runs per workspace DO while the Daytona account is
 *  shared, so candidates are scoped by the `vortex.org` label — a foreign
 *  org's sandbox would read as a missing session here and get deleted
 *  mid-run otherwise. Sandboxes carrying no org label only reap when the
 *  session row itself resolves in this DO (UUIDs are unforgeable
 *  attribution); `ttlMinutes` on create is the backstop for the rest.
 *
 *  `opts.keepTerminalMs` mirrors the kept-sandbox resume window: terminal
 *  sessions younger than it keep their parked sandbox for follow-up
 *  resumes, so the sweep leaves those to the kept-cap reaper. */
export async function sweepOrphanSandboxes(
  backend: ComputeBackend,
  stub: {
    getAgentSession(id: string): Promise<
      | {
          status: string;
          endedAt?: string | null;
          updatedAt?: string | null;
        }
      | null
      | undefined
    >;
  },
  opts: { organizationId: string; limit?: number; keepTerminalMs?: number }
): Promise<{ reaped: number; checked: number }> {
  if (!backend.listSandboxes) return { reaped: 0, checked: 0 };
  const sandboxes = await backend.listSandboxes("vortex.");
  const TERMINAL = new Set(["completed", "failed", "canceled"]);
  // Filter before the limit so unlabeled or foreign-org sandboxes don't
  // consume the check budget.
  const candidates = sandboxes.filter(
    (s) =>
      s.labels?.["vortex.session"] &&
      (!s.organizationId || s.organizationId === opts.organizationId)
  );
  let reaped = 0;
  let checked = 0;
  for (const s of candidates.slice(0, opts.limit ?? 50)) {
    const sessionId = s.labels?.["vortex.session"];
    if (!sessionId) continue;
    checked += 1;
    let session:
      | { status: string; endedAt?: string | null; updatedAt?: string | null }
      | null
      | undefined;
    try {
      session = await stub.getAgentSession(sessionId);
    } catch {
      // Lookup failure ≠ missing session — a transient DO error must not
      // read as an orphan and delete a live sandbox.
      continue;
    }
    if (session && !TERMINAL.has(session.status)) continue;
    if (session && opts.keepTerminalMs) {
      const anchor = Date.parse(session.endedAt ?? session.updatedAt ?? "");
      if (
        !Number.isFinite(anchor) ||
        Date.now() - anchor < opts.keepTerminalMs
      ) {
        continue;
      }
    }
    // A missing row is an orphan only when the org label already scoped the
    // sandbox to this workspace; unlabeled sandboxes could belong anywhere.
    if (!session && !s.organizationId) continue;
    try {
      await backend.deleteSandbox(s);
      reaped += 1;
    } catch (err) {
      console.warn("orphan sandbox delete failed", s.id, err);
    }
  }
  return { reaped, checked };
}
