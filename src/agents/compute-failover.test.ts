import { describe, expect, it, vi } from "vitest";

import { VortexError } from "../platform/errors.js";
import type { AppEnv } from "../types/env.js";
import {
  CloudflareBackend,
  ComputeError,
  FailoverBackend,
  LaneSandboxBackend,
  computeBackend,
} from "./compute.js";
import type { ComputeBackend, ComputeSandbox } from "./compute.js";
import type { LaneSandboxBase } from "./lane-sandbox.js";

function baseEnv(): AppEnv {
  return {
    D1: {} as AppEnv["D1"],
    ATTACHMENTS_BUCKET: {} as AppEnv["ATTACHMENTS_BUCKET"],
    BETTER_AUTH_SECRET: "x",
    BETTER_AUTH_URL: "https://pile.test",
    DEVIN_TOKEN: "x",
    DAYTONA_API_KEY: "k",
    DAYTONA_API_URL: "https://daytona.test",
  } as AppEnv;
}

const sandbox = (id: string): ComputeSandbox => ({
  id,
  name: id,
  state: "started",
});

function fakeLaneNs() {
  const stub = {
    provision: vi.fn(async () => {}),
    spawn: vi.fn(async () => {}),
    hasProcess: vi.fn(async () => true),
    processState: vi.fn(async () => ({ running: true, exitCode: null })),
    sessionBusy: vi.fn(async () => false),
    readFile: vi.fn(async () => null),
    putFiles: vi.fn(async () => {}),
    tail: vi.fn(async () => "tail-bytes"),
    probe: vi.fn(async () => true),
    destroy: vi.fn(async () => {}),
    restoreCache: vi.fn(async () => "/mnt/pile-cache"),
    saveCache: vi.fn(async () => {}),
    backupWorktreeDir: vi.fn(async () => '{"v":1}'),
    restoreWorktreeDir: vi.fn(async () => {}),
  };
  const ns = { getByName: vi.fn(() => stub) };
  return { ns: ns as unknown as AppEnv["SANDBOX_LANE"], stub };
}

/** Minimal ComputeBackend recording which calls it served. */
function recordingBackend(
  kind: "daytona" | "cloudflare",
  opts?: {
    createError?: unknown;
  }
) {
  const calls: string[] = [];
  const backend: ComputeBackend = {
    kind,
    createSandbox: vi.fn(async (o) => {
      calls.push("createSandbox");
      if (opts?.createError) throw opts.createError;
      return sandbox(`sb-${kind}-${o.sessionId}`);
    }),
    findSandbox: vi.fn(async () => {
      calls.push("findSandbox");
      return sandbox(`sb-${kind}-found`);
    }),
    startRunner: vi.fn(async () => {
      calls.push("startRunner");
    }),
    runnerState: vi.fn(async () => {
      calls.push("runnerState");
      return "running" as const;
    }),
    runnerBusy: vi.fn(async () => {
      calls.push("runnerBusy");
      return false;
    }),
    getFile: vi.fn(async () => {
      calls.push("getFile");
      return null;
    }),
    putFiles: vi.fn(async () => {
      calls.push("putFiles");
    }),
    deleteSandbox: vi.fn(async () => {
      calls.push("deleteSandbox");
    }),
    backupWorktree: vi.fn(async () => {
      calls.push("backupWorktree");
      return "backup-ref";
    }),
    restoreWorktree: vi.fn(async (name: string) => {
      calls.push("restoreWorktree");
      return sandbox(name);
    }),
    mountCache: vi.fn(async () => {
      calls.push("mountCache");
      return "/mnt/cache";
    }),
    previewUrl: vi.fn(async () => {
      calls.push("previewUrl");
      return "https://tun.example";
    }),
    health: vi.fn(async () => {
      calls.push("health");
      return { ok: true };
    }),
  };
  return { backend, calls };
}

const infra = (msg: string) =>
  new ComputeError({ code: "AGENT_ERROR", status: 502, message: msg });

const createOpts = {
  name: "vortex-devin-s1",
  sessionId: "s1",
  organizationId: "o1",
  agentLabel: "devin-cli",
  env: {},
};

