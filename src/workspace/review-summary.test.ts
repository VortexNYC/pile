import { describe, expect, it } from "vitest";

import {
  evaluateReviewConvergence,
  parseReviewSummary,
  rollReviewSummary,
  type ReviewVerdict,
} from "./review-summary.js";

const verdict = (over: Partial<ReviewVerdict> = {}): ReviewVerdict => ({
  reviewId: 1,
  reviewer: "pile-review",
  state: "request-changes",
  sha: "abc",
  excerpt: "s",
  ...over,
});

describe("evaluateReviewConvergence (PILE-642)", () => {
  it("reports clean when the latest round approved with zero findings", () => {
    const c = evaluateReviewConvergence([
      verdict({ reviewId: 1, findingsCount: 3, fingerprints: ["a", "b", "c"] }),
      verdict({
        reviewId: 2,
        state: "approve",
        findingsCount: 0,
        fingerprints: [],
      }),
    ]);
    expect(c.status).toBe("clean");
    expect(c.oscillating).toBe(false);
    expect(c.resolvedFingerprints).toEqual(["a", "b", "c"]);
    expect(c.trajectory).toBe("3 → 0 findings (clean)");
  });

  it("reports converging when findings drop with no persisting fingerprints", () => {
    const c = evaluateReviewConvergence([
      verdict({ reviewId: 1, findingsCount: 3, fingerprints: ["a", "b", "c"] }),
      verdict({ reviewId: 2, findingsCount: 1, fingerprints: ["d"] }),
    ]);
    expect(c.status).toBe("converging");
    expect(c.persistingFingerprints).toEqual([]);
    expect(c.resolvedFingerprints).toEqual(["a", "b", "c"]);
  });

  it("reports stalled when findings hold flat on the same fingerprints", () => {
    const c = evaluateReviewConvergence([
      verdict({ reviewId: 1, findingsCount: 2, fingerprints: ["a", "b"] }),
      verdict({ reviewId: 2, findingsCount: 2, fingerprints: ["a", "b"] }),
    ]);
    expect(c.status).toBe("stalled");
    expect(c.persistingFingerprints).toEqual(["a", "b"]);
    // flat + persisting => oscillating flag per the spec
    expect(c.oscillating).toBe(true);
  });

  it("reports oscillating when findings grow or rebound across 3 rounds", () => {
    const growing = evaluateReviewConvergence([
      verdict({ reviewId: 1, findingsCount: 1 }),
      verdict({ reviewId: 2, findingsCount: 3 }),
    ]);
    expect(growing.status).toBe("oscillating");
    expect(growing.oscillating).toBe(true);

    const rebound = evaluateReviewConvergence([
      verdict({ reviewId: 1, findingsCount: 3 }),
      verdict({ reviewId: 2, findingsCount: 4 }),
      verdict({ reviewId: 3, findingsCount: 4 }),
    ]);
    expect(rebound.status).toBe("oscillating");
    expect(rebound.findingsTrajectory).toEqual([3, 4, 4]);
  });

  it("handles a single verdict and legacy blobs without counts", () => {
    expect(evaluateReviewConvergence([]).status).toBe("converging");
    // Legacy GitHub-derived entries carry no findingsCount/fingerprints —
    // APPROVED maps to 0, everything else to 1.
    const legacy = evaluateReviewConvergence([
      verdict({ reviewId: 1, state: "APPROVED" }),
    ]);
    expect(legacy.status).toBe("clean");
    expect(legacy.findingsTrajectory).toEqual([0]);
    const legacyChanges = evaluateReviewConvergence([
      verdict({ reviewId: 1, state: "CHANGES_REQUESTED" }),
    ]);
    expect(legacyChanges.findingsTrajectory).toEqual([1]);
    expect(legacyChanges.status).toBe("converging");
  });
});

describe("verdict schema backward-compat", () => {
  it("still parses blobs written before findingsCount/fingerprints/scores", () => {
    const { reviewSummary } = rollReviewSummary(
      null,
      verdict({ reviewId: 5, excerpt: "old shape" })
    );
    const back = parseReviewSummary(reviewSummary);
    expect(back).toHaveLength(1);
    expect(back[0].findingsCount).toBeUndefined();
    expect(back[0].scores).toBeUndefined();
    expect(evaluateReviewConvergence(back).rounds).toBe(1);
  });

  it("round-trips findingsCount, fingerprints, and scores", () => {
    const { reviewSummary } = rollReviewSummary(null, {
      ...verdict({ reviewId: 9 }),
      findingsCount: 2,
      fingerprints: ["src/a.ts:breaking:null-deref"],
      scores: { security: 100, slop: 100, invariants: 65, humanGate: true },
    });
    const [v] = parseReviewSummary(reviewSummary);
    expect(v.findingsCount).toBe(2);
    expect(v.fingerprints).toEqual(["src/a.ts:breaking:null-deref"]);
    expect(v.scores).toEqual({
      security: 100,
      slop: 100,
      invariants: 65,
      humanGate: true,
    });
  });
});
