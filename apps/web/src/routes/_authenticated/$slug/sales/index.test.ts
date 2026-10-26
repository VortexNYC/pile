import { describe, expect, it } from "vitest";

import { isSalesTab, TABS } from "./index";

describe("sales tabs (PILE-651)", () => {
  it("includes the follow-ups surface gated on customer:view", () => {
    expect(TABS.map(([value]) => value)).toEqual([
      "deals",
      "companies",
      "contacts",
      "followups",
    ]);
    const followups = TABS.find(([value]) => value === "followups");
    expect(followups?.[1]).toBe("Follow-ups");
    expect(followups?.[2]).toBe("customer");
  });
});

describe("isSalesTab", () => {
  it("accepts known tabs and rejects junk", () => {
    expect(isSalesTab("followups")).toBe(true);
    expect(isSalesTab("deals")).toBe(true);
    expect(isSalesTab("nope")).toBe(false);
    expect(isSalesTab(undefined)).toBe(false);
  });
});
