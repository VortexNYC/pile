import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import type { Issue } from "../types/workspace.js";
import type { ComputeSandbox } from "./compute.js";
import { DevinCliAgentProvider } from "./devin-cli.js";
import { isTransientStartError, laneCacheReadOnly } from "./sandbox-cli.js";

const files = new Map<string, string>();
const sandbox: ComputeSandbox = {
  id: "sb-1",
  name: "vortex-devin-sess1",
  state: "started",
  organizationId: "org-1",
  runnerEnv: {
    ISSUE_IDENTIFIER: "VOR-631",
    REPO: "",
    BRANCH: "issue-x",
    ISSUE_TITLE: "Dispute money-movement leg",
  },
};

const fakeBackend = {
  findSandbox: vi.fn(async () => sandbox),
  runnerState: vi.fn(async () => ({ state: "exited" as const, exitCode: 1 })),
  runnerBusy: vi.fn(async () => false),
  readFile: vi.fn(
    async (_s: ComputeSandbox, path: string) => files.get(path) ?? null
  ),
  writeFile: vi.fn(
    async (_s: ComputeSandbox, path: string, content: string) => {
      files.set(path, content);
    }
  ),
  startRunner: vi.fn(async () => undefined),
  deleteSandbox: vi.fn(async () => undefined),
};

function env(): AppEnv {
  return {
    DEVIN_CLI_CREDENTIALS_B64: btoa('token = "devin-session-token$test"'),
  } as unknown as AppEnv;
}

const TRUNCATED_RESULT = JSON.stringify({
  status: "failed",
  result:
    "devin -p failed (1): …deep analysis… warning: response truncated " +
    "(model hit max output token limit) Error: Response truncated",
});

describe("truncation continuation (VOR-631)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeBackend.findSandbox.mockResolvedValue(sandbox);
    fakeBackend.runnerState.mockResolvedValue({
      state: "exited" as const,
      exitCode: 1,
    });
  });

  it("continues a truncated lane in its kept sandbox instead of failing", async () => {
    files.clear();
    files.set("/tmp/agent-result.json", TRUNCATED_RESULT);
    fakeBackend.runnerBusy.mockResolvedValue(false);
    const provider = new DevinCliAgentProvider(env());
    // descriptor seam — replaces the env-derived backend for this provider
    (provider as unknown as { d: { compute: unknown } }).d.compute =
      fakeBackend;
    const polled = await provider.poll("sess1");
    expect(polled.status).toBe("running");
    // A continuation run was started via sendPrompt.
    expect(fakeBackend.startRunner).toHaveBeenCalledOnce();
    expect(files.get("/tmp/pile-continuations")).toBe("1");
    // The old result is still on disk — the running continuation overwrites it.
  });

  it("fails for real once the continuation cap is spent", async () => {
    files.clear();
    files.set("/tmp/agent-result.json", TRUNCATED_RESULT);
    files.set("/tmp/pile-continuations", "2");
    fakeBackend.runnerBusy.mockResolvedValue(false);
    const provider = new DevinCliAgentProvider(env());
    // descriptor seam — replaces the env-derived backend for this provider
    (provider as unknown as { d: { compute: unknown } }).d.compute =
      fakeBackend;
    const polled = await provider.poll("sess1");
    expect(polled.status).toBe("failed");
    expect(fakeBackend.startRunner).not.toHaveBeenCalled();
  });

  it("stays running without re-dispatching while a continuation is in flight", async () => {
    files.clear();
    files.set("/tmp/agent-result.json", TRUNCATED_RESULT);
    fakeBackend.runnerBusy.mockResolvedValue(true);
    const provider = new DevinCliAgentProvider(env());
    // descriptor seam — replaces the env-derived backend for this provider
    (provider as unknown as { d: { compute: unknown } }).d.compute =
      fakeBackend;
    const polled = await provider.poll("sess1");
    expect(polled.status).toBe("running");
    expect(fakeBackend.startRunner).not.toHaveBeenCalled();
    expect(files.has("/tmp/pile-continuations")).toBe(false);
  });
});

describe("lane cache write policy (PILE-306)", () => {
  it("lets only fully trusted lanes write the shared cache", () => {
    expect(laneCacheReadOnly({ shell: "enabled", push: "enabled" })).toBe(
      false
    );
    expect(laneCacheReadOnly({ shell: "restricted", push: "enabled" })).toBe(
      true
    );
    expect(laneCacheReadOnly({ shell: "enabled", push: "disabled" })).toBe(
      true
    );
    expect(laneCacheReadOnly({ shell: "disabled", push: "disabled" })).toBe(
      true
    );
  });
});

