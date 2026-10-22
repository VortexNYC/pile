// LaneSandbox — the lane compute pool on sandbox-sdk 1.0. Each DO starts its
// own container (scheduling_policy: "durable_object") and the worker reaches
// it by RPC, replacing the 0.12 `getSandbox` handle (PILE-473/474 prep).
//
// Why pidfiles + exit sentinels and not the shim's process handles: a lane's
// runner outlives any single DO isolate lifetime, and the truth of "did the
// run finish" already lives in the result file the runner writes — the
// sentinel only needs to answer "is the wrapper still alive".
import { DurableObject } from "cloudflare:workers";
import { DirectoryBackup, Files, type DirectoryBackupRecord } from "sandbox-1";

import type { AppEnv } from "../types/env.js";
import type { SandboxFile } from "./compute.js";

// Lane runners self-bound at 2h; the container-side backstop stops a lane
// whose runner dies without the worker noticing.
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

const PROC_DIR = "/tmp/pile/proc";

const decode = (b: ArrayBuffer | string): string =>
  typeof b === "string" ? b : new TextDecoder().decode(b);

// exec() processes do not see Dockerfile ENV on 1.0 — PATH/HOME ship on
// every exec call.
const BASE_ENV: Record<string, string> = {
  PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/root/.local/bin",
  HOME: "/root",
};

export type LaneSpawn = {
  processId: string;
  command: string;
  env?: Record<string, string>;
};

export type LaneProcessState = { running: boolean; exitCode: number | null };

