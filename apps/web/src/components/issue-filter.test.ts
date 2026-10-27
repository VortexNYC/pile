import { describe, expect, it } from "vitest";

import { EMPTY_FILTER, filterActiveCount } from "./issue-filter";

describe("filterActiveCount", () => {
  it("counts active filters across all groups", () => {
    expect(filterActiveCount(EMPTY_FILTER)).toBe(0);
    expect(
      filterActiveCount({
        ...EMPTY_FILTER,
        statuses: ["todo", "in_progress"],
        assignees: ["u1"],
      })
    ).toBe(3);
  });
});
