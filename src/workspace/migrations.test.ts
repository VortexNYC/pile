import { describe, expect, it } from "vitest";

import { workspaceMigrations } from "./migrations.js";

describe("workspaceMigrations", () => {
  it("keeps journal entries and migration bodies aligned and ordered", () => {
    const { entries } = workspaceMigrations.journal;
    const keys = Object.keys(workspaceMigrations.migrations);
    expect(keys).toHaveLength(entries.length);
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
    const last = workspaceMigrations.journal.entries.at(-1);
    expect(last?.tag).toBe("v51");
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
