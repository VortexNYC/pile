import { describe, expect, it } from "vitest";

import {
  parseReviewSummary,
  rollReviewSummary,
} from "../workspace/review-summary.js";
import {
  buildReviewPrompt,
  fetchRangeDiff,
  reviewPromptWithContext,
} from "./review-context.js";

const verdict = (reviewId: number, sha: string | null, excerpt = "") => ({
  reviewId,
  reviewer: "alice",
  state: "CHANGES_REQUESTED",
  sha,
  excerpt,
});

describe("rollReviewSummary", () => {
  it("orders by review id, dedupes, and tracks the newest reviewed sha", () => {
    let raw: string | null = null;
    raw = rollReviewSummary(
      raw,
      verdict(20, "bbb2222", "second")
    ).reviewSummary;
    const rolled = rollReviewSummary(raw, verdict(10, "aaa1111", "first"));
    expect(rolled.lastReviewedSha).toBe("bbb2222");
    const again = rollReviewSummary(
      rolled.reviewSummary,
      verdict(20, "bbb2222", "edited")
    );
    const verdicts = parseReviewSummary(again.reviewSummary);
    expect(verdicts.map((v) => v.reviewId)).toEqual([10, 20]);
    expect(verdicts[1]?.excerpt).toBe("edited");
  });

  it("caps the snapshot and truncates long excerpts", () => {
    let raw: string | null = null;
    for (let i = 1; i <= 25; i++) {
      raw = rollReviewSummary(
        raw,
        verdict(i, `sha${i}`, "x".repeat(400))
      ).reviewSummary;
    }
    const verdicts = parseReviewSummary(raw);
    expect(verdicts).toHaveLength(20);
    expect(verdicts[0]?.reviewId).toBe(6);
    expect(verdicts[0]?.excerpt.length).toBeLessThanOrEqual(280);
  });

  it("treats corrupt blobs as empty", () => {
    expect(parseReviewSummary("not-json")).toEqual([]);
    expect(parseReviewSummary(JSON.stringify({ verdicts: "x" }))).toEqual([]);
  });
});

describe("fetchRangeDiff", () => {
  it("narrows the GitHub compare payload", async () => {
    const paths: string[] = [];
    const range = await fetchRangeDiff(
      async (path) => {
        paths.push(path);
        return {
          status: "ahead",
          total_commits: 2,
          commits: [
            { sha: "c1c1c1c1", commit: { message: "fix null check\n\nbody" } },
            { sha: "c2c2c2c2", commit: { message: "add test" } },
          ],
          files: [
            {
              filename: "src/a.ts",
              status: "modified",
              additions: 3,
              deletions: 1,
            },
          ],
        };
      },
      "o/r",
      "base111",
      "head222"
    );
    expect(paths).toEqual(["/repos/o/r/compare/base111...head222"]);
    expect(range?.commits[0]).toEqual({
      sha: "c1c1c1c1",
      subject: "fix null check",
    });
    expect(range?.files[0]?.filename).toBe("src/a.ts");
    expect(range?.totalCommits).toBe(2);
  });
});

describe("buildReviewPrompt", () => {
  const base = {
    reviewer: "bob",
    prUrl: "https://github.com/o/r/pull/1",
    state: "CHANGES_REQUESTED",
    body: "still missing the edge case",
  };

  it("is the plain review prompt on a first review", () => {
    const prompt = buildReviewPrompt({
      ...base,
      sha: "head222",
      prior: [],
      range: null,
    });
    expect(prompt).toBe(
      "bob reviewed https://github.com/o/r/pull/1 (changes_requested).\n" +
        "Review:\nstill missing the edge case\n" +
        "Read the review comments on the PR, address the feedback, and push."
    );
  });

  it("carries prior verdicts and only the range since the last review", () => {
    const prompt = buildReviewPrompt({
      ...base,
      sha: "head2222222",
      prior: [verdict(1, "base1111111", "needs a regression test")],
      range: {
        base: "base1111111",
        head: "head2222222",
        status: "ahead",
        totalCommits: 1,
        commits: [{ sha: "c1c1c1c1", subject: "add regression test" }],
        files: [
          {
            filename: "src/a.test.ts",
            status: "added",
            additions: 20,
            deletions: 0,
          },
        ],
      },
    });
    expect(prompt).toContain(
      "- alice changes_requested @base111: needs a regression test"
    );
    expect(prompt).toContain(
      "Changes since the last review (base111..head222, 1 commit):"
    );
    expect(prompt).toContain("- c1c1c1c add regression test");
    expect(prompt).toContain("- src/a.test.ts (added, +20/-0)");
    expect(prompt).toContain("Scope this round");
  });

  it("flags rewritten history and same-head re-reviews", () => {
    const diverged = buildReviewPrompt({
      ...base,
      sha: "head222",
      prior: [verdict(1, "base111")],
      range: {
        base: "base111",
        head: "head222",
        status: "diverged",
        totalCommits: 3,
        commits: [],
        files: [],
      },
    });
    expect(diverged).toContain("rewritten (force-push/rebase)");
    const same = buildReviewPrompt({
      ...base,
      sha: "base111",
      prior: [verdict(1, "base111")],
      range: null,
    });
    expect(same).toContain("No new commits since the last review (base111)");
  });
});

describe("reviewPromptWithContext", () => {
  it("uses only verdicts older than the review and skips the fetch without a range", async () => {
    const summary = rollReviewSummary(
      rollReviewSummary(null, verdict(1, "aaa1111", "first")).reviewSummary,
      verdict(3, "ccc3333", "later")
    ).reviewSummary;
    let fetched = 0;
    const prompt = await reviewPromptWithContext({
      reviewer: "bob",
      prUrl: "https://github.com/o/r/pull/1",
      state: "COMMENTED",
      body: "nit",
      reviewId: 2,
      sha: "bbb2222",
      reviewSummary: summary,
      repoFull: "o/r",
      ghGet: async () => {
        fetched++;
        throw new Error("boom");
      },
    });
    expect(fetched).toBe(1);
    expect(prompt).toContain("first");
    expect(prompt).not.toContain("later");
    // Fetch failure falls back to the git range hint.
    expect(prompt).toContain("git log aaa1111..bbb2222");
  });
});
