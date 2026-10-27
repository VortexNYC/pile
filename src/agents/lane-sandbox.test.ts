import { describe, expect, it, vi } from "vitest";

import { LaneSandboxBase } from "./lane-sandbox.js";

describe("LaneSandboxBase stopped-container guards", () => {
  it("returns false/null from hasProcess, probe, sessionBusy, processState, readFile, and tail when container.running is false", async () => {
    const execSpy = vi.fn(() => {
      throw new Error(
        "exec() cannot be called on a container that is not running."
      );
    });
    const instance = Object.assign(Object.create(LaneSandboxBase.prototype), {
      container: {
        running: false,
        exec: execSpy,
      },
    }) as LaneSandboxBase;

    expect(await instance.hasProcess("sess-1")).toBe(false);
    expect(await instance.probe(8787)).toBe(false);
    expect(await instance.sessionBusy("sess-1")).toBe(false);
    expect(await instance.processState("sess-1")).toEqual({
      running: false,
      exitCode: 1,
    });
    expect(await instance.readFile("/tmp/result.json")).toBeNull();
    expect(await instance.tail("/tmp/proc.log")).toBeNull();
    expect(execSpy).not.toHaveBeenCalled();
  });
});