describe("FailoverBackend (PILE-473/474)", () => {
  it("serves create from the primary when it succeeds", async () => {
    const primary = recordingBackend("daytona");
    const fallback = recordingBackend("cloudflare");
    const fb = new FailoverBackend(primary.backend, fallback.backend);

    const sb = await fb.createSandbox(createOpts);
    expect(sb.id).toBe("sb-daytona-s1");
    expect(fb.kind).toBe("daytona");
    expect(fallback.calls).toEqual([]);
  });

  it("swaps to the fallback on an infra-class create failure — and stays there", async () => {
    const primary = recordingBackend("daytona", {
      createError: infra("Daytona sandbox create failed: 503"),
    });
    const fallback = recordingBackend("cloudflare");
    const fb = new FailoverBackend(primary.backend, fallback.backend);

    const sb = await fb.createSandbox(createOpts);
    expect(sb.id).toBe("sb-cloudflare-s1");
    expect(fb.kind).toBe("cloudflare");

    // The switch is sticky — every later call, including a second create,
    // goes to the fallback so a lane can't straddle substrates.
    await fb.createSandbox(createOpts);
    await fb.findSandbox("s1", "vortex-devin-s1");
    await fb.startRunner(sb, "s1", "cmd");
    await fb.runnerState(sb, "s1");
    await fb.putFiles(sb, []);
    await fb.getFile(sb, "/tmp/x");
    await fb.runnerBusy(sb, "s1");
    await fb.deleteSandbox(sb);
    await fb.backupWorktree(sb);
    await fb.restoreWorktree("n", "{}");
    await fb.mountCache(sb, {
      organizationId: "o1",
      repo: "a/b",
      readOnly: true,
    });
    await fb.previewUrl(sb, 3000);
    await fb.health();

    expect(primary.calls).toEqual(["createSandbox"]);
    expect(fallback.calls).toContain("createSandbox");
    for (const call of [
      "findSandbox",
      "startRunner",
      "runnerState",
      "putFiles",
      "getFile",
      "runnerBusy",
      "deleteSandbox",
      "backupWorktree",
      "restoreWorktree",
      "mountCache",
      "previewUrl",
      "health",
    ]) {
      expect(fallback.calls).toContain(call);
    }
  });

  it("does not fail over on a config error — wrong substrate can't fix it", async () => {
    const primary = recordingBackend("daytona", {
      createError: new VortexError({
        code: "CONFIG_ERROR",
        status: 500,
        message: "bad daytona config",
      }),
    });
    const fallback = recordingBackend("cloudflare");
    const fb = new FailoverBackend(primary.backend, fallback.backend);

    await expect(fb.createSandbox(createOpts)).rejects.toThrow(
      "bad daytona config"
    );
    expect(fb.kind).toBe("daytona");
    expect(fallback.calls).toEqual([]);
  });

  it("propagates the fallback's own create failure", async () => {
    const primary = recordingBackend("daytona", {
      createError: infra("daytona down"),
    });
    const fallback = recordingBackend("cloudflare", {
      createError: infra("lane pool wedged"),
    });
    const fb = new FailoverBackend(primary.backend, fallback.backend);

    await expect(fb.createSandbox(createOpts)).rejects.toThrow(
      "lane pool wedged"
    );
    expect(fb.kind).toBe("cloudflare");
  });

  it("returns safe defaults for optional methods the active backend lacks", async () => {
    const fallback = recordingBackend("cloudflare");
    const sparse: ComputeBackend = {
      kind: "cloudflare",
      createSandbox: vi.fn(async () => sandbox("sb-cf")),
      findSandbox: vi.fn(async () => null),
      startRunner: vi.fn(async () => {}),
      runnerState: vi.fn(async () => "running" as const),
      getFile: vi.fn(async () => null),
      putFiles: vi.fn(async () => {}),
      deleteSandbox: vi.fn(async () => {}),
      health: vi.fn(async () => ({ ok: true })),
    };
    const fb = new FailoverBackend(sparse, fallback.backend);
    const sb = sandbox("sb");

    expect(await fb.runnerBusy(sb, "s1")).toBe(false);
    expect(await fb.runnerLogs(sb, "s1")).toBeNull();
    await fb.waitForRunner(sb, "s1", 100); // resolves even when unimplemented
    await fb.deleteSandbox(sb);
    expect(await fb.backupWorktree(sb)).toBeNull();
    await expect(fb.restoreWorktree("n", "{}")).rejects.toThrow(
      "no restoreWorktree"
    );
    expect(
      await fb.mountCache(sb, {
        organizationId: "o",
        repo: "a/b",
        readOnly: false,
      })
    ).toBeNull();
    await fb.saveCache(sb, { organizationId: "o", repo: "a/b" });
    expect(await fb.previewUrl(sb, 3000)).toBeNull();
    expect(await fb.listSandboxes("vortex.")).toEqual([]);
  });
});

describe("computeBackend LANE_FAILOVER wiring", () => {
  it("wraps daytona with a lane-pool fallback when LANE_FAILOVER=v1 and a lane binding exists", () => {
    const { ns } = fakeLaneNs();
    const env = {
      ...baseEnv(),
      LANE_FAILOVER: "v1",
      SANDBOX_LANE: ns,
    } as AppEnv;
    const backend = computeBackend(env, "devin-cli");
    expect(backend).toBeInstanceOf(FailoverBackend);
    expect(backend.kind).toBe("daytona");
  });

  it("prefers the per-provider SANDBOX_LANE_* binding for the fallback", () => {
    const { ns } = fakeLaneNs();
    const env = {
      ...baseEnv(),
      LANE_FAILOVER: "v1",
      SANDBOX_LANE_DEVIN: ns,
    } as unknown as AppEnv;
    const backend = computeBackend(env, "devin-cli");
    expect(backend).toBeInstanceOf(FailoverBackend);
  });

  it("stays plain daytona when LANE_FAILOVER is unset or no lane binding exists", () => {
    const noFlag = computeBackend(
      { ...baseEnv(), SANDBOX_LANE: fakeLaneNs().ns } as AppEnv,
      "devin-cli"
    );
    expect(noFlag).not.toBeInstanceOf(FailoverBackend);
    expect(noFlag.kind).toBe("daytona");

    const noBinding = computeBackend(
      { ...baseEnv(), LANE_FAILOVER: "v1" } as AppEnv,
      "devin-cli"
    );
    expect(noBinding).not.toBeInstanceOf(FailoverBackend);
    expect(noBinding.kind).toBe("daytona");
  });
});
