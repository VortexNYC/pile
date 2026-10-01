import { describe, expect, it } from "vitest";

import {
  maxDurationSchema,
  parseEffortModels,
  resolveDispatchEffort,
} from "./budget.js";

describe("resolveDispatchEffort", () => {
  it("maps issue priority to an effort tier", () => {
    expect(resolveDispatchEffort(undefined, { priority: "low" })).toBe("low");
    expect(resolveDispatchEffort(undefined, { priority: "medium" })).toBe(
      "medium"
    );
    expect(resolveDispatchEffort(undefined, { priority: "high" })).toBe("high");
    expect(resolveDispatchEffort(undefined, { priority: "urgent" })).toBe(
      "max"
    );
    expect(resolveDispatchEffort(null, {})).toBe("medium");
  });

  it("prefers an explicit effort over priority", () => {
    expect(resolveDispatchEffort("low", { priority: "urgent" })).toBe("low");
  });
});

describe("parseEffortModels", () => {
  it("reads effortModels from provider config JSON", () => {
    expect(
      parseEffortModels(
        JSON.stringify({ timeout: 30, effortModels: { low: "m-lo" } })
      )
    ).toEqual({ low: "m-lo" });
  });

  it("returns null for missing, invalid, or malformed config", () => {
    expect(parseEffortModels(null)).toBeNull();
    expect(parseEffortModels("not-json")).toBeNull();
    expect(parseEffortModels(JSON.stringify({ timeout: 30 }))).toBeNull();
    expect(
      parseEffortModels(JSON.stringify({ effortModels: { cheap: "x" } }))
    ).toBeNull();
  });
});

describe("maxDurationSchema", () => {
  it("bounds the budget to 1..1440 whole minutes", () => {
    expect(maxDurationSchema.safeParse(30).success).toBe(true);
    expect(maxDurationSchema.safeParse(0).success).toBe(false);
    expect(maxDurationSchema.safeParse(1.5).success).toBe(false);
    expect(maxDurationSchema.safeParse(1441).success).toBe(false);
  });
});