function followupIssue(): Issue {
  return {
    id: "iss-1",
    identifier: "PILE-306",
    title: "Lane cache",
    repo: "acme/widgets",
  } as Issue;
}

describe("lane cache on follow-ups (PILE-306)", () => {
  it("mounts the repo cache for a restored lane and hands the runner PILE_CACHE_DIR", async () => {
    const restored: ComputeSandbox = {
      ...sandbox,
      runnerEnv: { ...sandbox.runnerEnv },
    };
    const backend = {
      ...fakeBackend,
      findSandbox: vi.fn(async () => null),
      restoreWorktree: vi.fn(async () => restored),
      runnerBusy: vi.fn(async () => false),
      mountCache: vi.fn(async () => "/mnt/pile-cache"),
      startRunner: vi.fn(
        async (
          _s: ComputeSandbox,
          _id: string,
          _cmd: string,
          _env?: Record<string, string>
        ) => undefined
      ),
    };
    const provider = new DevinCliAgentProvider(env());
    const seam = provider as unknown as {
      d: { compute: unknown };
      followupPermissions: () => Promise<unknown>;
      githubToken: () => Promise<unknown>;
    };
    seam.d.compute = backend;
    vi.spyOn(seam, "followupPermissions").mockResolvedValue({
      shell: "restricted",
      push: "enabled",
    });
    vi.spyOn(seam, "githubToken").mockResolvedValue({ token: "ghs_test" });

    const sent = await provider.sendPrompt(
      "sess1",
      "keep going",
      followupIssue(),
      null,
      { organizationId: "org-1", backupRef: "backup-1" }
    );

    expect(sent).toBe(true);
    expect(backend.mountCache).toHaveBeenCalledWith(restored, {
      organizationId: "org-1",
      repo: "acme/widgets",
      readOnly: true,
    });
    expect(backend.startRunner).toHaveBeenCalledWith(
      restored,
      expect.stringContaining("sess1-fu-"),
      expect.any(String),
      expect.objectContaining({
        FOLLOWUP: "1",
        PILE_CACHE_DIR: "/mnt/pile-cache",
      })
    );
  });

  it("mounts for a live sandbox whose record lacks the org, using the caller's", async () => {
    const live: ComputeSandbox = {
      id: "sb-1",
      name: "vortex-devin-sess1",
      state: "started",
    };
    const backend = {
      ...fakeBackend,
      findSandbox: vi.fn(async () => live),
      runnerBusy: vi.fn(async () => false),
      mountCache: vi.fn(async () => "/mnt/pile-cache"),
      startRunner: vi.fn(
        async (
          _s: ComputeSandbox,
          _id: string,
          _cmd: string,
          _env?: Record<string, string>
        ) => undefined
      ),
    };
    const provider = new DevinCliAgentProvider(env());
    const seam = provider as unknown as {
      d: { compute: unknown };
      followupPermissions: () => Promise<unknown>;
      githubToken: () => Promise<unknown>;
    };
    seam.d.compute = backend;
    vi.spyOn(seam, "followupPermissions").mockResolvedValue({
      shell: "enabled",
      push: "enabled",
    });
    vi.spyOn(seam, "githubToken").mockResolvedValue({ token: "ghs_test" });

    await provider.sendPrompt("sess1", "again", followupIssue(), null, {
      organizationId: "org-9",
    });

    expect(backend.mountCache).toHaveBeenCalledWith(live, {
      organizationId: "org-9",
      repo: "acme/widgets",
      readOnly: false,
    });
    expect(backend.startRunner.mock.calls[0]?.[3]).toMatchObject({
      PILE_CACHE_DIR: "/mnt/pile-cache",
    });
  });

  it("leaves PILE_CACHE_DIR unset when the mount is unavailable", async () => {
    const backend = {
      ...fakeBackend,
      findSandbox: vi.fn(async () => sandbox),
      runnerBusy: vi.fn(async () => false),
      mountCache: vi.fn(async () => null),
      startRunner: vi.fn(
        async (
          _s: ComputeSandbox,
          _id: string,
          _cmd: string,
          _env?: Record<string, string>
        ) => undefined
      ),
    };
    const provider = new DevinCliAgentProvider(env());
    const seam = provider as unknown as {
      d: { compute: unknown };
      followupPermissions: () => Promise<unknown>;
      githubToken: () => Promise<unknown>;
    };
    seam.d.compute = backend;
    vi.spyOn(seam, "followupPermissions").mockResolvedValue({
      shell: "enabled",
      push: "enabled",
    });
    vi.spyOn(seam, "githubToken").mockResolvedValue({ token: "ghs_test" });

    await provider.sendPrompt("sess1", "again", followupIssue());

    expect(backend.mountCache).toHaveBeenCalledWith(
      sandbox,
      expect.objectContaining({ readOnly: false })
    );
    const runnerEnv = backend.startRunner.mock.calls[0]?.[3];
    expect(runnerEnv).toBeDefined();
    expect(runnerEnv).not.toHaveProperty("PILE_CACHE_DIR");
  });
});

