import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../types/env.js";
import type { Issue } from "../types/workspace.js";
import {
  CloudflareBackend,
  ComputeError,
  FailoverBackend,
  LaneSandboxBackend,
} from "./compute.js";
import type { ComputeBackend, SandboxHandle } from "./compute.js";
import { DevinCliAgentProvider } from "./devin-cli.js";
import type { LaneSandboxBase } from "./lane-sandbox.js";

// Provider-level lifecycle across every compute substrate the devin-cli lane
// can land on: sandbox-sdk 0.12 (CloudflareBackend), sandbox-sdk 1.0 lane DOs
// (LaneSandboxBackend), and the Daytona→lane failover wrapper. devin-cli's
// descriptor is representative — every SandboxCliAgentProvider shares the
// dispatch/poll/sendPrompt/cancel path, so one driver exercises all of them.

const RESULT_PATH = "/tmp/agent-result.json";
const RUNNER_CMD = ". /tmp/pile/lane.env && python3 /tmp/pile/run.py";

function cliEnv(overrides?: Partial<AppEnv>): AppEnv {
  return {
    DEVIN_CLI_CREDENTIALS_B64: btoa('token = "devin-session-token$test"'),
    ...overrides,
  } as AppEnv;
}

function issueFixture(): Issue {
  return {
    id: "issue-1",
    title: "Add a thing",
    description: "do it",
    repo: "VortexNYC/pile",
    branch: "ISS-1-add-thing",
    identifier: "ISS-1",
  } as unknown as Issue;
}

const gitIdentity = {
  repo: "VortexNYC/pile",
  name: "Vortex Agent",
  email: "agent@example.com",
  githubUsername: "va",
};

type FakeProc = {
  id: string;
  status: "starting" | "running" | "completed" | "failed";
  exitCode: number | null;
  getStatus: () => Promise<string>;
  waitForPort: () => Promise<void>;
};

function cfProc(
  id: string,
  status: FakeProc["status"],
  exitCode: number | null = null
): FakeProc {
  return {
    id,
    status,
    exitCode,
    getStatus: () => Promise.resolve(status),
    waitForPort: () => Promise.resolve(undefined),
  };
}

/** CloudflareBackend over a fake 0.12 Sandbox handle. */
function cfBackend(
  processes: Record<string, FakeProc | null> = {},
  files = new Map<string, string>()
) {
  const getProcess = vi.fn((id: string) =>
    Promise.resolve(processes[id] ?? null)
  );
  const listProcesses = vi.fn(async () =>
    Object.values(processes).filter((p): p is FakeProc => p !== null)
  );
  const startProcess = vi.fn(async () => ({}));
  const readFile = vi.fn(async (path: string) =>
    files.has(path)
      ? { success: true, content: files.get(path)! }
      : { success: false }
  );
  const writeFile = vi.fn(async (path: string, content: string) => {
    files.set(path, content);
    return { success: true };
  });
  const exec = vi.fn(async () => ({}));
  const destroy = vi.fn(async () => {});
  const handle = {
    getProcess,
    listProcesses,
    startProcess,
    readFile,
    writeFile,
    destroy,
    getProcessLogs: vi.fn(async () => ({ stdout: "", stderr: "" })),
    createBackup: vi.fn(async () => ({ id: "backup-1" })),
    restoreBackup: vi.fn(async () => ({})),
    exec,
    tunnels: { get: vi.fn(async () => ({ url: "https://tun.example" })) },
    mountBucket: vi.fn(async () => ({})),
    unmountBucket: vi.fn(async () => ({})),
  };
  const backend = new CloudflareBackend(() =>
    Promise.resolve(handle as unknown as SandboxHandle)
  );
  return { backend, handle, files, startProcess, destroy };
}

