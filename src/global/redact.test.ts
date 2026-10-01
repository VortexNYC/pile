import { describe, expect, it } from "vitest";

import { scrubLaneText } from "./redact.js";

describe("scrubLaneText", () => {
  it("masks git remote credentials and GitHub token shapes", () => {
    const remote = [
      "https://x-access-token",
      "ghs_abcdefghijklmnopqrstuv",
    ].join(":");
    const out = scrubLaneText(`fatal: ${remote}@github.com/acme/w.git`);
    expect(out).not.toContain("ghs_abcdefghijklmnopqrstuv");
    expect(out).toContain("[REDACTED]");
  });

  it("masks exact known secrets", () => {
    const laneToken = "a1b2c3d4e5f6a7b8c9d0";
    expect(scrubLaneText(`echo ${laneToken}`, [laneToken])).toBe(
      "echo [REDACTED]"
    );
  });

  it("ignores short or empty known secrets", () => {
    expect(scrubLaneText("plain log line", ["", null, "log"])).toBe(
      "plain log line"
    );
  });
});
