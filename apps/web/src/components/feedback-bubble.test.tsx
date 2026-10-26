import { describe, expect, it } from "vitest";

import { FEEDBACK_KINDS, FeedbackBubble } from "./feedback-bubble";

describe("FeedbackBubble", () => {
  it("is a mountable component", () => {
    expect(typeof FeedbackBubble).toBe("function");
  });
});

describe("FEEDBACK_KINDS", () => {
  it("covers exactly the kinds the API accepts", () => {
    // Mirrors memberFeedbackBodySchema.kind in src/api/support-capture.ts.
    expect(FEEDBACK_KINDS.map((k) => k.value)).toEqual([
      "bug",
      "feature",
      "other",
    ]);
  });

  it("gives every kind a human label", () => {
    for (const kind of FEEDBACK_KINDS) {
      expect(kind.label.length).toBeGreaterThan(0);
    }
  });
});
