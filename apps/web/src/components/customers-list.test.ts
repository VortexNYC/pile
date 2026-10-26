import { describe, expect, it } from "vitest";

import {
  ownerDisplayName,
  PAGE_SIZE,
  rankedCounts,
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

describe("ownerDisplayName (PILE-651)", () => {
  it("maps known owner ids to names and shortens unknown ones", () => {
    expect(ownerDisplayName("0r5mlhiV0owDDL59vzGnfTTqwNBuGHgE")).toBe("Shlomo");
    expect(ownerDisplayName("ecH8c2QyUL9IldR7F59YLtvG58s76UIh")).toBe("Ronny");
    expect(ownerDisplayName(null)).toBe("Unassigned");
    expect(ownerDisplayName("abc123def456")).toBe("abc123de");
  });
});
