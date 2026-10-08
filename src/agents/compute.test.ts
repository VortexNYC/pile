import { describe, expect, it, vi } from "vitest";

import { VortexError } from "../platform/errors.js";
import type { AppEnv } from "../types/env.js";
import {
  CloudflareBackend,
  LANE_CACHE_MOUNT,
  computeBackend,
  laneCachePrefix,
} from "./compute.js";
import type { ComputeSandbox, SandboxHandle } from "./compute.js";

function baseEnv(): AppEnv {
  return {
    D1: {} as AppEnv["D1"],
    ATTACHMENTS_BUCKET: {} as AppEnv["ATTACHMENTS_BUCKET"],
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

  it("prefers SANDBOX_CURSOR for cursor-cli when bound", () => {
    const env = {
      ...baseEnv(),
      COMPUTE_PROVIDER: "cloudflare",
      SANDBOX_CURSOR: {} as NonNullable<AppEnv["SANDBOX_CURSOR"]>,
    };
    expect(computeBackend(env, "cursor-cli").kind).toBe("cloudflare");
  });

  it("falls back to shared SANDBOX when the per-provider binding is absent", () => {
    const env = {
      ...baseEnv(),
      COMPUTE_PROVIDER: "cloudflare",
      SANDBOX: {} as NonNullable<AppEnv["SANDBOX"]>,
    };
    expect(computeBackend(env, "cursor-cli").kind).toBe("cloudflare");
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

const admitEnv = () =>
  ({
    ...baseEnv(),
    CF_ADMISSION_URL: "https://ci.example.dev",
    CF_ADMISSION_TOKEN: "tok",
  }) as unknown as AppEnv;

describe("CloudflareBackend shared admission (PILE-302)", () => {
  it("denies the spawn when the admission ledger is at capacity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: false, reason: "full" }), {
            status: 429,
          })
        )
      )
    );
    const { handle } = fakeSandbox({});
    const backend = new CloudflareBackend(
      () => Promise.resolve(handle),
      admitEnv()
    );
    await expect(
      backend.createSandbox({
        name: "vortex-x-1",
        sessionId: "s1",
        organizationId: "o1",
        agentLabel: "x",
        env: {},
      })
    ).rejects.toThrow(/admission denied/);
    vi.unstubAllGlobals();
  });

  it("admits on create and releases on destroy", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${init?.method} ${String(url)}`);
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), { status: 200 })
        );
      })
    );
    const { handle, destroy } = fakeSandbox({});
    const backend = new CloudflareBackend(
      () => Promise.resolve(handle),
      admitEnv()
    );
    await backend.createSandbox({
      name: "vortex-x-2",
      sessionId: "s2",
      organizationId: "o1",
      agentLabel: "x",
      env: {},
    });
    await backend.deleteSandbox(sandboxRecord);
    expect(calls.some((c) => c.includes("/admin/sandbox/admit"))).toBe(true);
    expect(calls.some((c) => c.includes("/admin/sandbox/release"))).toBe(true);
    expect(destroy).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("fails open when the admission endpoint is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("connection refused")))
    );
    const { handle } = fakeSandbox({});
    const backend = new CloudflareBackend(
      () => Promise.resolve(handle),
      admitEnv()
    );
    const created = await backend.createSandbox({
      name: "vortex-x-3",
      sessionId: "s3",
      organizationId: "o1",
      agentLabel: "x",
      env: {},
    });
    expect(created.state).toBe("started");
    vi.unstubAllGlobals();
  });
});

describe("CloudflareBackend.waitForRunner + admission (PILE-302/308)", () => {
  it("waits on the process health port once the process registers", async () => {
    const waitForPort = vi.fn().mockResolvedValue(undefined);
    const proc = { ...fakeProcess("running"), waitForPort };
    const { handle, getProcess } = fakeSandbox({ "sess-1": proc });
    const backend = new CloudflareBackend(() => Promise.resolve(handle));
    await backend.waitForRunner!(sandboxRecord, "sess-1", 5_000);
    expect(getProcess).toHaveBeenCalledWith("sess-1");
    expect(waitForPort).toHaveBeenCalled();
  });

  it("throws when the process never registers before the deadline", async () => {
    const { handle } = fakeSandbox({});
    const backend = new CloudflareBackend(() => Promise.resolve(handle));
    await expect(
      backend.waitForRunner!(sandboxRecord, "ghost", 50)
    ).rejects.toThrow(/never registered/);
  });
});

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

  it("findSandbox falls back to the result file when the process is gone", async () => {
    const { handle, readFile } = fakeSandbox({});
    readFile.mockResolvedValueOnce({
      success: true,
      content: '{"status":"completed"}',
    });
    const backend = new CloudflareBackend(() => Promise.resolve(handle));
    const found = await backend.findSandbox(
      "sess-1",
      "vortex-codex-abc123",
      "/tmp/r.json"
    );
    expect(found?.id).toBe("vortex-codex-abc123");
  });

  it("runnerState reports exited, running, and missing-record as exited", async () => {
    const { handle } = fakeSandbox({
      running: fakeProcess("running"),
      done: fakeProcess("completed", 0),
      failed: fakeProcess("failed"),
    });
    const backend = new CloudflareBackend(() => Promise.resolve(handle));
    expect(await backend.runnerState(sandboxRecord, "missing")).toEqual({
      exitCode: 1,
    });
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

const cacheEnv = () =>
  ({
    ...baseEnv(),
    LANE_CACHE_BUCKET: {} as AppEnv["ATTACHMENTS_BUCKET"],
  }) as AppEnv;

function mountHandle(impl?: () => Promise<void>) {
  const mountBucket = vi.fn(impl ?? (() => Promise.resolve()));
  return {
    handle: { mountBucket } as unknown as SandboxHandle,
    mountBucket,
  };
}

describe("CloudflareBackend lane cache mount (PILE-306)", () => {
  it("scopes the prefix to workspace + repo and neutralizes traversal", () => {
    expect(laneCachePrefix("org_vortex_main", "VortexNYC/pile")).toBe(
      "/org_vortex_main/VortexNYC/pile/"
    );
    expect(laneCachePrefix("org-1", "../../etc/x y")).toBe(
      "/org-1/_/_/etc/x_y/"
    );
  });

  it("mounts the repo's prefix via the R2 binding and returns the path", async () => {
    const { handle, mountBucket } = mountHandle();
    const backend = new CloudflareBackend(
      () => Promise.resolve(handle),
      cacheEnv()
    );
    const dir = await backend.mountCache(sandboxRecord, {
      organizationId: "org-1",
      repo: "acme/widgets",
      readOnly: true,
    });
    expect(dir).toBe(LANE_CACHE_MOUNT);
    expect(mountBucket).toHaveBeenCalledWith(
      "LANE_CACHE_BUCKET",
      LANE_CACHE_MOUNT,
      { prefix: "/org-1/acme/widgets/", readOnly: true }
    );
  });

  it("skips the mount when no cache bucket is bound", async () => {
    const { handle, mountBucket } = mountHandle();
    const backend = new CloudflareBackend(
      () => Promise.resolve(handle),
      baseEnv()
    );
    expect(
      await backend.mountCache(sandboxRecord, {
        organizationId: "org-1",
        repo: "acme/widgets",
        readOnly: false,
      })
    ).toBeNull();
    expect(mountBucket).not.toHaveBeenCalled();
  });

  it("reuses a live sandbox's existing mount on follow-ups", async () => {
    const { handle } = mountHandle(() =>
      Promise.reject(
        new Error(`Mount path already in use: ${LANE_CACHE_MOUNT}`)
      )
    );
    const backend = new CloudflareBackend(
      () => Promise.resolve(handle),
      cacheEnv()
    );
    expect(
      await backend.mountCache(sandboxRecord, {
        organizationId: "org-1",
        repo: "acme/widgets",
        readOnly: false,
      })
    ).toBe(LANE_CACHE_MOUNT);
  });

  it("fails open when s3fs cannot mount", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handle } = mountHandle(() =>
      Promise.reject(new Error("S3FSMountError"))
    );
    const backend = new CloudflareBackend(
      () => Promise.resolve(handle),
      cacheEnv()
    );
    expect(
      await backend.mountCache(sandboxRecord, {
        organizationId: "org-1",
        repo: "acme/widgets",
        readOnly: false,
      })
    ).toBeNull();
    warn.mockRestore();
  });
});
