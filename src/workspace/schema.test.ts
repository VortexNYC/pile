import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { workspaceAgentSessions } from "./schema.js";

describe("workspaceAgentSessions schema", () => {
  it("keeps queuedAfter as a nullable edge column", () => {
    // PILE-260 — the blocker edge is written while the lane is parked and
    // survives promotion so an infra-retry can re-anchor to it. Nullable is
    // load-bearing: lanes dispatched with no queue have no edge.
    const column = workspaceAgentSessions.queuedAfter;
    expect(column.name).toBe("queued_after");
    expect(column.notNull).toBe(false);
    expect(column.dataType).toBe("string");
  });

  it("defaults infraFailure to 0 so the sweep can classify dead lanes", () => {
    const column = workspaceAgentSessions.infraFailure;
    expect(column.name).toBe("infra_failure");
    expect(column.notNull).toBe(true);
    const config = getTableConfig(workspaceAgentSessions);
    const infra = config.columns.find((c) => c.name === "infra_failure");
    expect(infra?.hasDefault).toBe(true);
  });
});
