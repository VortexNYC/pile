import { describe, expect, it, vi } from "vitest";

import { LaneSandboxBase } from "./lane-sandbox.js";

// PILE-457 — drive the lane DO against a fake container: exec calls are
// recorded and the Files/DirectoryBackup collaborators are plain stubs
// injected past the TS-private fields, so the test asserts the
// container-facing contract, not the shim's wire format.

function fakeLane() {
  const container = {
    running: false,
    start: vi.fn(async () => {
      container.running = true;
    }),
    destroy: vi.fn(async () => {
      container.running = false;
    }),
    setInactivityTimeout: vi.fn(async () => {}),
    exec: vi.fn((_argv: string[]) =>
      Promise.resolve({
        output: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      })
    ),
  };
  const files = { writeFile: vi.fn(async () => {}) };
  const backups = {
    intercept: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
  };
  // DurableObjectBase's constructor requires a real DurableObjectState, so
  // the instance is assembled without it — the methods under test only
  // touch these fields.
  const lane = Object.create(LaneSandboxBase.prototype) as LaneSandboxBase;
  Object.assign(lane, { container, files, backups });
  return { lane, container, files, backups };
}

describe("LaneSandboxBase.spawn", () => {
  it("creates PROC_DIR before writing the wrapper script (PILE-457)", async () => {
    const order: string[] = [];
    const { lane, container, files } = fakeLane();
    container.exec.mockImplementation((argv: string[]) => {
      order.push(`exec:${argv.join(" ")}`);
      return Promise.resolve({
        output: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }),
      });
    });
    files.writeFile.mockImplementation(async () => {
      order.push("writeFile");
    });

    await lane.spawn({ processId: "sess-1", command: "python3 run.py" });

    // The Files API doesn't create parent dirs — without the mkdir the
    // first spawn on a fresh container loses its wrapper script.
    const mkdir = order.findIndex((o) =>
      o.startsWith("exec:mkdir -p /tmp/pile/proc")
    );
    const write = order.indexOf("writeFile");
    expect(mkdir).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(mkdir);
    expect(files.writeFile).toHaveBeenCalledWith(
      "/tmp/pile/proc/sess-1.sh",
      expect.stringContaining("python3 run.py")
    );
    // The detached launcher still runs after the write.
    expect(
      order.some((o) => o.includes("nohup /tmp/pile/proc/sess-1.sh"))
    ).toBe(true);
  });
});

describe("LaneSandboxBase.restoreWorktreeDir", () => {
  it("replaces /root/repo instead of merging into it (PILE-457)", async () => {
    const { lane, container, backups } = fakeLane();

    await lane.restoreWorktreeDir('{"v":1}');

    // cp -a src dst nests to dst/pile-worktree when dst exists — the copy
    // must remove the stale tree first.
    expect(container.exec).toHaveBeenCalledWith(
      [
        "sh",
        "-c",
        "mkdir -p /root && rm -rf /root/repo && cp -a /tmp/pile-worktree /root/repo",
      ],
      { env: expect.objectContaining({ HOME: "/root" }) }
    );
    expect(backups.restore).toHaveBeenCalledWith(
      { v: 1 },
      { dir: "/tmp/pile-worktree" }
    );
  });
});