/** LaneSandboxBackend over a fake 1.0 lane-DO stub. */
function laneBackend() {
  const files = new Map<string, string>();
  const stub = {
    provision: vi.fn(async () => {}),
    spawn: vi.fn(async (_o: { processId: string; command: string }) => {}),
    hasProcess: vi.fn(async () => true),
    processState: vi.fn(
      async (): Promise<{ running: boolean; exitCode: number | null }> => ({
        running: true,
        exitCode: null,
      })
    ),
    sessionBusy: vi.fn(async () => false),
    readFile: vi.fn(async (path: string) => files.get(path) ?? null),
    putFiles: vi.fn(
      async (writes: Array<{ path: string; content: string }>) => {
        for (const f of writes) files.set(f.path, f.content);
      }
    ),
    tail: vi.fn(async () => "tail"),
    probe: vi.fn(async () => true),
    destroy: vi.fn(async () => {}),
    restoreCache: vi.fn(async () => "/mnt/pile-cache"),
    saveCache: vi.fn(async () => {}),
    backupWorktreeDir: vi.fn(async () => '{"backup":"v1"}'),
    restoreWorktreeDir: vi.fn(async () => {}),
  };
  const ns = { getByName: vi.fn(() => stub) };
  const backend = new LaneSandboxBackend(
    ns as unknown as DurableObjectNamespace<LaneSandboxBase>
  );
  return { backend, stub, ns, files };
}

function providerOn(compute: ComputeBackend, env = cliEnv()) {
  const provider = new DevinCliAgentProvider(env);
  const seam = provider as unknown as {
    d: { compute: unknown };
    githubToken: (repo: string) => Promise<{ token: string; expiresAt: null }>;
    followupPermissions: () => Promise<unknown>;
  };
  seam.d.compute = compute;
  seam.githubToken = vi
    .fn()
    .mockResolvedValue({ token: "ghs_x", expiresAt: null });
  return { provider, seam };
}

async function dispatch(provider: DevinCliAgentProvider) {
  const waits: Promise<unknown>[] = [];
  const result = await provider.dispatch("org-1", issueFixture(), "swe-2", {
    sessionId: "sess-1",
    gitIdentity: gitIdentity as never,
    waitUntil: (p) => waits.push(p),
  });
  await Promise.all(waits);
  return result;
}

const completedResult = JSON.stringify({
  status: "completed",
  prUrl: "https://github.com/VortexNYC/pile/pull/42",
  branch: "ISS-1-add-thing",
  result: "Done",
});

