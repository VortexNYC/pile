import { describe, expect, it } from "vitest";

import { formatDealAmount } from "./deals-list";

describe("formatDealAmount", () => {
  it("renders an em-dash for missing amounts and formats cents", () => {
    expect(formatDealAmount(null, "USD")).toBe("—");
    expect(formatDealAmount(1200000, "USD")).toBe("$12,000.00");
    expect(formatDealAmount(500, null)).toBe("$5.00");
  });
});
