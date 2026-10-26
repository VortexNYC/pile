import { describe, expect, it } from "vitest";

import { FOLLOW_UP_SECTIONS } from "./follow-ups-list";

describe("FOLLOW_UP_SECTIONS (PILE-651)", () => {
  it("orders sections most-urgent first", () => {
    expect(FOLLOW_UP_SECTIONS.map((s) => s.key)).toEqual([
      "overdue",
      "today",
      "upcoming",
    ]);
    expect(FOLLOW_UP_SECTIONS.every((s) => s.title.length > 0)).toBe(true);
  });
});
