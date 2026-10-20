import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { workspaceIssues } from "./schema.js";
import { inArrayJson, notInArrayJson } from "./sql.js";

const dialect = new SQLiteSyncDialect();

describe("inArrayJson / notInArrayJson (PILE-448)", () => {
  it("binds the whole list as one json_each param, not one ? per id", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `id-${i}`);
    const query = dialect.sqlToQuery(inArrayJson(workspaceIssues.id, ids));
    expect(query.sql).toBe('"issues"."id" in (select value from json_each(?))');
    expect(query.params).toEqual([JSON.stringify(ids)]);
  });

  it("compiles NOT IN the same way", () => {
    const query = dialect.sqlToQuery(
      notInArrayJson(workspaceIssues.id, ["a", "b"])
    );
    expect(query.sql).toBe(
      '"issues"."id" not in (select value from json_each(?))'
    );
    expect(query.params).toEqual([JSON.stringify(["a", "b"])]);
  });
});
