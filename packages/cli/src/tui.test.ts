import { describe, expect, it, vi } from "vitest";

import { checkTuiSupport, tuiUnavailableError } from "./tui.js";

const createCliRenderer = vi.fn(() => {
  throw new Error("tui-check must not set up a terminal");
});
const resolveRenderLib = vi.fn(() => ({}));

vi.mock("@opentui/core", () => ({
  createCliRenderer,
  resolveRenderLib,
}));

describe("checkTuiSupport", () => {
  it("probes the native library without terminal setup", async () => {
    await expect(checkTuiSupport()).resolves.toBeUndefined();

    expect(resolveRenderLib).toHaveBeenCalledOnce();
    expect(createCliRenderer).not.toHaveBeenCalled();
  });

  it("rejects when the native library cannot initialize", async () => {
    resolveRenderLib.mockImplementationOnce(() => {
      throw new Error(
        "Failed to initialize OpenTUI render library: missing libopentui.so"
      );
    });

    await expect(checkTuiSupport()).rejects.toThrow("missing libopentui.so");
    expect(createCliRenderer).not.toHaveBeenCalled();
  });
});

describe("tuiUnavailableError", () => {
  it("names the unbundled-module failure a broken compiled binary produces", () => {
    const error = tuiUnavailableError(
      "pile fleet",
      new Error("Cannot find module '@opentui/core' from '/$bunfs/root/pile'")
    );
    expect(error.message).toContain("pile fleet");
    expect(error.message).toContain("does not include OpenTUI");
    expect(error.message).toContain("release");
  });

  it("matches Node's wording for an uninstalled @opentui package", () => {
    const error = tuiUnavailableError(
      "pile inbox",
      new Error(
        "Cannot find package '@opentui/core-linux-x64' imported from /x/tui.js"
      )
    );
    expect(error.message).toContain("does not include OpenTUI");
  });

  it("keeps the terminal-runtime hint for other failures", () => {
    const cause = new Error("dlopen(libopentui.so) failed");
    const error = tuiUnavailableError("pile support", cause);
    expect(error.message).toContain("pile support");
    expect(error.message).toContain("interactive terminal");
    expect(error.message).toContain("dlopen(libopentui.so) failed");
    expect(error.cause).toBe(cause);
  });
});
