import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEnv } from "../platform/env.js";
import type { Issue } from "../types/workspace.js";
import type { ComputeSandbox } from "./compute.js";
import { DevinCliAgentProvider } from "./devin-cli.js";
import { laneCacheReadOnly } from "./sandbox-cli.js";

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