describe("sandbox-cli (PILE-452 coverage)", () => {
  it("module loads without throwing", async () => {
    const mod = await import("./sandbox-cli.js");
    expect(mod).toBeTruthy();
  });
});

// PILE-466 — transient Daytona start failures retry inside the provision
// budget instead of killing the lane on the first error.
const agentError = (message: string, status = 502) =>
  new VortexError({ code: "AGENT_ERROR", status, message });

const createNotReady = () =>
  new VortexError({
    code: "AGENT_ERROR",
    status: 502,
    message:
      'Daytona sandbox create failed: 400 {"message":"sandbox exited with code 1 before becoming ready"}',
  });

const repolessIssue = (): Issue =>
  ({
    id: "issue-9",
    title: "No-repo task",
    description: "do it",
  }) as Issue;

// Stateful fake: a failed create leaves an error-state record behind (as
// Daytona does), and deleteSandbox removes it — `live` tracks orphans.
function startBackend(outcomes: (Error | ComputeSandbox)[]) {
  const live = new Map<string, ComputeSandbox>();
  let seq = 0;
  return {
    kind: "daytona" as const,
    findSandbox: vi.fn(async () => live.values().next().value ?? null),
    createSandbox: vi.fn(async () => {
      const outcome = outcomes[seq] ?? {
        id: `sb-${seq}`,
        name: "vortex-devin-sess1",
        state: "started",
      };
      seq++;
      if (outcome instanceof Error) {
        const dead: ComputeSandbox = {
          id: `sb-dead-${seq}`,
          name: "vortex-devin-sess1",
          state: "error",
        };
        live.set(dead.id, dead);
        throw outcome;
      }
      live.set(outcome.id, outcome);
      return outcome;
    }),
    startRunner: vi.fn(async () => undefined),
    waitForRunner: vi.fn(async () => undefined),
    runnerState: vi.fn(async () => ({ exitCode: 0 })),
    readFile: vi.fn(async () => null),
    writeFile: vi.fn(async () => undefined),
    deleteSandbox: vi.fn(async (s: ComputeSandbox) => {
      live.delete(s.id);
    }),
    health: vi.fn(async () => ({ ok: true })),
    live,
  };
}

function providerWith(backend: unknown) {
  const provider = new DevinCliAgentProvider(env());
  const seam = provider as unknown as {
    d: { compute: unknown };
    note: (...args: unknown[]) => Promise<void>;
  };
  seam.d.compute = backend;
  return { provider, seam };
}

describe("isTransientStartError (PILE-466)", () => {
  it("classifies the transient Daytona start signatures", () => {
    expect(
      isTransientStartError(
        agentError(
          'Daytona sandbox create failed: 400 {"message":"sandbox exited with code 1 before becoming ready"}'
        )
      )
    ).toBe(true);
    expect(
      isTransientStartError(
        agentError(
          "Daytona process session create failed: 400 SANDBOX_NOT_RUNNING"
        )
      )
    ).toBe(true);
    expect(
      isTransientStartError(
        agentError("Daytona sandbox failed: failed to resolve container IP")
      )
    ).toBe(true);
    expect(
      isTransientStartError(agentError("sandbox list timed out after 30s", 504))
    ).toBe(true);
    expect(
      isTransientStartError(
        agentError("Daytona sandbox did not start in time", 504)
      )
    ).toBe(true);
    expect(
      isTransientStartError(
        agentError("Daytona sandbox list failed: 503 unavailable")
      )
    ).toBe(true);
    expect(
      isTransientStartError(
        new Error("The operation was aborted due to timeout")
      )
    ).toBe(true);
    expect(
      isTransientStartError(
        new DOMException("signal timed out", "TimeoutError")
      )
    ).toBe(true);
  });

  it("rejects config, quota, and permission failures", () => {
    expect(
      isTransientStartError(
        agentError("Daytona sandbox create failed: 400 invalid env", 400)
      )
    ).toBe(false);
    expect(
      isTransientStartError(
        agentError("Daytona sandbox create failed: 429 quota exceeded")
      )
    ).toBe(false);
    expect(
      isTransientStartError(
        new VortexError({
          code: "FORBIDDEN",
          status: 403,
          message: "lane may not push",
        })
      )
    ).toBe(false);
    expect(isTransientStartError(new Error("boom"))).toBe(false);
  });
});

