import { describe, expect, it, vi } from "vitest";

import { VortexError } from "../platform/errors.js";
import type { AppEnv } from "../types/env.js";
import { CloudflareBackend, computeBackend } from "./compute.js";
import type { ComputeSandbox, SandboxHandle } from "./compute.js";

function baseEnv(): AppEnv {
  return {
    D1: {} as AppEnv["D1"],
    BETTER_AUTH_SECRET: "x",
    BETTER_AUTH_URL: "https://pile.test",
    DEVIN_TOKEN: "x",
  };
}

describe("computeBackend", () => {
  it("defaults to daytona when configured", () => {
    const env = { ...baseEnv(), DAYTONA_API_KEY: "key" };
    expect(computeBackend(env).kind).toBe("daytona");
  });

  it("throws when daytona is unconfigured", () => {
    expect(() => computeBackend(baseEnv())).toThrow(VortexError);
  });

  it("selects cloudflare when COMPUTE_PROVIDER=cloudflare and SANDBOX bound", () => {
    const env = {
      ...baseEnv(),
      COMPUTE_PROVIDER: "cloudflare",
      SANDBOX: {} as NonNullable<AppEnv["SANDBOX"]>,
    };
    expect(computeBackend(env).kind).toBe("cloudflare");
  });

  it("throws when COMPUTE_PROVIDER=cloudflare without a SANDBOX binding", () => {
    const env = { ...baseEnv(), COMPUTE_PROVIDER: "cloudflare" };
    expect(() => computeBackend(env)).toThrow(/SANDBOX binding/);
  });
});

function fakeProcess(
  status: string,
  exitCode?: number
): {
  id: string;
  status: string;
  exitCode?: number;
  getStatus: () => Promise<string>;
} {
  return {
    id: "proc-1",
    status,
    exitCode,
    getStatus: () => Promise.resolve(status),
  };
}

function fakeSandbox(
  processes: Record<string, ReturnType<typeof fakeProcess>>
) {
  const startProcess = vi.fn();
  const readFile = vi.fn();
  const destroy = vi.fn();
  const getProcess = vi.fn((id: string) =>
    Promise.resolve(processes[id] ?? null)
  );
  const handle = { getProcess, startProcess, readFile, destroy };
  return {
    handle: handle as unknown as SandboxHandle,
    startProcess,
    readFile,
    destroy,
    getProcess,
  };
}

const sandboxRecord: ComputeSandbox = {
  id: "vortex-codex-abc123",
  name: "vortex-codex-abc123",
  state: "started",
};

describe("CloudflareBackend", () => {
  it("createSandbox returns a started handle carrying runner env", async () => {
    const { handle } = fakeSandbox({});
    const backend = new CloudflareBackend(() => Promise.resolve(handle));
    const created = await backend.createSandbox({
      name: "vortex-codex-abc123",
      sessionId: "sess-1",
      organizationId: "org-1",
      agentLabel: "codex-cli",
      env: { FOO: "bar" },
    });
    expect(created.state).toBe("started");
    expect(created.runnerEnv).toEqual({ FOO: "bar" });
  });

  it("startRunner starts a process with the runner env and session id", async () => {
    const { handle, startProcess } = fakeSandbox({});
    const backend = new CloudflareBackend(() => Promise.resolve(handle));
    const sandbox = { ...sandboxRecord, runnerEnv: { FOO: "bar" } };
    await backend.startRunner(sandbox, "sess-1", "python3 /tmp/run.py");
    expect(startProcess).toHaveBeenCalledWith("python3 /tmp/run.py", {
      processId: "sess-1",
      env: { FOO: "bar" },
      autoCleanup: false,
    });
  });

  it("findSandbox returns null when no process exists", async () => {
    const { handle } = fakeSandbox({});
    const backend = new CloudflareBackend(() => Promise.resolve(handle));
    expect(
      await backend.findSandbox("sess-1", "vortex-codex-abc123")
    ).toBeNull();
  });

  it("findSandbox returns the sandbox when a runner process exists", async () => {
    const { handle } = fakeSandbox({ "sess-1": fakeProcess("running") });
    const backend = new CloudflareBackend(() => Promise.resolve(handle));
    const found = await backend.findSandbox("sess-1", "vortex-codex-abc123");
    expect(found?.id).toBe("vortex-codex-abc123");
  });

  it("runnerState reports pending, running, and exited", async () => {
    const { handle } = fakeSandbox({
      running: fakeProcess("running"),
      done: fakeProcess("completed", 0),
      failed: fakeProcess("failed"),
    });
    const backend = new CloudflareBackend(() => Promise.resolve(handle));
    expect(await backend.runnerState(sandboxRecord, "missing")).toBe("pending");
    expect(await backend.runnerState(sandboxRecord, "running")).toBe("running");
    expect(await backend.runnerState(sandboxRecord, "done")).toEqual({
      exitCode: 0,
    });
    expect(await backend.runnerState(sandboxRecord, "failed")).toEqual({
      exitCode: 1,
    });
  });

  it("readFile returns content and null on failure", async () => {
    const { handle, readFile } = fakeSandbox({});
    readFile
      .mockResolvedValueOnce({
        success: true,
        content: '{"status":"completed"}',
      })
      .mockRejectedValueOnce(new Error("no such file"));
    const backend = new CloudflareBackend(() => Promise.resolve(handle));
    expect(await backend.readFile(sandboxRecord, "/tmp/r.json")).toBe(
      '{"status":"completed"}'
    );
    expect(await backend.readFile(sandboxRecord, "/tmp/r.json")).toBeNull();
  });

  it("deleteSandbox destroys the sandbox", async () => {
    const { handle, destroy } = fakeSandbox({});
    const backend = new CloudflareBackend(() => Promise.resolve(handle));
    await backend.deleteSandbox(sandboxRecord);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
