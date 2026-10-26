import { describe, expect, it } from "vitest";

import {
  PAGE_SIZE,
  rankedCounts,
  rowSheetColor,
  windowRows,
} from "./customers-list.js";

describe("rankedCounts", () => {
  it("counts occurrences and ranks them descending", () => {
    expect(
      rankedCounts(["alice", "bob", "alice", "carol", "alice", "bob"])
    ).toEqual([
      ["alice", 3],
      ["bob", 2],
      ["carol", 1],
    ]);
  });

  it("returns an empty list for no keys", () => {
    expect(rankedCounts([])).toEqual([]);
  });
});

describe("windowRows (PILE-645)", () => {
  it("slices to the render window", () => {
    const rows = Array.from({ length: 100 }, (_, i) => i);
    expect(windowRows(rows, PAGE_SIZE)).toHaveLength(75);
    expect(windowRows(rows, PAGE_SIZE).at(-1)).toBe(74);
    expect(windowRows(rows.slice(0, 10), PAGE_SIZE)).toHaveLength(10);
  });
});

describe("rowSheetColor", () => {
  it("returns the hex stored for the row's classified sheet", () => {
    expect(
      rowSheetColor("trades", { trades: "#22c55e", tech: "#3b82f6" })
    ).toBe("#22c55e");
    expect(rowSheetColor("tech", { trades: "#22c55e" })).toBeUndefined();
  });

  it("ignores missing or non-palette values", () => {
    expect(rowSheetColor("trades", undefined)).toBeUndefined();
    expect(rowSheetColor("trades", {})).toBeUndefined();
    expect(rowSheetColor("trades", { trades: "green" })).toBeUndefined();
  });
});
