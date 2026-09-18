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
  findSandbox(sessionId: string, name: string): Promise<ComputeSandbox | null>;
  startRunner(
    sandbox: ComputeSandbox,
    sessionId: string,
    command: string
  ): Promise<void>;
  runnerState(sandbox: ComputeSandbox, sessionId: string): Promise<RunnerState>;
  readFile(sandbox: ComputeSandbox, path: string): Promise<string | null>;
  deleteSandbox(sandbox: ComputeSandbox): Promise<void>;
  health(): Promise<{ ok: boolean; message?: string }>;
}

function computeError(message: string, status = 502): VortexError {
  return new VortexError({ code: "AGENT_ERROR", status, message });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  private async waitForStarted(sandboxId: string): Promise<ComputeSandbox> {
    const poll = async (i: number): Promise<ComputeSandbox> => {
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
    command: string
  ): Promise<void> {
    const base = this.toolbox(sandbox);
    const createRes = await fetch(`${base}/process/session`, {
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
  "getProcess" | "startProcess" | "readFile" | "destroy"
>;

export class CloudflareBackend implements ComputeBackend {
  readonly kind = "cloudflare" as const;

  constructor(private getHandle: (name: string) => Promise<SandboxHandle>) {}

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
    name: string
  ): Promise<ComputeSandbox | null> {
    const sandbox = await this.sandbox(name);
    const proc = await sandbox.getProcess(sessionId).catch(() => null);
    if (!proc) return null;
    return { id: name, name, state: "started" };
  }

  async startRunner(
    sandbox: ComputeSandbox,
    sessionId: string,
    command: string
  ): Promise<void> {
    await (
      await this.sandbox(sandbox.name)
    ).startProcess(command, {
      processId: sessionId,
      env: sandbox.runnerEnv,
      autoCleanup: false,
    });
  }

  async runnerState(
    sandbox: ComputeSandbox,
    sessionId: string
  ): Promise<RunnerState> {
    const proc = await (await this.sandbox(sandbox.name)).getProcess(sessionId);
    if (!proc) return "pending";
    const status = await proc.getStatus();
    if (status === "starting" || status === "running") return "running";
    return { exitCode: proc.exitCode ?? (status === "completed" ? 0 : 1) };
  }

  async readFile(
    sandbox: ComputeSandbox,
    path: string
  ): Promise<string | null> {
    try {
      const res = await (await this.sandbox(sandbox.name)).readFile(path);
      return res.success && res.content ? res.content : null;
    } catch {
      return null;
    }
  }

  async deleteSandbox(sandbox: ComputeSandbox): Promise<void> {
    await (await this.sandbox(sandbox.name)).destroy();
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function computeBackend(env: AppEnv): ComputeBackend {
  const provider = env.COMPUTE_PROVIDER ?? "daytona";
  if (provider === "cloudflare") {
    if (!env.SANDBOX) {
      throw new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "COMPUTE_PROVIDER=cloudflare requires a SANDBOX binding",
      });
    }
    const ns = env.SANDBOX;
    return new CloudflareBackend(async (name) => {
      // Lazy: @cloudflare/sandbox pulls in cloudflare: specifiers that plain
      // Node (openapi/mcp generators) cannot resolve.
      const { getSandbox } = await import("@cloudflare/sandbox");
      return getSandbox(ns, name, {
        sleepAfter: CF_SLEEP_AFTER,
        normalizeId: true,
      });
    });
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
