import { describe, expect, it } from "vitest";

import { workspaceMigrations } from "./migrations.js";

describe("workspaceMigrations", () => {
  it("keeps journal entries and migration bodies aligned and ordered", () => {
    const { entries } = workspaceMigrations.journal;
    const keys = Object.keys(workspaceMigrations.migrations);
    expect(keys).toHaveLength(entries.length);
    // Tail checks: a future migration appended without a journal entry (or
    // with the wrong tag) must fail here, not just mid-list.
    expect(entries.at(-1)?.tag).toBe(`v${entries.length}`);
    expect(keys.at(-1)).toBe(`m${String(entries.length - 1).padStart(4, "0")}`);
    const tags = new Set<string>();
    entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
      expect(entry.tag).toBe(`v${i + 1}`);
      expect(tags.has(entry.tag)).toBe(false);
      tags.add(entry.tag);
      expect(keys[i]).toBe(`m${String(i).padStart(4, "0")}`);
    });
  });

  it("v51 creates entity_attachments scoped by org + entity type/id", () => {
    expect(
      workspaceMigrations.journal.entries.some((e) => e.tag === "v51")
    ).toBe(true);
    const sql = workspaceMigrations.migrations.m0050;
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS entity_attachments");
    for (const col of [
      "organization_id",
      "entity_type",
      "entity_id",
      "r2_key",
      "content_type",
      "size",
    ]) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS entity_attachments_entity_idx ON entity_attachments (organization_id, entity_type, entity_id)"
    );
  });
});

describe("v71 pipeline hygiene", () => {
  it("adds external_id + hygiene columns and dedupe indexes", () => {
    const sql = workspaceMigrations.migrations.m0071;
    for (const table of ["customers", "deals"]) {
      for (const col of [
        "next_step_text",
        "next_step_due_at",
        "needs_human",
        "needs_human_reason",
        "priority_score",
      ]) {
        expect(sql).toContain(`ALTER TABLE ${table} ADD COLUMN ${col}`);
      }
      expect(sql).toContain(
        `CREATE INDEX IF NOT EXISTS ${table}_external_id_idx ON ${table} (organization_id, external_id)`
      );
    }
    expect(sql).toContain("ALTER TABLE deals ADD COLUMN external_id");
  });
});

describe("v73 delegate", () => {
  it("adds delegate_id to issues with a filter index", () => {
    const sql = workspaceMigrations.migrations.m0072;
    expect(sql).toContain("ALTER TABLE issues ADD COLUMN delegate_id TEXT");
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS idx_issues_delegate ON issues (delegate_id)"
    );
  });
});

describe("v74 claim lease", () => {
  it("adds claimed_by, lease expiry, and a non-null epoch to issues", () => {
    const sql = workspaceMigrations.migrations.m0073;
    expect(sql).toContain("ALTER TABLE issues ADD COLUMN claimed_by TEXT");
    expect(sql).toContain(
      "ALTER TABLE issues ADD COLUMN claimed_lease_expires_at TEXT"
    );
    expect(sql).toContain(
      "ALTER TABLE issues ADD COLUMN claim_epoch INTEGER NOT NULL DEFAULT 0"
    );
  });
});

describe("v76 agent type pause", () => {
  it("adds the paused hold flag and the agent_pauses table", () => {
    const sql = workspaceMigrations.migrations.m0075;
    expect(sql).toContain(
      "ALTER TABLE agent_sessions ADD COLUMN paused INTEGER NOT NULL DEFAULT 0"
    );
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_pauses");
    for (const col of ["organization_id", "agent_id", "reason", "created_by"]) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS agent_pauses_org_agent_idx ON agent_pauses (organization_id, agent_id)"
    );
  });
});

describe("v77 guidance packs", () => {
  it("creates guidance_packs + version history and the session columns", () => {
    const sql = workspaceMigrations.migrations.m0076;
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS guidance_packs");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS guidance_pack_versions");
    for (const col of ["organization_id", "scope", "scope_key", "version"]) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain(
      "ALTER TABLE agent_sessions ADD COLUMN guidance TEXT"
    );
    expect(sql).toContain(
      "ALTER TABLE agent_sessions ADD COLUMN step_key TEXT"
    );
  });
});

describe("v78 session plan", () => {
  it("adds the plan checklist column to agent_sessions", () => {
    expect(workspaceMigrations.migrations.m0077).toBe(
      "ALTER TABLE agent_sessions ADD COLUMN plan TEXT"
    );
  });
});

describe("v79 stage templates", () => {
  it("creates stage_templates keyed by (org, entity, status, step)", () => {
    const sql = workspaceMigrations.migrations.m0078;
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS stage_templates");
    for (const col of [
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
    ]) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS stage_templates_status_step_idx ON stage_templates (organization_id, entity_type, status, step_key)"
    );
  });

  it("marks sub-issues as materialized sub-steps", () => {
    const sql = workspaceMigrations.migrations.m0078;
    expect(sql).toContain("ALTER TABLE issues ADD COLUMN step_key TEXT");
    expect(sql).toContain(
      "ALTER TABLE issues ADD COLUMN required INTEGER NOT NULL DEFAULT 0"
    );
    expect(sql).toContain("ALTER TABLE issues ADD COLUMN owner_agent TEXT");
  });
});

describe("v80 external events (PILE-422)", () => {
  it("creates the mapping and delivery tables with their dedupe keys", () => {
    const sql = workspaceMigrations.migrations.m0079;
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS external_event_mappings");
    for (const col of [
      "organization_id",
      "source",
      "event_type",
      "entity_type",
      "match_path",
      "step_key",
      "secret",
      "enabled",
    ]) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS external_event_mappings_event_idx ON external_event_mappings (organization_id, source, event_type)"
    );

    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS external_event_deliveries"
    );
    for (const col of [
      "dedupe_key",
      "status",
      "entity_type",
      "entity_id",
      "completed_issue_ids",
      "payload",
    ]) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS external_event_deliveries_dedupe_idx ON external_event_deliveries (organization_id, source, dedupe_key)"
    );
  });
});

describe("v81 spend caps + run receipts (PILE-425)", () => {
  it("creates agent_spend_caps keyed by (org, agent) with window + per-run limits", () => {
    const sql = workspaceMigrations.migrations.m0080;
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_spend_caps");
    for (const col of [
      "organization_id",
      "agent_id",
      "max_runs_per_day",
      "max_runs_per_month",
      "max_tokens_per_day",
      "max_tokens_per_month",
      "max_cost_micros_per_day",
      "max_cost_micros_per_month",
      "max_tokens_per_run",
      "max_cost_micros_per_run",
      "last_cap_alert_at",
      "created_by",
    ]) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS agent_spend_caps_org_agent_idx ON agent_spend_caps (organization_id, agent_id)"
    );
  });

  it("creates agent_run_receipts keyed by session with aggregation indexes", () => {
    const sql = workspaceMigrations.migrations.m0080;
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_run_receipts");
    for (const col of [
      "session_id",
      "issue_id",
      "agent_id",
      "step_key",
      "deal_id",
      "model",
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "tool_calls",
      "cost_micros",
      "external_spend_micros",
      "cost_source",
      "cap_exceeded",
      "stop_reason",
      "duration_ms",
    ]) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS agent_run_receipts_session_idx ON agent_run_receipts (session_id)"
    );
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS agent_run_receipts_org_agent_idx ON agent_run_receipts (organization_id, agent_id, created_at)"
    );
    expect(sql).toContain(
      "CREATE INDEX IF NOT EXISTS agent_run_receipts_deal_idx ON agent_run_receipts (organization_id, deal_id)"
    );
  });
});
