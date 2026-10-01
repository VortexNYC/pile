import { describe, expect, it } from "vitest";

import {
  REVIEW_LENSES,
  extractPathMentions,
  reviewLensPrompt,
  selectReviewLenses,
} from "./review-lens.js";

const ids = (input: Parameters<typeof selectReviewLenses>[0]) =>
  selectReviewLenses(input).map((l) => l.id);

describe("selectReviewLenses", () => {
  it("maps changed paths to domain lenses", () => {
    expect(ids({ paths: ["src/billing/refunds.ts"] })).toEqual(["billing"]);
    expect(ids({ paths: ["migrations/0042_add_col.sql"] })).toEqual(["data"]);
    expect(ids({ paths: ["src/platform/auth.ts"] })).toEqual(["auth"]);
    expect(ids({ paths: ["packages/widget/src/Chat.tsx"] })).toEqual(["ui"]);
  });

  it("maps labels to lenses, case-insensitively", () => {
    expect(ids({ labels: ["Payments"] })).toEqual(["billing"]);
    expect(ids({ labels: ["Security", "Webhooks"] })).toEqual([
      "auth",
      "integrations",
    ]);
  });

  it("returns lenses in catalog order, deduped and capped", () => {
    const selected = ids({
      paths: [
        "src/agents/sweep.ts",
        "src/api/issues.ts",
        "src/global/schema.ts",
        "src/billing/invoice.ts",
        "src/platform/auth.ts",
      ],
      labels: ["billing"],
    });
    expect(selected).toEqual(["billing", "auth", "data", "concurrency"]);
  });

  it("does not trip on lockfiles or unrelated paths", () => {
    expect(ids({ paths: ["pnpm-lock.yaml", "README.md"] })).toEqual([]);
  });
});

describe("extractPathMentions", () => {
  it("pulls repo paths from issue text and skips URLs", () => {
    expect(
      extractPathMentions(
        "Touch `src/agents/sweep.ts` and migrations/0001.sql; see https://github.com/a/b/pull/1"
      )
    ).toEqual(["src/agents/sweep.ts", "migrations/0001.sql"]);
  });
});

describe("reviewLensPrompt", () => {
  it("expands selected lenses and indexes the rest", () => {
    const billing = REVIEW_LENSES.filter((l) => l.id === "billing");
    const prompt = reviewLensPrompt(billing);
    expect(prompt).toContain("## Review lenses");
    expect(prompt).toContain("### Billing lens");
    expect(prompt).toContain("You are the billing lens");
    expect(prompt).toMatch(/charge, refund, or pay out twice/);
    expect(prompt).not.toContain("### Auth lens");
    expect(prompt).toContain("Auth lens (");
  });

  it("still carries the lens index when nothing is preselected", () => {
    const prompt = reviewLensPrompt([]);
    expect(prompt).not.toContain("###");
    for (const lens of REVIEW_LENSES) expect(prompt).toContain(lens.title);
  });
});
