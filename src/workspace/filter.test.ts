import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { filterConditionSchema, filterToSql } from "./filter.js";

const dialect = new SQLiteSyncDialect();

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

  // PILE-448 — saved-view `in`/`notIn` filters carry caller-sized value
  // lists; binding one ? per value overflows DO SQLite's ~100 cap, so the
  // list goes through json_each as a single param.
  it("compiles `in`/`notIn` value lists as a single json_each param", () => {
    const values = Array.from({ length: 150 }, (_, i) => `TEST-${i}`);
    for (const op of ["in", "notIn"] as const) {
      const filter = filterConditionSchema.parse({
        op,
        field: "identifier",
        values,
      });
      const query = dialect.sqlToQuery(filterToSql(filter));
      expect(query.sql).toContain("json_each(?)");
      expect(query.params).toEqual([JSON.stringify(values)]);
    }
  });
});
