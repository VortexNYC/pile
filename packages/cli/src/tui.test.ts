import { describe, expect, it } from "vitest";

import { tuiUnavailableError } from "./tui.js";

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
