import { describe, expect, it } from "vitest";

import { extractFactsFromMarkdown } from "./memory-extractor.js";

const defaults = { defaultEntityType: "issue", defaultEntityId: "VTX-1" };

describe("extractFactsFromMarkdown (PILE-617/627)", () => {
  it("extracts labeled lines into typed facts", () => {
    const out = extractFactsFromMarkdown({
      ...defaults,
      text: [
        "Fixed the ingest lane today.",
        "- **Root cause:** the sweep dropped heartbeat rows older than the lookback window",
        "- **Decision:** keep posting keys as SMIs instead of arrays",
        "**Lesson:** always stage generated files before contract:check runs",
      ].join("\n"),
    });
    expect(out).toEqual([
      {
        entityType: "issue",
        entityId: "VTX-1",
        kind: "root_cause",
        fact: "the sweep dropped heartbeat rows older than the lookback window",
      },
      {
        entityType: "issue",
        entityId: "VTX-1",
        kind: "decision",
        fact: "keep posting keys as SMIs instead of arrays",
      },
      {
        entityType: "issue",
        entityId: "VTX-1",
        kind: "lesson",
        fact: "always stage generated files before contract:check runs",
      },
    ]);
  });

  it("extracts bullets under known section headings", () => {
    const out = extractFactsFromMarkdown({
      ...defaults,
      text: [
        "# Result",
        "## Lessons",
        "- never await inside a pagination loop on the DO isolate",
        "- tombstones beat compaction for posting removal",
        "## Verification",
        "- 214 files / 2,032 tests green on the pre-push hook",
        "## Unrelated",
        "- this section is not a known kind and is ignored",
      ].join("\n"),
    });
    expect(out.map((f) => f.kind)).toEqual([
      "lesson",
      "lesson",
      "verification",
    ]);
    expect(out[1].fact).toBe("tombstones beat compaction for posting removal");
  });

  it("attributes workspace-scoped facts with leading identifiers to that issue", () => {
    const out = extractFactsFromMarkdown({
      defaultEntityType: "workspace",
      defaultEntityId: "org_1",
      text: "- **Decision:** VTX-42 gets the new billing table first because pilots need it",
    });
    expect(out).toEqual([
      {
        entityType: "issue",
        entityId: "VTX-42",
        kind: "decision",
        fact: "VTX-42 gets the new billing table first because pilots need it",
      },
    ]);
  });

  it("keeps default scoping for issue-scoped extraction even when identifiers appear", () => {
    const out = extractFactsFromMarkdown({
      ...defaults,
      text: "- **Lesson:** VTX-9's fix pattern also applies here across the board",
    });
    expect(out[0].entityId).toBe("VTX-1");
  });

  it("falls back to a single outcome fact for unstructured summaries", () => {
    const out = extractFactsFromMarkdown({
      ...defaults,
      text: "The deploy shipped the new search index and all probes came back green",
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("outcome");
    expect(out[0].fact).toContain("deploy shipped the new search index");
  });

  it("returns nothing for empty or trivial input", () => {
    expect(extractFactsFromMarkdown({ ...defaults, text: "ok" })).toEqual([]);
  });

  it("deduplicates and caps at maxFacts", () => {
    const bullets = Array.from(
      { length: 20 },
      (_, i) => `- **Lesson:** learned lesson number ${i} about the codebase`
    );
    bullets.push(bullets[0]); // exact duplicate
    const out = extractFactsFromMarkdown({
      ...defaults,
      text: bullets.join("\n"),
      maxFacts: 10,
    });
    expect(out).toHaveLength(10);
    const keys = new Set(out.map((f) => `${f.kind}${f.fact}`));
    expect(keys.size).toBe(out.length);
  });

  it("drops facts under 15 chars and truncates at 400", () => {
    const long = "x".repeat(500);
    const out = extractFactsFromMarkdown({
      ...defaults,
      text: `- **Lesson:** tiny\n- **Lesson:** ${long}`,
    });
    expect(out).toHaveLength(1);
    expect(out[0].fact.length).toBeLessThanOrEqual(400);
  });
});
