import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { workspaceMigrations } from "./migrations.js";

// PILE-474 — drizzle's migrator runs journal entries, not map keys: a
// `const vN` added to the map but not the journal is dead code that
// silently never applies (v102/v103 shipped that way). Scan the source so
// declared consts, journal tags, and map refs can't drift apart. Node pool
// — workerd has no fs.
describe("workspaceMigrations source parity", () => {
  it("every declared vN const is journaled and mapped", () => {
    const src = readFileSync(
      new URL("./migrations.ts", import.meta.url),
      "utf8"
    );
    const num = (s: string) => Number(s);
    const byNum = (a: string, b: string) => num(a) - num(b);
    const declared = new Set(
      [...src.matchAll(/^const v(\d+) = /gm)].map((m) => m[1]!)
    );
    const journaled = new Set(
      workspaceMigrations.journal.entries.map((e) => e.tag.slice(1))
    );
    const mapped = new Set(
      [...src.matchAll(/m\d{4}: v(\d+)/g)].map((m) => m[1]!)
    );
    expect([...declared].sort(byNum)).toEqual([...journaled].sort(byNum));
    expect([...declared].sort(byNum)).toEqual([...mapped].sort(byNum));
  });
});
