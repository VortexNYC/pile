import { describe, expect, it } from "vitest";

import { planProgress } from "./session-plan";

describe("planProgress", () => {
  it("counts completed and canceled items as done", () => {
    expect(
      planProgress([
        { content: "a", status: "completed" },
        { content: "b", status: "canceled" },
        { content: "c", status: "inProgress" },
        { content: "d", status: "pending" },
      ])
    ).toEqual({ done: 2, total: 4 });
  });

  it("returns zero progress for an empty plan", () => {
    expect(planProgress([])).toEqual({ done: 0, total: 0 });
  });
});