export class LaneSandboxBase extends DurableObject<AppEnv> {
  private readonly container: NonNullable<DurableObjectState["container"]>;
  private readonly files: Files;
  private readonly backups: DirectoryBackup;
  private setup: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    const container = ctx.container;
    if (!container) {
      throw new Error("LaneSandbox: container binding is not configured");
    }
    this.container = container;
    this.files = new Files(container);
    this.backups = new DirectoryBackup(
      container,
      ctx.exports.DirectoryBackupGateway,
      { binding: "LANE_CACHE_BUCKET" }
    );
    if (container.running) {
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS)
      );
    }
  }

  private async ensureRunning(): Promise<void> {
    if (this.setup !== null && this.container.running) {
      return this.setup;
    }
    this.setup = (async () => {
      if (!this.container.running) {
        await this.container.start();
      }
      await this.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    })().catch((error: unknown) => {
      this.setup = null;
      throw error;
    });
    return this.setup;
  }

  /** Provision the container. Idempotent. */
  async provision(): Promise<void> {
    await this.ensureRunning();
  }

  /**
   * Detached spawn, durable across DO restarts: a wrapper script records the
   * command's exit code to a sentinel the worker polls via `processState`.
   * `command` goes through base64 so quoting can't corrupt it.
   */
  async spawn(opts: LaneSpawn): Promise<void> {
    await this.ensureRunning();
    const id = opts.processId.replace(/[^A-Za-z0-9._-]/g, "_");
    const script = [
      "#!/bin/sh",
      `. ${"/tmp/pile/lane.env"} 2>/dev/null || true`,
      `cd ${opts.env?.WORKDIR ?? "/"} 2>/dev/null || true`,
      opts.command,
      `echo $? > ${PROC_DIR}/${id}.exit`,
      "",
    ].join("\n");
    // PROC_DIR must exist before writeFile — the Files API doesn't create
    // parents, so the first spawn on a fresh container fails otherwise.
    await this.container.exec(["mkdir", "-p", PROC_DIR], { env: BASE_ENV });
    await this.files.writeFile(`${PROC_DIR}/${id}.sh`, script);
    const res = await this.container.exec(
      [
        "sh",
        "-c",
        `mkdir -p ${PROC_DIR} && chmod +x ${PROC_DIR}/${id}.sh && ` +
          `nohup ${PROC_DIR}/${id}.sh > ${PROC_DIR}/${id}.log 2>&1 & ` +
          `echo $! > ${PROC_DIR}/${id}.pid`,
      ],
      { env: { ...BASE_ENV, ...opts.env } }
    );
    const out = await res.output();
    if (out.exitCode !== 0) {
      throw new Error(
        `LaneSandbox spawn failed (${out.exitCode}): ${decode(out.stderr)}`
      );
    }
  }

  /** running flag, or the exit code recorded by the spawn wrapper. */
  async processState(processId: string): Promise<LaneProcessState> {
    const id = processId.replace(/[^A-Za-z0-9._-]/g, "_");
    const exit = await this.files
      .readFile(`${PROC_DIR}/${id}.exit`)
      .then((f) => f?.text())
      .catch(() => null);
    if (exit !== null && exit !== undefined) {
      const code = Number.parseInt(exit.trim(), 10);
      return { running: false, exitCode: Number.isNaN(code) ? 1 : code };
    }
    const pid = await this.files
      .readFile(`${PROC_DIR}/${id}.pid`)
      .then((f) => f?.text())
      .catch(() => null);
    if (!pid) return { running: false, exitCode: 1 }; // never spawned here
    const res = await this.container.exec(
      ["sh", "-c", `kill -0 ${pid.trim()}`],
      {
        env: BASE_ENV,
      }
    );
    const out = await res.output();
    return out.exitCode === 0
      ? { running: true, exitCode: null }
      : { running: false, exitCode: 1 };
  }

  /** Whether a spawn for this id left a pid file — existence, not liveness. */
  async hasProcess(processId: string): Promise<boolean> {
    const id = processId.replace(/[^A-Za-z0-9._-]/g, "_");
    const res = await this.container.exec(
      ["sh", "-c", `test -f ${PROC_DIR}/${id}.pid`],
      { env: BASE_ENV }
    );
    return (await res.output()).exitCode === 0;
  }

  /** HTTP readiness probe inside the container — runner health on :port. */
  async probe(port: number): Promise<boolean> {
    const res = await this.container.exec(
      ["sh", "-c", `curl -sf -o /dev/null http://127.0.0.1:${port}/`],
      { env: BASE_ENV }
    );
    return (await res.output()).exitCode === 0;
  }

  /** Any live process under a session prefix (follow-ups share it). */
  async sessionBusy(sessionId: string): Promise<boolean> {
    const res = await this.container.exec(
      ["sh", "-c", `ls ${PROC_DIR}/${sessionId}*.pid 2>/dev/null`],
      { env: BASE_ENV }
    );
    const out = await res.output();
    if (out.exitCode !== 0) return false;
    for (const line of decode(out.stdout).split("\n")) {
      const name = line.trim();
      if (!name.endsWith(".pid")) continue;
      const state = await this.processState(
        name.slice(PROC_DIR.length + 1, -".pid".length)
      );
      if (state.running) return true;
    }
    return false;
  }

  async readFile(path: string): Promise<string | null> {
    try {
      const f = await this.files.readFile(path);
      return (await f?.text()) ?? null;
    } catch {
      return null;
    }
  }

  async putFiles(files: SandboxFile[]): Promise<void> {
    await this.ensureRunning();
    for (const file of files) {
      await this.files.writeFile(file.path, file.content);
      if (file.mode !== undefined) {
        await this.container.exec(["chmod", file.mode.toString(8), file.path], {
          env: BASE_ENV,
        });
      }
    }
  }

  /** Last `bytes` of a file — transcript/log tails without a full read. */
  async tail(path: string, bytes = 4000): Promise<string | null> {
    const res = await this.container.exec(
      ["sh", "-c", `tail -c ${bytes} ${path} 2>/dev/null`],
      { env: BASE_ENV }
    );
    const out = await res.output();
    if (out.exitCode !== 0) return null;
    return decode(out.stdout) || null;
  }

  async destroy(): Promise<void> {
    if (this.container.running) {
      await this.container.destroy();
    }
  }

  // --- v1 parity: cache + worktree backups ride LANE_CACHE_BUCKET via
  // DirectoryBackup, the same mechanism the checks pool uses — no S3
  // credentials enter the container.

  /** Restore the shared lane cache into `dir`; no-op when nothing is stored. */
  async restoreCache(prefix: string, dir: string): Promise<string | null> {
    await this.ensureRunning();
    const object = await this.env.LANE_CACHE_BUCKET?.get(
      `cache-idx/${prefix}latest.json`
    );
    if (!object) return null;
    const record = (await object.json()) as DirectoryBackupRecord;
    await this.container.exec(["mkdir", "-p", dir], { env: BASE_ENV });
    await this.backups.intercept();
    await this.backups.restore(record, { dir });
    return dir;
  }

  /** Persist the lane cache dir so the next lane on this repo starts warm. */
  async saveCache(prefix: string, dir: string): Promise<void> {
    await this.ensureRunning();
    await this.backups.intercept();
    const record = await this.backups.backup({
      dir,
      exclude: ["node_modules"],
    });
    await this.env.LANE_CACHE_BUCKET?.put(
      `cache-idx/${prefix}latest.json`,
      JSON.stringify(record)
    );
  }

  /** Serialize the lane worktree (/root/repo) — credentials stay in $HOME. */
  async backupWorktreeDir(): Promise<string | null> {
    try {
      await this.ensureRunning();
      const res = await this.container.exec(
        [
          "sh",
          "-c",
          "rm -rf /tmp/pile-worktree && mkdir -p /tmp/pile-worktree && " +
            "cp -a /root/repo/. /tmp/pile-worktree/",
        ],
        { env: BASE_ENV }
      );
      if ((await res.output()).exitCode !== 0) return null;
      await this.backups.intercept();
      const record = await this.backups.backup({
        dir: "/tmp/pile-worktree",
        exclude: ["node_modules", ".cache", "*.log"],
      });
      return JSON.stringify(record);
    } catch {
      return null;
    }
  }

  /** Restore a stored worktree record back into /root/repo. */
  async restoreWorktreeDir(backupJson: string): Promise<void> {
    await this.ensureRunning();
    const record = JSON.parse(backupJson) as DirectoryBackupRecord;
    await this.backups.intercept();
    await this.backups.restore(record, { dir: "/tmp/pile-worktree" });
    // Replace, don't merge: `cp -a src dst` with an existing dst nests to
    // /root/repo/pile-worktree, and a plain merge-copy would keep files the
    // crashed run left behind — the follow-up must see the tree as it was.
    await this.container.exec(
      [
        "sh",
        "-c",
        "mkdir -p /root && rm -rf /root/repo && cp -a /tmp/pile-worktree /root/repo",
      ],
      { env: BASE_ENV }
    );
  }
}

// One class per lane image — wrangler's `containers` blocks key off the
// class name, and a scheduling_policy move is one-way, so each provider's
// 1.0 lane is a new class on a new binding alongside the 0.12 originals.
export class LaneSandbox extends LaneSandboxBase {}
export class LaneCursorSandbox extends LaneSandboxBase {}
export class LaneDevinSandbox extends LaneSandboxBase {}
export class LaneCodexSandbox extends LaneSandboxBase {}
