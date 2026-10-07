import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import {
  workspaceAgentSessions,
  workspaceEntityAttachments,
} from "./schema.js";

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

describe("workspaceEntityAttachments schema", () => {
  it("scopes rows to an org + entity pair and keeps the R2 key", () => {
    const config = getTableConfig(workspaceEntityAttachments);
    expect(config.name).toBe("entity_attachments");
    const names = config.columns.map((c) => c.name);
    for (const col of [
      "id",
      "organization_id",
      "entity_type",
      "entity_id",
      "file_name",
      "content_type",
      "size",
      "r2_key",
      "created_by_id",
      "created_at",
    ]) {
      expect(names).toContain(col);
    }
    expect(workspaceEntityAttachments.organizationId.notNull).toBe(true);
    expect(workspaceEntityAttachments.entityType.notNull).toBe(true);
    expect(workspaceEntityAttachments.entityId.notNull).toBe(true);
    expect(workspaceEntityAttachments.r2Key.notNull).toBe(true);
    expect(workspaceEntityAttachments.createdById.notNull).toBe(false);
  });

  it("indexes the (org, entity type, entity id) lookup used by list/delete", () => {
    const config = getTableConfig(workspaceEntityAttachments);
    const idx = config.indexes.find(
      (i) => i.config.name === "entity_attachments_entity_idx"
    );
    expect(idx).toBeDefined();
    const columns = idx?.config.columns.map((c) =>
      "name" in c ? c.name : String(c)
    );
    expect(columns).toEqual(["organization_id", "entity_type", "entity_id"]);
  });
});