describe("devin-cli × CloudflareBackend (sandbox-sdk 0.12)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("provisions: files uploaded, runner started on the sourced lane env, health port awaited", async () => {
    const { backend, handle, files } = cfBackend({
      "sess-1": cfProc("sess-1", "running"),
    });
    const { provider } = providerOn(backend);

    const res = await dispatch(provider);
    expect(res.status).toBe("created");
    expect(res.agentId).toBe("devin-cli");

    for (const path of [
      "/tmp/pile/lane.env",
      "/tmp/pile/prompt.md",
      "/tmp/pile/run.py",
    ]) {
      expect(files.has(path)).toBe(true);
    }
    expect(files.get("/tmp/pile/lane.env")).toContain("export MODEL='swe-2'");
    expect(files.get("/tmp/pile/lane.env")).toContain(
      "export DEVIN_CREDENTIALS_B64='"
    );
    expect(files.get("/tmp/pile/run.py")).toContain("Pile agent runner");
    expect(handle.startProcess).toHaveBeenCalledWith(
      RUNNER_CMD,
      expect.objectContaining({ processId: "sess-1" })
    );
  });

  it("poll reports running while the process is alive", async () => {
    const { backend } = cfBackend({ "sess-1": cfProc("sess-1", "running") });
    const { provider } = providerOn(backend);
    expect((await provider.poll("sess-1")).status).toBe("running");
  });

  it("poll reports created when no process and no result file exist", async () => {
    const { backend } = cfBackend({});
    const { provider } = providerOn(backend);
    expect((await provider.poll("sess-1")).status).toBe("created");
  });

  it("poll completed surfaces prUrl/branch and keeps the sandbox for follow-ups", async () => {
    const files = new Map([[RESULT_PATH, completedResult]]);
    const { backend, destroy } = cfBackend(
      { "sess-1": cfProc("sess-1", "completed", 0) },
      files
    );
    const { provider } = providerOn(backend);
    const polled = await provider.poll("sess-1");
    expect(polled.status).toBe("completed");
    expect(polled.prUrl).toBe("https://github.com/VortexNYC/pile/pull/42");
    expect(polled.branch).toBe("ISS-1-add-thing");
    // followup descriptor: the sandbox is kept, not destroyed.
    expect(destroy).not.toHaveBeenCalled();
  });

  it("poll failed + infraFailure when the runner exits with no result file", async () => {
    const { backend, destroy } = cfBackend({
      "sess-1": cfProc("sess-1", "completed", 1),
    });
    const { provider } = providerOn(backend);
    const polled = await provider.poll("sess-1");
    expect(polled.status).toBe("failed");
    expect(polled.infraFailure).toBe(true);
    expect(polled.result).toMatch(/without a result file/);
    expect(destroy).toHaveBeenCalled();
  });

  it("sendPrompt injects into /tmp/followups while the runner is busy — no new process", async () => {
    const files = new Map([[RESULT_PATH, completedResult]]);
    const { backend, startProcess } = cfBackend(
      { "sess-1": cfProc("sess-1", "running") },
      files
    );
    const { provider } = providerOn(backend);

    const sent = await provider.sendPrompt(
      "sess-1",
      "also fix the lint error",
      issueFixture(),
      null,
      { organizationId: "org-1" }
    );
    expect(sent).toBe(true);
    expect(startProcess).not.toHaveBeenCalled();
    const followups = [...files.keys()].filter((p) =>
      p.startsWith("/tmp/followups/")
    );
    expect(followups).toHaveLength(1);
    expect(files.get(followups[0]!)).toBe("also fix the lint error");
  });

  it("sendPrompt on an idle sandbox spawns a -fu runner process", async () => {
    const files = new Map([[RESULT_PATH, completedResult]]);
    const {
      backend,
      handle,
      files: written,
    } = cfBackend({ "sess-1": cfProc("sess-1", "completed", 0) }, files);
    const { provider, seam } = providerOn(backend);
    vi.spyOn(seam, "followupPermissions").mockResolvedValue({
      shell: "enabled",
      push: "enabled",
    });

    const sent = await provider.sendPrompt(
      "sess-1",
      "keep going",
      issueFixture(),
      null,
      { organizationId: "org-1" }
    );
    expect(sent).toBe(true);
    expect(handle.startProcess).toHaveBeenCalledWith(
      RUNNER_CMD,
      expect.objectContaining({
        processId: expect.stringContaining("sess-1-fu-"),
      })
    );
    const laneEnv = written.get("/tmp/pile/lane.env");
    expect(laneEnv).toContain("export FOLLOWUP='1'");
  });

  it("cancel destroys the sandbox even when findSandbox misses", async () => {
    const { backend, destroy } = cfBackend({});
    const { provider } = providerOn(backend);
    await provider.cancel("sess-1");
    expect(destroy).toHaveBeenCalled();
  });

  it("poll surfaces rateLimited + rateLimitUntil for the sweep's park (VTX-638)", async () => {
    // The runner flags provider-capacity deaths in the result file; poll must
    // carry both fields verbatim — the sweep parks the retry until the
    // advertised reset instead of burning the lane's retry budget.
    const until = "2026-10-22T17:22:00+00:00";
    const files = new Map([
      [
        RESULT_PATH,
        JSON.stringify({
          status: "failed",
          result:
            'devin -p failed (1): Reached free model rate limit. Your limit will reset in 1 minute (at 17:21 UTC). {"cognition.ai/errorKind":"unavailable","cognition.ai/retryable":true}',
          rateLimited: true,
          rateLimitUntil: until,
        }),
      ],
    ]);
    const { backend, destroy } = cfBackend(
      { "sess-1": cfProc("sess-1", "completed", 1) },
      files
    );
    const { provider } = providerOn(backend);
    const polled = await provider.poll("sess-1");
    expect(polled.status).toBe("failed");
    expect(polled.rateLimited).toBe(true);
    expect(polled.rateLimitUntil).toBe(until);
    expect(polled.infraFailure).toBeUndefined();
    // followup descriptor keeps the sandbox even on a rate-limit death.
    expect(destroy).not.toHaveBeenCalled();
  });

  it("poll failed + infraFailure when the runner dies on the substrate", async () => {
    const files = new Map([
      [
        RESULT_PATH,
        JSON.stringify({
          status: "failed",
          result: "TransportError: git push died",
          infraFailure: true,
        }),
      ],
    ]);
    const { backend } = cfBackend(
      { "sess-1": cfProc("sess-1", "completed", 1) },
      files
    );
    const { provider } = providerOn(backend);
    const polled = await provider.poll("sess-1");
    expect(polled.status).toBe("failed");
    expect(polled.infraFailure).toBe(true);
    expect(polled.rateLimited).toBeUndefined();
  });

  it("getState reports the runner state and transcript tail", async () => {
    const files = new Map([["/tmp/agent.log", "runner transcript tail"]]);
    const { backend } = cfBackend(
      { "sess-1": cfProc("sess-1", "running") },
      files
    );
    const { provider } = providerOn(backend);
    const state = await provider.getState("sess-1", "sess-1");
    expect(state).not.toBeNull();
    expect(state?.provider).toEqual({
      state: "running",
      logs: "runner transcript tail",
    });
    expect(state?.compute?.name).toBe("vortex-devin-sess1");
  });

  it("backupTerminalSandbox returns the serialized worktree backup", async () => {
    const files = new Map([[RESULT_PATH, completedResult]]);
    const { backend } = cfBackend({}, files);
    const { provider } = providerOn(backend);
    const ref = await provider.backupTerminalSandbox("sess-1");
    expect(ref).toBe(JSON.stringify({ id: "backup-1" }));
  });
});

