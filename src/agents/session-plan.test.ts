import { describe, expect, it } from "vitest";

import {
  parseSessionPlan,
  sessionPlanMarkdown,
  sessionPlanProgress,
  sessionPlanSchema,
} from "./session-plan.js";

describe("sessionPlanSchema", () => {
  it("accepts an ordered checklist with all four statuses", () => {
    const parsed = sessionPlanSchema.safeParse([
      { content: "Read the issue", status: "completed" },
      { content: "Write the fix", status: "inProgress" },
      { content: "Run tests", status: "pending" },
      { content: "Skipped idea", status: "canceled" },
    ]);
    expect(parsed.success).toBe(true);
  });

  it("rejects empty content, unknown statuses, and oversized lists", () => {
    expect(
      sessionPlanSchema.safeParse([{ content: "", status: "pending" }]).success
    ).toBe(false);
    expect(
      sessionPlanSchema.safeParse([{ content: "x", status: "in_progress" }])
        .success
    ).toBe(false);
    expect(
      sessionPlanSchema.safeParse(
        Array.from({ length: 51 }, (_, i) => ({
          content: `item ${i}`,
          status: "pending",
        }))
      ).success
    ).toBe(false);
  });
});

describe("parseSessionPlan", () => {
  it("round-trips stored JSON and degrades malformed rows to null", () => {
    const plan = [{ content: "a", status: "pending" as const }];
    expect(parseSessionPlan(JSON.stringify(plan))).toEqual(plan);
    expect(parseSessionPlan(null)).toBeNull();
    expect(parseSessionPlan("not json")).toBeNull();
    expect(
      parseSessionPlan(JSON.stringify([{ content: "a", status: "nope" }]))
    ).toBeNull();
    expect(parseSessionPlan(JSON.stringify({ plan: [] }))).toBeNull();
  });
});

describe("sessionPlanProgress", () => {
  it("counts completed and canceled items as done", () => {
    expect(
      sessionPlanProgress([
        { content: "a", status: "completed" },
        { content: "b", status: "canceled" },
        { content: "c", status: "inProgress" },
        { content: "d", status: "pending" },
      ])
    ).toEqual({ done: 2, total: 4 });
  });
});

describe("sessionPlanMarkdown", () => {
  it("renders checkboxes with in-progress and canceled annotations", () => {
    expect(
      sessionPlanMarkdown([
        { content: "Done thing", status: "completed" },
        { content: "Doing thing\nextra detail", status: "inProgress" },
        { content: "To do", status: "pending" },
        { content: "Dropped", status: "canceled" },
      ])
    ).toEqual([
      "- [x] Done thing",
      "- [ ] Doing thing _(in progress)_",
      "- [ ] To do",
      "- [ ] ~~Dropped~~ _(canceled)_",
    ]);
  });
});
