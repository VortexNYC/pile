import { describe, expect, it } from "vitest";

import { rankedCounts } from "./customers-list.js";

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
