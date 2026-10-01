import { describe, expect, it } from "vitest";

import {
  addressedThreads,
  deliveredFeedback,
  isChangesVerdict,
  reviewAutomationEvents,
} from "./review-loop.js";

describe("isChangesVerdict", () => {
  it("treats changes_requested and bodied comment reviews as non-approve", () => {
    expect(isChangesVerdict("CHANGES_REQUESTED", "")).toBe(true);
    expect(isChangesVerdict("changes_requested", "")).toBe(true);
    expect(isChangesVerdict("COMMENTED", "nit: rename")).toBe(true);
  });

  it("ignores approvals and empty comment reviews", () => {
    expect(isChangesVerdict("APPROVED", "lgtm")).toBe(false);
    expect(isChangesVerdict("COMMENTED", "  ")).toBe(false);
    expect(isChangesVerdict("DISMISSED", "x")).toBe(false);
  });
});

describe("reviewAutomationEvents", () => {
  it("adds pr.review_changes only for non-approve verdicts", () => {
    expect(reviewAutomationEvents("CHANGES_REQUESTED", "")).toEqual([
      "pr.review",
      "pr.review_changes",
    ]);
    expect(reviewAutomationEvents("APPROVED", "nice")).toEqual(["pr.review"]);
    expect(reviewAutomationEvents("APPROVED", "")).toEqual([]);
  });
});

describe("deliveredFeedback", () => {
  it("keeps the earliest delivery per review/comment key", () => {
    const delivered = deliveredFeedback([
      {
        type: "prompt.followup",
        payload: JSON.stringify({ key: "review-1" }),
        createdAt: "2026-10-01T10:05:00.000Z",
      },
      {
        type: "prompt.followup",
        payload: JSON.stringify({ key: "review-1" }),
        createdAt: "2026-10-01T10:00:00.000Z",
      },
      {
        type: "prompt.redispatch",
        payload: JSON.stringify({ key: "comment-7" }),
        createdAt: "2026-10-01T10:01:00.000Z",
      },
      {
        type: "prompt.followup",
        payload: JSON.stringify({ key: "ci-abc" }),
        createdAt: "2026-10-01T10:01:00.000Z",
      },
      {
        type: "prompt.followup_failed",
        payload: JSON.stringify({ key: "review-2" }),
        createdAt: "2026-10-01T10:01:00.000Z",
      },
      { type: "prompt.followup", payload: "not json", createdAt: "x" },
    ]);
    expect([...delivered.keys()].toSorted()).toEqual(["comment-7", "review-1"]);
    expect(delivered.get("review-1")).toBe(
      Date.parse("2026-10-01T10:00:00.000Z")
    );
  });
});

describe("addressedThreads", () => {
  const t0 = Date.parse("2026-10-01T10:00:00.000Z");
  const delivered = new Map([
    ["review-1", t0],
    ["comment-9", t0],
  ]);
  const threads = [
    { id: "A", isResolved: false, commentId: 5, reviewId: 1 },
    { id: "B", isResolved: false, commentId: 9, reviewId: null },
    { id: "C", isResolved: true, commentId: 6, reviewId: 1 },
    { id: "D", isResolved: false, commentId: 8, reviewId: 2 },
  ];

  it("resolves delivered, unresolved threads once the lane pushes after delivery", () => {
    const out = addressedThreads(
      threads,
      [{ committedAt: t0 + 60_000, isMerge: false }],
      delivered
    );
    expect(out.map((t) => t.id)).toEqual(["A", "B"]);
  });

  it("does nothing before a post-delivery push", () => {
    expect(
      addressedThreads(
        threads,
        [{ committedAt: t0 - 60_000, isMerge: false }],
        delivered
      )
    ).toEqual([]);
  });

  it("never counts a merge commit (update-branch) as the fix", () => {
    expect(
      addressedThreads(
        threads,
        [{ committedAt: t0 + 60_000, isMerge: true }],
        delivered
      )
    ).toEqual([]);
  });
});