describe("devin-cli × LaneSandboxBackend (sandbox-sdk 1.0)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("provisions over the DO RPCs: provision → putFiles → spawn → probe", async () => {
    const { backend, stub, files } = laneBackend();
    const { provider } = providerOn(backend);

    const res = await dispatch(provider);
    expect(res.status).toBe("created");

    expect(stub.provision).toHaveBeenCalled();
    expect(files.has("/tmp/pile/lane.env")).toBe(true);
    expect(files.get("/tmp/pile/lane.env")).toContain(
      "export DEVIN_CREDENTIALS_B64='"
    );
    expect(stub.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        processId: "sess-1",
        command: RUNNER_CMD,
      })
    );
    expect(stub.probe).toHaveBeenCalledWith(8787);
  });

  it("poll completed reads the result file and keeps the lane sandbox", async () => {
    const { backend, stub, files } = laneBackend();
    files.set(RESULT_PATH, completedResult);
    stub.processState.mockResolvedValue({ running: false, exitCode: 0 });
    const { provider } = providerOn(backend);

    const polled = await provider.poll("sess-1");
    expect(polled.status).toBe("completed");
    expect(polled.prUrl).toBe("https://github.com/VortexNYC/pile/pull/42");
    expect(stub.destroy).not.toHaveBeenCalled();
  });

  it("poll reports created when the lane sandbox has no process or result", async () => {
    const { backend, stub } = laneBackend();
    stub.hasProcess.mockResolvedValue(false);
    const { provider } = providerOn(backend);
    expect((await provider.poll("sess-1")).status).toBe("created");
  });

  it("poll still reads the result when the process record is gone (container slept)", async () => {
    // The pid wrapper's record can outlive the runner only in /tmp files —
    // hasProcess goes false on a slept/restarted container, and the result
    // file is the surviving proof. findSandbox must follow it or a finished
    // lane would poll 'created' forever.
    const { backend, stub, files } = laneBackend();
    stub.hasProcess.mockResolvedValue(false);
    stub.processState.mockResolvedValue({ running: false, exitCode: 0 });
    files.set(RESULT_PATH, completedResult);
    const { provider } = providerOn(backend);

    const polled = await provider.poll("sess-1");
    expect(polled.status).toBe("completed");
    expect(polled.prUrl).toBe("https://github.com/VortexNYC/pile/pull/42");
  });

  it("cancel destroys the lane DO by name even when no process or result exists", async () => {
    const { backend, stub, ns } = laneBackend();
    stub.hasProcess.mockResolvedValue(false);
    const { provider } = providerOn(backend);

    await provider.cancel("sess-1");
    // findSandbox missed, so cancel falls back to the name-derived target —
    // the DO is still destroyed instead of leaking a billing container.
    expect(ns.getByName).toHaveBeenCalledWith("vortex-devin-sess1");
    expect(stub.destroy).toHaveBeenCalled();
  });

  it("getState reports process state plus the runner's log tail", async () => {
    const { backend, stub } = laneBackend();
    const { provider } = providerOn(backend);

    const state = await provider.getState("sess-1", "sess-1");
    expect(state).not.toBeNull();
    expect(state?.provider).toEqual({ state: "running", logs: "tail" });
    expect(stub.tail).toHaveBeenCalledWith("/tmp/pile/proc/sess-1.log");
  });

  it("getState falls back to the wrapper log when /tmp/agent.log is absent", async () => {
    const { backend, stub } = laneBackend();
    stub.processState.mockResolvedValue({ running: false, exitCode: 7 });
    const { provider } = providerOn(backend);

    const state = await provider.getState("sess-1", "sess-1");
    expect(state?.provider).toEqual({
      state: { exitCode: 7 },
      logs: "tail",
    });
  });

  it("sendPrompt revives a dead lane from its worktree backup", async () => {
    const { backend, stub, files } = laneBackend();
    stub.hasProcess.mockResolvedValue(false);
    const { provider, seam } = providerOn(backend);
    vi.spyOn(seam, "followupPermissions").mockResolvedValue({
      shell: "enabled",
      push: "enabled",
    });

    const sent = await provider.sendPrompt(
      "sess-1",
      "finish the rebase",
      issueFixture(),
      null,
      { organizationId: "org-1", backupRef: '{"backup":"v1"}' }
    );
    expect(sent).toBe(true);
    expect(stub.provision).toHaveBeenCalled();
    expect(stub.restoreWorktreeDir).toHaveBeenCalledWith('{"backup":"v1"}');
    expect(files.get("/tmp/pile/lane.env")).toContain("export FOLLOWUP='1'");
    expect(stub.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        processId: expect.stringContaining("sess-1-fu-"),
        command: RUNNER_CMD,
      })
    );
  });

  it("sendPrompt on a truly gone lane returns false so callers cold-dispatch", async () => {
    const { backend, stub } = laneBackend();
    stub.hasProcess.mockResolvedValue(false);
    stub.restoreWorktreeDir.mockRejectedValue(new Error("backup gone"));
    const { provider } = providerOn(backend);

    const sent = await provider.sendPrompt(
      "sess-1",
      "ping",
      issueFixture(),
      null,
      { organizationId: "org-1", backupRef: '{"backup":"dead"}' }
    );
    expect(sent).toBe(false);
  });
});

