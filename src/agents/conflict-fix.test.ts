import { describe, expect, it } from "vitest";

import { parseFixResult } from "./conflict-fix.js";

describe("parseFixResult (PILE-476)", () => {
  it("accepts the rescue outcome a rejected push writes", () => {
    const parsed = parseFixResult(
      JSON.stringify({ outcome: "rescue", detail: "x-rescue-1" })
    );
    expect(parsed.outcome).toBe("rescue");
    expect(parsed.detail).toBe("x-rescue-1");
  });
  it("still maps unknown outcomes to failed", () => {
    expect(
      parseFixResult(JSON.stringify({ outcome: "weird" })).outcome
    ).toBe("failed");
  });
});
