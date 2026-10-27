import { describe, expect, it } from "vitest";

import {
  computeCostMicros,
  describeCapBreach,
  dayWindowStart,
  evaluateRunCaps,
  evaluateSpendCaps,
  monthWindowStart,
  runUsageSchema,
  spendCapBodySchema,
  type SpendWindowUsage,
} from "./spend.js";

const ZERO_USAGE: SpendWindowUsage = {
  runsPerDay: 0,
  runsPerMonth: 0,
  tokensPerDay: 0,
  tokensPerMonth: 0,
  costMicrosPerDay: 0,
  costMicrosPerMonth: 0,
};

describe("runUsageSchema", () => {
  it("accepts a full cumulative usage snapshot", () => {
    const parsed = runUsageSchema.safeParse({
      model: "claude-sonnet-4-5",
      inputTokens: 120_000,
      outputTokens: 8_500,
      toolCalls: 41,
      costMicros: 487_500,
      externalSpendMicros: 12_000,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects negative counts and unknown fields", () => {
    expect(runUsageSchema.safeParse({ inputTokens: -1 }).success).toBe(false);
    expect(runUsageSchema.safeParse({ tokens: 5 }).success).toBe(false);
    expect(runUsageSchema.safeParse({ inputTokens: 1.5 }).success).toBe(false);
  });
});

describe("spendCapBodySchema", () => {
  it("accepts explicit nulls so a PUT can clear limits", () => {
    const parsed = spendCapBodySchema.safeParse({
      maxTokensPerDay: null,
      maxCostMicrosPerRun: 500_000,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.maxTokensPerDay).toBeNull();
      expect(parsed.data.maxCostMicrosPerRun).toBe(500_000);
    }
  });

  it("rejects zero/negative run caps and unknown fields", () => {
    expect(spendCapBodySchema.safeParse({ maxRunsPerDay: 0 }).success).toBe(
      false
    );
    expect(spendCapBodySchema.safeParse({ dailyCap: 5 }).success).toBe(false);
  });
});

describe("evaluateSpendCaps", () => {
  it("returns no breaches when under every configured cap", () => {
    const breaches = evaluateSpendCaps(
      { maxTokensPerDay: 100_000, maxRunsPerDay: 10 },
      { ...ZERO_USAGE, tokensPerDay: 99_999, runsPerDay: 9 }
    );
    expect(breaches).toEqual([]);
  });

  it("breaches when usage hits the window budget exactly", () => {
    // The budget is spent — the next run would exceed it.
    const breaches = evaluateSpendCaps(
      { maxRunsPerDay: 3 },
      { ...ZERO_USAGE, runsPerDay: 3 }
    );
    expect(breaches).toEqual([
      { scope: "day", dimension: "runs", limit: 3, observed: 3 },
    ]);
  });

  it("flags daily and monthly window breaches independently", () => {
    const breaches = evaluateSpendCaps(
      {
        maxTokensPerDay: 100_000,
        maxCostMicrosPerMonth: 5_000_000,
      },
      {
        ...ZERO_USAGE,
        tokensPerDay: 120_500,
        costMicrosPerMonth: 6_100_000,
      }
    );
    expect(breaches).toEqual([
      {
        scope: "day",
        dimension: "tokens",
        limit: 100_000,
        observed: 120_500,
      },
      {
        scope: "month",
        dimension: "cost",
        limit: 5_000_000,
        observed: 6_100_000,
      },
    ]);
  });

  it("orders per-run breaches before window breaches", () => {
    const breaches = evaluateSpendCaps(
      { maxTokensPerRun: 50_000, maxRunsPerDay: 3 },
      { ...ZERO_USAGE, runsPerDay: 4, runTokens: 51_000 }
    );
    expect(breaches[0]).toMatchObject({
      scope: "run",
      dimension: "tokens",
    });
    expect(breaches[1]).toMatchObject({ scope: "day", dimension: "runs" });
  });

  it("treats unset caps and unset usage as uncapped", () => {
    expect(evaluateSpendCaps({}, { ...ZERO_USAGE, runsPerDay: 9999 })).toEqual(
      []
    );
    // Per-run caps don't trip when the lane never reported usage.
    expect(evaluateSpendCaps({ maxTokensPerRun: 1 }, ZERO_USAGE)).toEqual([]);
  });
});

describe("evaluateRunCaps", () => {
  it("flags only per-run breaches, ignoring window usage", () => {
    const breaches = evaluateRunCaps(
      { maxTokensPerRun: 50_000, maxCostMicrosPerRun: 500_000 },
      { totalTokens: 51_000, costMicros: 400_000 }
    );
    expect(breaches).toEqual([
      {
        scope: "run",
        dimension: "tokens",
        limit: 50_000,
        observed: 51_000,
      },
    ]);
  });

  it("does not trip when the lane never reported usage", () => {
    expect(evaluateRunCaps({ maxTokensPerRun: 1 }, {})).toEqual([]);
  });
});

describe("describeCapBreach", () => {
  it("formats token/run breaches with raw counts", () => {
    expect(
      describeCapBreach({
        scope: "day",
        dimension: "tokens",
        limit: 100_000,
        observed: 120_500,
      })
    ).toBe("daily tokens cap exceeded (120500/100000)");
  });

  it("formats cost breaches as dollars", () => {
    expect(
      describeCapBreach({
        scope: "run",
        dimension: "cost",
        limit: 500_000,
        observed: 612_340,
      })
    ).toBe("per-run cost cap exceeded ($0.61/$0.50)");
  });
});

describe("window bounds", () => {
  it("returns ISO day and month starts comparable to createdAt", () => {
    const now = new Date("2026-10-15T17:42:11.123Z");
    expect(dayWindowStart(now)).toBe("2026-10-15T00:00:00.000Z");
    expect(monthWindowStart(now)).toBe("2026-10-01T00:00:00.000Z");
    // A receipt created earlier today sits inside both windows.
    const receipt = "2026-10-15T09:00:00.000Z";
    expect(receipt >= dayWindowStart(now)).toBe(true);
    expect(receipt >= monthWindowStart(now)).toBe(true);
  });
});

describe("computeCostMicros", () => {
  it("computes sonnet-4-5 cost from the rate map", () => {
    // 3 USD/MTok input + 15 USD/MTok output == 3/15 micros per token.
    expect(computeCostMicros("claude-sonnet-4-5", 100_000, 10_000)).toBe(
      100_000 * 3 + 10_000 * 15
    );
  });

  it("matches dated model ids and prefers the longest key", () => {
    expect(computeCostMicros("claude-sonnet-4-5-20250929", 1_000_000, 0)).toBe(
      3_000_000
    );
    // gpt-5-mini must not match the gpt-5 rate.
    expect(computeCostMicros("gpt-5-mini", 1_000_000, 0)).toBe(250_000);
  });

  it("returns null for unknown models or missing token counts", () => {
    expect(computeCostMicros("mystery-model", 100, 100)).toBeNull();
    expect(computeCostMicros("claude-sonnet-4-5", null, null)).toBeNull();
    expect(computeCostMicros(null, 100, 100)).toBeNull();
  });

  it("parses a strict spend-cap body without unknown keys", () => {
    expect(
      spendCapBodySchema.safeParse({
        maxRunsPerDay: 10,
        maxCostMicrosPerMonth: 1_000_000,
      }).success
    ).toBe(true);
    expect(
      spendCapBodySchema.safeParse({ maxRunsPerDay: 10, bogus: 1 }).success
    ).toBe(false);
  });
});
