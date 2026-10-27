import { describe, expect, it } from "vitest";

import { wsKey } from "@/hooks/use-workspace";

import { issueFieldInvalidationKey } from "./issue-field-menu";

describe("issueFieldInvalidationKey (PILE-652)", () => {
  it("targets the issues subtree — a field edit must not refetch every workspace query", () => {
    expect(issueFieldInvalidationKey("org-1")).toEqual([
      "ws",
      "org-1",
      "issues",
    ]);
  });

  it("is a proper prefix of issue detail keys so edits still refresh open pages", () => {
    const detail = wsKey("org-1", "issues", "issue-9");
    const invalidation = issueFieldInvalidationKey("org-1");
    expect(detail.slice(0, invalidation.length)).toEqual([...invalidation]);
    expect(detail.length).toBeGreaterThan(invalidation.length);
  });
});