describe("sandbox start retries (PILE-466)", () => {
  it("retries a transient create failure and deletes the failed sandbox", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const live: ComputeSandbox = {
        id: "sb-live",
        name: "vortex-devin-sess1",
        state: "started",
      };
      const backend = startBackend([createNotReady(), live]);
      const { provider, seam } = providerWith(backend);
      const noteSpy = vi.spyOn(seam, "note");

      const waits: Promise<unknown>[] = [];
      const result = await provider.dispatch(
        "org-1",
        repolessIssue(),
        "swe-2",
        {
          sessionId: "sess-1",
          waitUntil: (p) => waits.push(p),
        }
      );
      expect(result.status).toBe("created");

      await vi.advanceTimersByTimeAsync(5_000); // first backoff: 5s (+0 jitter)
      await waits[0];

      expect(backend.createSandbox).toHaveBeenCalledTimes(2);
      expect(backend.deleteSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sb-dead-1", state: "error" })
      );
      expect(backend.startRunner).toHaveBeenCalledOnce();
      expect(noteSpy).toHaveBeenCalledWith(
        "org-1",
        "sess-1",
        "status",
        "devin-cli sandbox start attempt 2/3 after: sandbox-not-ready",
        expect.objectContaining({
          attempt: 2,
          maxAttempts: 3,
          errorClass: "sandbox-not-ready",
          backoffMs: 5_000,
          deletedSandbox: true,
        }),
        expect.anything()
      );
      // Only the live sandbox remains — no orphan.
      expect([...backend.live.keys()]).toEqual(["sb-live"]);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("fails with the last error after three transient attempts, no orphan", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const backend = startBackend([
        createNotReady(),
        createNotReady(),
        createNotReady(),
      ]);
      const { provider } = providerWith(backend);

      const waits: Promise<unknown>[] = [];
      await provider.dispatch("org-1", repolessIssue(), "swe-2", {
        sessionId: "sess-1",
        waitUntil: (p) => waits.push(p),
      });
      const assertion = expect(waits[0]).rejects.toThrow(
        /before becoming ready/
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;

      expect(backend.createSandbox).toHaveBeenCalledTimes(3);
      expect(backend.deleteSandbox).toHaveBeenCalledTimes(3);
      expect(backend.live.size).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("fails a non-transient error immediately without retrying", async () => {
    const backend = startBackend([
      new VortexError({
        code: "AGENT_ERROR",
        status: 502,
        message:
          "Daytona sandbox create failed: 400 invalid environment variable",
      }),
    ]);
    const { provider } = providerWith(backend);

    await expect(
      provider.dispatch("org-1", repolessIssue(), "swe-2", {
        sessionId: "sess-1",
      })
    ).rejects.toThrow(/invalid environment variable/);
    expect(backend.createSandbox).toHaveBeenCalledTimes(1);
    expect(backend.live.size).toBe(0);
  });

  it("does not start another attempt when the provision budget is nearly spent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const slowTransient = async (): Promise<ComputeSandbox> => {
        // The attempt burned 260s of the 300s provision budget — no room
        // for another attempt after the 5s backoff.
        vi.setSystemTime(Date.now() + 260_000);
        throw createNotReady();
      };
      const backend = startBackend([]);
      backend.createSandbox.mockImplementation(slowTransient);
      const { provider, seam } = providerWith(backend);
      const noteSpy = vi.spyOn(seam, "note");

      const waits: Promise<unknown>[] = [];
      await provider.dispatch("org-1", repolessIssue(), "swe-2", {
        sessionId: "sess-1",
        waitUntil: (p) => waits.push(p),
      });
      const assertion = expect(waits[0]).rejects.toThrow(
        /before becoming ready/
      );
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;

      expect(backend.createSandbox).toHaveBeenCalledTimes(1);
      expect(backend.live.size).toBe(0);
      expect(noteSpy).not.toHaveBeenCalledWith(
        "org-1",
        "sess-1",
        "status",
        expect.stringContaining("sandbox start attempt"),
        expect.anything(),
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});

