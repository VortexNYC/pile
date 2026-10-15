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
