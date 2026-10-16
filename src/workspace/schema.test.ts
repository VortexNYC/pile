import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import {
  workspaceAgentSessions,
  workspaceCustomers,
  workspaceDeals,
  workspaceEntityAttachments,
  workspaceGuidancePacks,
  workspaceIssues,
  workspaceNotificationPreferences,
  workspaceStageTemplates,
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

  it("keeps plan nullable — most sessions never publish a checklist (PILE-426)", () => {
    const column = workspaceAgentSessions.plan;
    expect(column.name).toBe("plan");
    expect(column.notNull).toBe(false);
    expect(column.dataType).toBe("string");
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

describe("workspaceNotificationPreferences schema", () => {
  it("keeps email_explicit as a not-null default-on tri-state flag", () => {
    // PILE-320 — `email` is only a choice when email_explicit is set; the
    // column defaults true so rows that predate it keep their stored
    // `email` value instead of silently falling into the new default-on.
    const column = workspaceNotificationPreferences.emailExplicit;
    expect(column.name).toBe("email_explicit");
    expect(column.notNull).toBe(true);
    const config = getTableConfig(workspaceNotificationPreferences);
    const explicit = config.columns.find((c) => c.name === "email_explicit");
    expect(explicit?.hasDefault).toBe(true);
  });
});

describe("pipeline hygiene columns (PILE-402)", () => {
  const hygiene = [
    "next_step_text",
    "next_step_due_at",
    "needs_human",
    "needs_human_reason",
    "priority_score",
  ];

  it.each`
    table
    ${"customers"}
    ${"deals"}
  `("keeps hygiene + external_id columns nullable on $table", ({ table }) => {
    const schema = table === "customers" ? workspaceCustomers : workspaceDeals;
    const config = getTableConfig(schema);
    const names = config.columns.map((c) => c.name);
    for (const col of ["external_id", ...hygiene]) {
      const column = config.columns.find((c) => c.name === col);
      expect(names).toContain(col);
      // Every new column must be nullable — existing rows carry no value
      // and ingest may legitimately leave them unset.
      expect(column?.notNull).toBe(false);
    }
  });

  it.each`
    table
    ${"customers"}
    ${"deals"}
  `(
    "indexes (org, external_id) for the dedupe lookup on $table",
    ({ table }) => {
      const schema =
        table === "customers" ? workspaceCustomers : workspaceDeals;
      const config = getTableConfig(schema);
      const idx = config.indexes.find(
        (i) => i.config.name === `${table}_external_id_idx`
      );
      expect(idx).toBeDefined();
      const columns = idx?.config.columns.map((c) =>
        "name" in c ? c.name : String(c)
      );
      expect(columns).toEqual(["organization_id", "external_id"]);
    }
  );
});

describe("workspaceIssues schema", () => {
  it("keeps delegate_id nullable beside assignee_id (PILE-417)", () => {
    const config = getTableConfig(workspaceIssues);
    const column = config.columns.find((c) => c.name === "delegate_id");
    // Nullable: issues created before the delegate edge existed carry no
    // value, and an issue without an agent delegate is the common case.
    expect(column?.notNull).toBe(false);
    expect(
      config.indexes.some((i) => i.config.name === "idx_issues_delegate")
    ).toBe(true);
  });

  it("carries the claim/lease columns (PILE-430)", () => {
    const config = getTableConfig(workspaceIssues);
    const byName = (name: string) =>
      config.columns.find((c) => c.name === name);
    // Holder + expiry stay nullable — an unclaimed issue is the common case.
    expect(byName("claimed_by")?.notNull).toBe(false);
    expect(byName("claimed_lease_expires_at")?.notNull).toBe(false);
    // The epoch is a fencing token: non-null with a 0 default so migrated
    // rows start unclaimed at epoch 0.
    const epoch = byName("claim_epoch");
    expect(epoch?.notNull).toBe(true);
    expect(epoch?.hasDefault).toBe(true);
  });
});

describe("workspaceGuidancePacks schema (PILE-423)", () => {
  it("scopes packs by level + key and versions every edit", () => {
    const config = getTableConfig(workspaceGuidancePacks);
    expect(config.name).toBe("guidance_packs");
    const names = config.columns.map((c) => c.name);
    for (const col of [
      "id",
      "organization_id",
      "name",
      "scope",
      "scope_key",
      "body",
      "links",
      "version",
      "created_by",
      "updated_by",
      "created_at",
      "updated_at",
    ]) {
      expect(names).toContain(col);
    }
    // scope_key stays nullable — workspace packs have no key.
    expect(workspaceGuidancePacks.scopeKey.notNull).toBe(false);
    expect(workspaceGuidancePacks.version.notNull).toBe(true);
  });

  it("keeps agent_sessions' guidance + step_key + plan nullable", () => {
    const names = ["guidance", "step_key", "plan"] as const;
    const columns = getTableConfig(workspaceAgentSessions).columns;
    for (const name of names) {
      expect(columns.find((c) => c.name === name)?.notNull).toBe(false);
    }
  });
});

describe("workspaceStageTemplates schema (PILE-411)", () => {
  it("keys templates by (org, entity_type, status, step_key)", () => {
    const config = getTableConfig(workspaceStageTemplates);
    expect(config.name).toBe("stage_templates");
    const names = config.columns.map((c) => c.name);
    for (const col of [
      "id",
      "organization_id",
      "entity_type",
      "status",
      "step_key",
      "title",
      "required",
      "owner_agent",
      "condition",
      "position",
      "team_id",
      "created_by",
      "created_at",
      "updated_at",
    ]) {
      expect(names).toContain(col);
    }
    // required defaults true — a step is required unless marked optional.
    const required = config.columns.find((c) => c.name === "required");
    expect(required?.notNull).toBe(true);
    expect(required?.hasDefault).toBe(true);
    // owner_agent/condition/team_id stay nullable.
    for (const col of ["owner_agent", "condition", "team_id"]) {
      expect(config.columns.find((c) => c.name === col)?.notNull).toBe(false);
    }
  });

  it("uniqueness on (org, entity, status, step) blocks duplicate defs", () => {
    const config = getTableConfig(workspaceStageTemplates);
    const unique = config.indexes.find(
      (i) => i.config.name === "stage_templates_status_step_idx"
    );
    expect(unique?.config.unique).toBe(true);
    const columns = unique?.config.columns.map((c) =>
      "name" in c ? c.name : String(c)
    );
    expect(columns).toEqual([
      "organization_id",
      "entity_type",
      "status",
      "step_key",
    ]);
  });

  it("marks issues materialized from templates via step_key columns", () => {
    const config = getTableConfig(workspaceIssues);
    const byName = (name: string) =>
      config.columns.find((c) => c.name === name);
    expect(byName("step_key")?.notNull).toBe(false);
    expect(byName("owner_agent")?.notNull).toBe(false);
    const required = byName("required");
    expect(required?.notNull).toBe(true);
    expect(required?.hasDefault).toBe(true);
  });
});
