import { describe, expect, it } from "vitest";

import {
  computeSemanticSimilarity,
  expandSemanticQuery,
  queryVectorizeMemories,
} from "./semantic-memory.js";

describe("expandSemanticQuery (PILE-613)", () => {
  it("expands concept groups so synonyms join the query", () => {
    const expanded = expandSemanticQuery("did we sweep smith corridor");
    expect(expanded).toContain("corridor");
    expect(expanded).toContain("merchant");
    expect(expanded).toContain("license");
    expect(expanded).toContain("leads");
  });

  it("adds morphological stems for inflected forms", () => {
    const expanded = expandSemanticQuery("swept retries crashed");
    expect(expanded).toContain("sweep");
    expect(expanded).toContain("retry");
    expect(expanded).toContain("crash");
  });

  it("expands OOM/crash concepts together", () => {
    const expanded = expandSemanticQuery("isolate heap crash");
    expect(expanded).toContain("oom");
    expect(expanded).toContain("memory");
    expect(expanded).toContain("crash");
  });
});

describe("computeSemanticSimilarity", () => {
  it("scores synonym-overlapping text above the recall threshold", () => {
    const score = computeSemanticSimilarity(
      "did we sweep smith corridor",
      "workspace issue corridor:smith-st swept yesterday"
    );
    expect(score).toBeGreaterThanOrEqual(0.22);
  });

  it("scores concept-adjacent crash/OOM text above threshold", () => {
    const score = computeSemanticSimilarity(
      "isolate heap crash",
      "OOM reset on large workspace"
    );
    expect(score).toBeGreaterThanOrEqual(0.22);
  });

  it("scores unrelated text below threshold", () => {
    const score = computeSemanticSimilarity(
      "did we sweep smith corridor",
      "the quarterly budget report was filed"
    );
    expect(score).toBeLessThan(0.22);
  });
});

describe("queryVectorizeMemories", () => {
  it("returns [] when bindings are absent", async () => {
    const ids = await queryVectorizeMemories({}, "org", "query");
    expect(ids).toEqual([]);
  });

  it("returns matched ids when AI + Vectorize respond", async () => {
    const ids = await queryVectorizeMemories(
      {
        AI: {
          run: async () => ({ data: [[0.1, 0.2, 0.3]] }),
        },
        MEMORY_VECTOR_INDEX: {
          query: async () => ({
            matches: [{ id: "mem-1", score: 0.9 }],
          }),
        },
      },
      "org",
      "query"
    );
    expect(ids).toEqual(["mem-1"]);
  });

  it("returns [] when the embedding call fails", async () => {
    const ids = await queryVectorizeMemories(
      {
        AI: {
          run: async () => {
            throw new Error("AI down");
          },
        },
        MEMORY_VECTOR_INDEX: {
          query: async () => ({ matches: [] }),
        },
      },
      "org",
      "query"
    );
    expect(ids).toEqual([]);
  });
});
