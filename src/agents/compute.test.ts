import { describe, expect, it, vi } from "vitest";

import { VortexError } from "../platform/errors.js";
import type { AppEnv } from "../types/env.js";
import {
  CloudflareBackend,
  LANE_CACHE_MOUNT,
  LaneSandboxBackend,
  computeBackend,
  isComputeInfraError,
  laneCachePrefix,
} from "./compute.js";
import type { ComputeSandbox, SandboxHandle } from "./compute.js";
import type { LaneSandboxBase } from "./lane-sandbox.js";

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

const daytonaTestEnv = () =>
  ({
    ...baseEnv(),
    DAYTONA_API_KEY: "k",
    DAYTONA_API_URL: "https://daytona.test",
  }) as AppEnv;

const daytonaToolbox = "https://tb.test";
const daytonaRecord: ComputeSandbox = {
  id: "sb-1",
  name: "vortex-devin-x",
  state: "started",
  toolboxProxyUrl: daytonaToolbox,
};

function fetchStub(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Promise.resolve(handler(String(input), init));
    })
  );
  return calls;
}

describe("DaytonaBackend sandbox create timeout (PILE-466)", () => {
  it("gives the create POST a 120s signal, not the shared 30s one", async () => {
    // Map each requested timeout to a distinct signal so the fetch call can
    // be attributed to its duration.
    const signals = new Map<number, AbortSignal>();
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      let signal = signals.get(ms);
      if (!signal) {
        signal = new AbortController().signal;
        signals.set(ms, signal);
      }
      return signal;
    });
    const calls = fetchStub((url, init) => {
      if (url === "https://daytona.test/sandbox" && init?.method === "POST") {
        return new Response(
          JSON.stringify({ ...daytonaRecord, state: "creating" }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify(daytonaRecord), { status: 200 });
    });

    const backend = computeBackend(daytonaTestEnv());
    await backend.createSandbox({
      name: "vortex-devin-x",
      sessionId: "sess-1",
      organizationId: "org-1",
      agentLabel: "devin-cli",
      env: {},
    });

    const create = calls.find(
      (c) =>
        c.url === "https://daytona.test/sandbox" && c.init?.method === "POST"
    );
    const poll = calls.find(
      (c) => c.url === "https://daytona.test/sandbox/sb-1" && !c.init?.method
    );
    expect(create?.init?.signal).toBe(signals.get(120_000));
    expect(poll?.init?.signal).toBe(signals.get(30_000));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});

describe("DaytonaBackend lifecycle ceilings (PILE-471)", () => {
  it("caps every created sandbox: 3h TTL, 24h stopped corpse, 4h idle", async () => {
    const calls = fetchStub((url, init) => {
      if (url === "https://daytona.test/sandbox" && init?.method === "POST") {
        return new Response(JSON.stringify(daytonaRecord), { status: 200 });
      }
      return new Response(JSON.stringify(daytonaRecord), { status: 200 });
    });

    const backend = computeBackend(daytonaTestEnv());
    await backend.createSandbox({
      name: "vortex-devin-x",
      sessionId: "sess-1",
      organizationId: "org-1",
      agentLabel: "devin-cli",
      env: {},
    });

    const create = calls.find(
      (c) =>
        c.url === "https://daytona.test/sandbox" && c.init?.method === "POST"
    );
    const body = JSON.parse(String(create?.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      ttlMinutes: 180,
      autoDeleteInterval: 1440,
      autoStopInterval: 240,
    });
    vi.unstubAllGlobals();
  });
});

const sessionCreateUrl = `${daytonaToolbox}/sb-1/process/session`;
const ipFailure = () =>
  new Response(
    JSON.stringify({
      message:
        "failed to resolve container IP after 3 attempts, last error: SANDBOX_NOT_RUNNING",
    }),
    { status: 400 }
  );

describe("DaytonaBackend process-session create retry (PILE-466)", () => {
  it("retries the container-IP 400 and then starts the runner", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let sessionCreates = 0;
      fetchStub((url) => {
        if (url === sessionCreateUrl) {
          sessionCreates++;
          return sessionCreates <= 2
            ? ipFailure()
            : new Response(JSON.stringify({ sessionId: "sess-1" }));
        }
        return new Response(JSON.stringify({ cmdId: "cmd-1" }));
      });
      const backend = computeBackend(daytonaTestEnv());
      const started = backend.startRunner(
        daytonaRecord,
        "sess-1",
        "python3 /tmp/run.py"
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);
      await started;
      expect(sessionCreates).toBe(3);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("gives up after the third retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let sessionCreates = 0;
      fetchStub((url) => {
        if (url === sessionCreateUrl) {
          sessionCreates++;
          return ipFailure();
        }
        return new Response("{}");
      });
      const backend = computeBackend(daytonaTestEnv());
      const started = backend.startRunner(
        daytonaRecord,
        "sess-1",
        "python3 /tmp/run.py"
      );
      const assertion = expect(started).rejects.toThrow(
        /process session create failed: 400/
      );
      await vi.advanceTimersByTimeAsync(15_000); // 2s + 4s + 8s
      await assertion;
      expect(sessionCreates).toBe(4);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("does not retry a session-create 400 that isn't the IP race", async () => {
    let sessionCreates = 0;
    fetchStub((url) => {
      if (url === sessionCreateUrl) {
        sessionCreates++;
        return new Response(JSON.stringify({ message: "bad request" }), {
          status: 400,
        });
      }
      return new Response("{}");
    });
    const backend = computeBackend(daytonaTestEnv());
    await expect(
      backend.startRunner(daytonaRecord, "sess-1", "python3 /tmp/run.py")
    ).rejects.toThrow(/process session create failed: 400/);
    expect(sessionCreates).toBe(1);
    vi.unstubAllGlobals();
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
  const writeFile = vi.fn(async () => ({ success: true }));
  const exec = vi.fn(async () => ({}));
  const destroy = vi.fn();
  const getProcess = vi.fn((id: string) =>
    Promise.resolve(processes[id] ?? null)
  );
  const handle = {
    getProcess,
    startProcess,
    readFile,
    writeFile,
    exec,
    destroy,
  };
  return {
    handle: handle as unknown as SandboxHandle,
    startProcess,
    readFile,
    writeFile,
    exec,
    destroy,
    getProcess,
  };
}

function fakeLaneNs() {
  const calls: string[] = [];
  const stub = {
    provision: vi.fn(async () => {}),
    spawn: vi.fn(async (o: { processId: string; command: string }) => {
      calls.push(`spawn:${o.processId}:${o.command}`);
    }),
    hasProcess: vi.fn(async () => true),
    processState: vi.fn(
      async (): Promise<import("./lane-sandbox.js").LaneProcessState> => ({
        running: true,
        exitCode: null,
      })
    ),
    sessionBusy: vi.fn(async () => false),
    readFile: vi.fn(async () => null),
    putFiles: vi.fn(async () => {}),
    tail: vi.fn(async () => "tail-bytes"),
    probe: vi.fn(async () => true),
    destroy: vi.fn(async () => {}),
  };
  const ns = {
    getByName: vi.fn(() => stub),
  };
  return {
    ns: ns as unknown as AppEnv["SANDBOX_LANE"],
    stub,
    calls,
  };
}

describe("LaneSandboxBackend (sandbox-sdk 1.0)", () => {
  it("LANE_SDK=v1 selects the lane backend on SANDBOX_LANE*", () => {
    const { ns } = fakeLaneNs();
    const env = {
      ...baseEnv(),
      COMPUTE_PROVIDER: "cloudflare",
      LANE_SDK: "v1",
      SANDBOX_LANE: ns,
    } as AppEnv;
    const backend = computeBackend(env, "codex-cli");
    expect(backend.kind).toBe("cloudflare");
    expect(backend).toBeInstanceOf(LaneSandboxBackend);
  });

  it("LANE_SDK=v1 prefers the per-provider binding", async () => {
    const { ns } = fakeLaneNs();
    const env = {
      ...baseEnv(),
      COMPUTE_PROVIDER: "cloudflare",
      LANE_SDK: "v1",
      SANDBOX_LANE: {} as AppEnv["SANDBOX_LANE"],
      SANDBOX_LANE_CURSOR: ns,
    } as unknown as AppEnv;
    const backend = computeBackend(env, "cursor-cli");
    await backend.createSandbox({
      name: "n",
      sessionId: "s",
      organizationId: "o",
      agentLabel: "x",
      env: {},
    });
    expect(ns!.getByName).toHaveBeenCalledWith("n");
  });

  it("LANE_SDK=v1 without a lane binding is a config error", () => {
    const env = {
      ...baseEnv(),
      COMPUTE_PROVIDER: "cloudflare",
      LANE_SDK: "v1",
    } as AppEnv;
    expect(() => computeBackend(env)).toThrow(/SANDBOX_LANE binding/);
  });

  it("create/start/state/poll/delete flow over the stub RPCs", async () => {
    const { ns, stub } = fakeLaneNs();
    const backend = new LaneSandboxBackend(
      ns as DurableObjectNamespace<LaneSandboxBase>
    );
    const sandbox = await backend.createSandbox({
      name: "sb-v1",
      sessionId: "s1",
      organizationId: "o1",
      agentLabel: "devin-cli",
      env: {},
    });
    expect(stub.provision).toHaveBeenCalled();
    await backend.startRunner(
      sandbox,
      "s1",
      ". /tmp/pile/lane.env && python3 /tmp/pile/run.py"
    );
    expect(stub.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ processId: "s1" })
    );
    expect(await backend.runnerState(sandbox, "s1")).toBe("running");
    await backend.putFiles(sandbox, [
      { path: "/tmp/pile/lane.env", content: "export A='1'", mode: 0o600 },
    ]);
    expect(stub.putFiles).toHaveBeenCalled();
    expect(await backend.findSandbox("s1", "sb-v1")).not.toBeNull();
    await backend.deleteSandbox(sandbox);
    expect(stub.destroy).toHaveBeenCalled();
  });

  it("runnerState maps a dead wrapper to an exit code", async () => {
    const { ns, stub } = fakeLaneNs();
    stub.processState.mockResolvedValue({ running: false, exitCode: 42 });
    const backend = new LaneSandboxBackend(
      ns as DurableObjectNamespace<LaneSandboxBase>
    );
    expect(await backend.runnerState(sandboxRecord, "s1")).toEqual({
      exitCode: 42,
    });
  });
});

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

  it("getFile returns content and null on failure", async () => {
    const { handle, readFile } = fakeSandbox({});
    readFile
      .mockResolvedValueOnce({
        success: true,
        content: '{"status":"completed"}',
      })
      .mockRejectedValueOnce(new Error("no such file"));
    const backend = new CloudflareBackend(() => Promise.resolve(handle));
    expect(await backend.getFile(sandboxRecord, "/tmp/r.json")).toBe(
      '{"status":"completed"}'
    );
    expect(await backend.getFile(sandboxRecord, "/tmp/r.json")).toBeNull();
  });

  it("putFiles writes each file and chmods when a mode is given", async () => {
    const { handle, writeFile, exec } = fakeSandbox({});
    const backend = new CloudflareBackend(() => Promise.resolve(handle));
    await backend.putFiles(sandboxRecord, [
      { path: "/tmp/pile/prompt.md", content: "do it" },
      { path: "/tmp/pile/lane.env", content: "export A='1'", mode: 0o600 },
    ]);
    expect(writeFile).toHaveBeenCalledWith("/tmp/pile/prompt.md", "do it");
    expect(writeFile).toHaveBeenCalledWith(
      "/tmp/pile/lane.env",
      "export A='1'"
    );
    expect(exec).toHaveBeenCalledWith("chmod 600 /tmp/pile/lane.env");
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

  it("remounts read-only when a reused mount must not stay writable", async () => {
    const mountBucket = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(`Mount path already in use: ${LANE_CACHE_MOUNT}`)
      )
      .mockResolvedValueOnce(undefined);
    const unmountBucket = vi.fn(() => Promise.resolve());
    const handle = { mountBucket, unmountBucket } as unknown as SandboxHandle;
    const backend = new CloudflareBackend(
      () => Promise.resolve(handle),
      cacheEnv()
    );
    expect(
      await backend.mountCache(sandboxRecord, {
        organizationId: "org-1",
        repo: "acme/widgets",
        readOnly: true,
      })
    ).toBe(LANE_CACHE_MOUNT);
    expect(unmountBucket).toHaveBeenCalledWith(LANE_CACHE_MOUNT);
    expect(mountBucket).toHaveBeenCalledTimes(2);
    expect(mountBucket).toHaveBeenLastCalledWith(
      "LANE_CACHE_BUCKET",
      LANE_CACHE_MOUNT,
      { prefix: "/org-1/acme/widgets/", readOnly: true }
    );
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

describe("Daytona hardening (PILE-472)", () => {
  it("findSandbox paginates until the session's sandbox surfaces", async () => {
    const { DaytonaBackend } = await import("./compute.js");
    const calls: string[] = [];
    const pages = [
      [{ id: "other-1", name: "a", state: "started", labels: {} }],
      [
        {
          id: "mine",
          name: "x",
          state: "started",
          labels: { "vortex.session": "sess-1" },
        },
      ],
      [],
    ];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      const page = calls.length - 1;
      return new Response(JSON.stringify({ items: pages[page] ?? [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const backend = new DaytonaBackend({} as never, {
        apiKey: "k",
        apiUrl: "https://day",
      });
      const found = await backend.findSandbox("sess-1", "x");
      expect(found?.id).toBe("mine");
      expect(calls.length).toBe(2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

const daytonaEnv = () =>
  ({
    ...baseEnv(),
    DAYTONA_API_KEY: "k",
    DAYTONA_API_URL: "https://daytona.test",
  }) as AppEnv;

function stubResponses(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return Promise.resolve(handler(String(input), init));
    })
  );
  return calls;
}

// PILE-452 — Daytona backend failures must carry the infra flag so
// dispatchAgent classifies them without string matching, and quota/
// concurrency rejections must say so explicitly in the message.
describe("DaytonaBackend infra classification + quota surfacing (PILE-452)", () => {
  it("sandbox create failures are ComputeError and infra-classified", async () => {
    stubResponses(
      () =>
        new Response(
          JSON.stringify({
            message: "sandbox exited with code 1 before becoming ready",
          }),
          { status: 400 }
        )
    );
    const backend = computeBackend(daytonaEnv());
    try {
      await backend.createSandbox({
        name: "sbx-1",
        sessionId: "s1",
        organizationId: "o1",
        agentLabel: "devin-cli",
        env: {},
      });
      expect.unreachable();
    } catch (err) {
      expect(isComputeInfraError(err)).toBe(true);
      expect((err as Error).message).toContain("Daytona sandbox create failed");
    }
    vi.unstubAllGlobals();
  });

  it("surfaces quota/concurrency rejections explicitly", async () => {
    stubResponses(
      () =>
        new Response(
          JSON.stringify({ message: "concurrent sandbox limit reached" }),
          {
            status: 400,
          }
        )
    );
    const backend = computeBackend(daytonaEnv());
    await expect(
      backend.createSandbox({
        name: "sbx-2",
        sessionId: "s2",
        organizationId: "o1",
        agentLabel: "devin-cli",
        env: {},
      })
    ).rejects.toThrow(/quota\/concurrency limit/);
    vi.unstubAllGlobals();
  });

  it("startRunner toolbox failures are infra-classified (SANDBOX_NOT_RUNNING)", async () => {
    stubResponses(
      () =>
        new Response(JSON.stringify({ message: "SANDBOX_NOT_RUNNING" }), {
          status: 400,
        })
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const backend = computeBackend(daytonaEnv());
    try {
      // The not-ready retry loop backs off 2+4+8s — fast-forward through it.
      const pending = backend
        .startRunner(
          { id: "sb-9", name: "sb-9", state: "started" },
          "s9",
          "python3 /tmp/run.py"
        )
        .then(
          () => {
            throw new Error("unreachable");
          },
          (err) => err
        );
      await vi.advanceTimersByTimeAsync(20_000);
      const err = await pending;
      expect(isComputeInfraError(err)).toBe(true);
      expect((err as Error).message).toContain("SANDBOX_NOT_RUNNING");
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("unresolvable toolbox/DNS failures coerce to infra errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.reject(new TypeError("failed to resolve container IP"))
      )
    );
    const backend = computeBackend(daytonaEnv());
    try {
      await backend.startRunner(
        { id: "sb-10", name: "sb-10", state: "started" },
        "s10",
        "python3 /tmp/run.py"
      );
      expect.unreachable();
    } catch (err) {
      expect(isComputeInfraError(err)).toBe(true);
      expect((err as Error).message).toContain(
        "failed to resolve container IP"
      );
    }
    vi.unstubAllGlobals();
  });
});

const orphanSandbox = (
  id: string,
  sessionId: string | null,
  organizationId?: string
) => ({
  id,
  name: `name-${id}`,
  state: "started",
  organizationId,
  labels: {
    ...(sessionId ? { "vortex.session": sessionId } : {}),
    ...(organizationId ? { "vortex.org": organizationId } : {}),
  },
});

const orphanBackend = (
  sandboxes: ReturnType<typeof orphanSandbox>[],
  onDelete?: (id: string) => void
) => ({
  kind: "daytona" as const,
  listSandboxes: async () => sandboxes,
  deleteSandbox: async (s: { id: string }) => {
    onDelete?.(s.id);
  },
});

describe("sweepOrphanSandboxes (PILE-471)", () => {
  it("reaps label-matched sandboxes whose session is terminal or gone", async () => {
    const deleted: string[] = [];
    const backend = orphanBackend(
      [
        orphanSandbox("s1", "sess-dead", "org-1"),
        orphanSandbox("s2", "sess-live", "org-1"),
        orphanSandbox("s3", "sess-missing", "org-1"),
      ],
      (id) => deleted.push(id)
    );
    const stub = {
      getAgentSession: async (id: string) =>
        id === "sess-dead"
          ? { status: "completed" }
          : id === "sess-missing"
            ? null
            : { status: "running" },
    };
    const { sweepOrphanSandboxes } = await import("./compute.js");
    const out = await sweepOrphanSandboxes(backend as never, stub, {
      organizationId: "org-1",
    });
    expect(out).toEqual({ reaped: 2, checked: 3 });
    expect(deleted.toSorted()).toEqual(["s1", "s3"]);
  });

  it("skips a sandbox when the session lookup fails instead of reaping it", async () => {
    const deleted: string[] = [];
    const backend = orphanBackend(
      [
        orphanSandbox("s1", "sess-flaky", "org-1"),
        orphanSandbox("s2", "sess-dead", "org-1"),
      ],
      (id) => deleted.push(id)
    );
    const stub = {
      getAgentSession: async (id: string) => {
        if (id === "sess-flaky") throw new Error("DO timeout");
        return { status: "completed" };
      },
    };
    const { sweepOrphanSandboxes } = await import("./compute.js");
    const out = await sweepOrphanSandboxes(backend as never, stub, {
      organizationId: "org-1",
    });
    expect(out).toEqual({ reaped: 1, checked: 2 });
    expect(deleted).toEqual(["s2"]);
  });

  it("counts reaped only after a successful delete and logs failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backend = orphanBackend(
      [
        orphanSandbox("s1", "sess-dead", "org-1"),
        orphanSandbox("s2", "sess-dead", "org-1"),
      ],
      (id) => {
        if (id === "s1") throw new Error("delete 500");
      }
    );
    const stub = {
      getAgentSession: async () => ({ status: "completed" }),
    };
    const { sweepOrphanSandboxes } = await import("./compute.js");
    const out = await sweepOrphanSandboxes(backend as never, stub, {
      organizationId: "org-1",
    });
    expect(out).toEqual({ reaped: 1, checked: 2 });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("scopes candidates to the sweeping org — foreign-org sandboxes are untouched", async () => {
    const deleted: string[] = [];
    const backend = orphanBackend(
      [
        orphanSandbox("s1", "sess-missing", "org-1"),
        orphanSandbox("s2", "sess-missing", "org-2"),
        // No org label: a session row in this DO still proves ownership.
        orphanSandbox("s3", "sess-dead"),
        // No org label and no session row: ownership is unattributable.
        orphanSandbox("s4", "sess-missing"),
      ],
      (id) => deleted.push(id)
    );
    const stub = {
      getAgentSession: async (id: string) =>
        id === "sess-dead" ? { status: "completed" } : null,
    };
    const { sweepOrphanSandboxes } = await import("./compute.js");
    const out = await sweepOrphanSandboxes(backend as never, stub, {
      organizationId: "org-1",
    });
    expect(out).toEqual({ reaped: 2, checked: 3 });
    expect(deleted.toSorted()).toEqual(["s1", "s3"]);
  });

  it("keeps terminal-session sandboxes inside the resume window", async () => {
    const deleted: string[] = [];
    const backend = orphanBackend(
      [
        orphanSandbox("s1", "sess-fresh", "org-1"),
        orphanSandbox("s2", "sess-old", "org-1"),
      ],
      (id) => deleted.push(id)
    );
    const stub = {
      getAgentSession: async (id: string) =>
        id === "sess-fresh"
          ? { status: "completed", endedAt: new Date().toISOString() }
          : {
              status: "completed",
              endedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            },
    };
    const { sweepOrphanSandboxes } = await import("./compute.js");
    const out = await sweepOrphanSandboxes(backend as never, stub, {
      organizationId: "org-1",
      keepTerminalMs: 45 * 60 * 1000,
    });
    expect(out).toEqual({ reaped: 1, checked: 2 });
    expect(deleted).toEqual(["s2"]);
  });

  it("applies the limit after filtering out unlabeled and foreign-org sandboxes", async () => {
    const checkedIds: string[] = [];
    const deleted: string[] = [];
    const backend = orphanBackend(
      [
        orphanSandbox("unlabeled", null),
        orphanSandbox("foreign", "sess-a", "org-2"),
        orphanSandbox("s1", "sess-a", "org-1"),
        orphanSandbox("s2", "sess-b", "org-1"),
      ],
      (id) => deleted.push(id)
    );
    const stub = {
      getAgentSession: async (id: string) => {
        checkedIds.push(id);
        return { status: "completed" };
      },
    };
    const { sweepOrphanSandboxes } = await import("./compute.js");
    const out = await sweepOrphanSandboxes(backend as never, stub, {
      organizationId: "org-1",
      limit: 1,
    });
    expect(out).toEqual({ reaped: 1, checked: 1 });
    expect(checkedIds).toEqual(["sess-a"]);
    expect(deleted).toEqual(["s1"]);
  });
});

describe("DaytonaBackend.listSandboxes (PILE-471)", () => {
  it("walks every /sandbox page and keeps only label-prefixed entries", async () => {
    const calls = fetchStub((url) => {
      if (url.endsWith("/sandbox?page=1")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "a",
                name: "a",
                state: "stopped",
                labels: { "vortex.session": "s1", "vortex.org": "org-1" },
              },
              { id: "skip", name: "x", state: "started" },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith("/sandbox?page=2")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "b",
                name: "b",
                state: "started",
                labels: { "vortex.session": "s2" },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    const backend = computeBackend(daytonaTestEnv());
    const out = (await backend.listSandboxes?.("vortex.")) ?? [];
    expect(out.map((s) => s.id)).toEqual(["a", "b"]);
    expect(out[0]?.organizationId).toBe("org-1");
    expect(calls.map((c) => c.url.replace("https://daytona.test", ""))).toEqual(
      ["/sandbox?page=1", "/sandbox?page=2", "/sandbox?page=3"]
    );
    vi.unstubAllGlobals();
  });
});
