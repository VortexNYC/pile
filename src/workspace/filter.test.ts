import { describe, expect, it } from "vitest";

import { filterConditionSchema, filterToSql } from "./filter.js";

describe("issue filter conditions", () => {
  it("accepts delegateId as a filterable field (PILE-417)", () => {
    const filter = filterConditionSchema.parse({
      op: "eq",
      field: "delegateId",
      value: "devin",
    });
    expect(filter).toEqual({
      op: "eq",
      field: "delegateId",
      value: "devin",
    });
    // The field resolves to the issues.delegate_id column and compiles.
    expect(filterToSql(filter)).toBeDefined();
  });

  it("supports null comparisons on delegateId", () => {
    const filter = filterConditionSchema.parse({
      op: "ne",
      field: "delegateId",
      value: null,
    });
    expect(filterToSql(filter)).toBeDefined();
  });
});