describe("devin-cli × FailoverBackend (Daytona down → lane pool)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a dispatch survives the primary backend's create failure", async () => {
    const deadDaytona = {
      kind: "daytona" as const,
      createSandbox: vi.fn(async () => {
        throw new ComputeError({
          code: "AGENT_ERROR",
          status: 503,
          message: "Daytona sandbox create failed: 503",
        });
      }),
      findSandbox: vi.fn(async () => null),
      startRunner: vi.fn(async () => {}),
      runnerState: vi.fn(async () => "pending" as const),
      getFile: vi.fn(async () => null),
      putFiles: vi.fn(async () => {}),
      deleteSandbox: vi.fn(async () => {}),
      health: vi.fn(async () => ({ ok: false })),
    } satisfies ComputeBackend;
    const { backend: lane, stub, files } = laneBackend();
    const fb = new FailoverBackend(deadDaytona, lane);
    const { provider } = providerOn(fb);

    const res = await dispatch(provider);
    expect(res.status).toBe("created");
    // The lane landed on the fallback substrate end-to-end.
    expect(stub.provision).toHaveBeenCalled();
    expect(files.has("/tmp/pile/lane.env")).toBe(true);
    expect(stub.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ processId: "sess-1", command: RUNNER_CMD })
    );
  });
});
