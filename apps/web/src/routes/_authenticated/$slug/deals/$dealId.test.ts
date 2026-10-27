import { describe, expect, it } from "vitest";

import { pickLinkedIssues } from "./$dealId";

const issues = [
  { id: "i1", title: "First" },
  { id: "i2", title: "Second" },
  { id: "i3", title: "Third" },
];

describe("pickLinkedIssues (PILE-653)", () => {
  it("resolves linked ids against the shared list, in link order", () => {
    expect(pickLinkedIssues(issues, ["i3", "i1"]).map((i) => i.id)).toEqual([
      "i3",
      "i1",
    ]);
  });

  it("drops ids missing from the fetched page", () => {
    expect(pickLinkedIssues(issues, ["i1", "gone"]).map((i) => i.id)).toEqual([
      "i1",
    ]);
    expect(pickLinkedIssues([], ["i1"])).toEqual([]);
  });
});
