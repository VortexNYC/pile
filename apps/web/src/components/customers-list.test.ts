import { describe, expect, it } from "vitest";

import { PAGE_SIZE, rankedCounts, windowRows } from "./customers-list.js";

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
