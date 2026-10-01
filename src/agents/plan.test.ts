import { describe, expect, it } from "vitest";

import {
  buildImplementPlanInstructions,
  buildPlanInstructions,
  extractPlanText,
  findLatestPlanComment,
  formatPlanComment,
  parsePlanCommand,
} from "./plan.js";

describe("parsePlanCommand", () => {
  it("parses /plan with and without feedback", () => {
    expect(parsePlanCommand("/plan")).toEqual({ kind: "plan", feedback: null });
    expect(parsePlanCommand("  /PLAN  ")).toEqual({
      kind: "plan",
      feedback: null,
    });
    expect(parsePlanCommand("/plan split step 2\ninto two PRs")).toEqual({
      kind: "plan",
      feedback: "split step 2\ninto two PRs",
    });
  });

  it("parses /implement_plan and /implement-plan", () => {
    expect(parsePlanCommand("/implement_plan")).toEqual({
      kind: "implement_plan",
    });
    expect(parsePlanCommand("/implement-plan\nlooks good")).toEqual({
      kind: "implement_plan",
    });
  });

  it("ignores ordinary comments", () => {
    expect(parsePlanCommand("we should /plan this")).toBeNull();
    expect(parsePlanCommand("/planning ahead")).toBeNull();
    expect(parsePlanCommand("/implement_plan now please")).toBeNull();
  });
});

describe("extractPlanText", () => {
  it("unwraps the runner envelope's output_tail", () => {
    expect(
      extractPlanText(JSON.stringify({ output_tail: " 1. Approach " }))
    ).toBe("1. Approach");
  });

  it("returns plain text as-is", () => {
    expect(extractPlanText("  ## Plan  ")).toBe("## Plan");
    expect(extractPlanText("{not json")).toBe("{not json");
    expect(extractPlanText(null)).toBe("");
  });
});

describe("plan prompts", () => {
  const issue = {
    identifier: "PILE-1",
    title: "Add plan mode",
    repo: "VortexNYC/pile",
  };

  it("plan instructions forbid implementation", () => {
    const text = buildPlanInstructions(issue);
    expect(text).toContain("PLAN MODE");
    expect(text).toContain("do NOT implement");
    expect(text).toContain("VortexNYC/pile");
    expect(text).not.toContain("Previous plan");
  });

  it("revision instructions carry the previous plan and feedback", () => {
    const text = buildPlanInstructions(issue, {
      plan: "1. Do X",
      feedback: "Use Y instead",
    });
    expect(text).toContain("Previous plan:\n1. Do X");
    expect(text).toContain("Use Y instead");
  });

  it("implement instructions embed the approved plan", () => {
    const text = buildImplementPlanInstructions("1. Do X");
    expect(text).toContain("APPROVED implementation plan");
    expect(text).toContain("1. Do X");
  });

  it("plan comments explain the next commands", () => {
    const body = formatPlanComment("devin", "1. Do X");
    expect(body).toContain("Implementation plan by devin");
    expect(body).toContain("/implement_plan");
  });
});

describe("findLatestPlanComment", () => {
  it("picks the newest plan-sourced comment", () => {
    const comments = [
      {
        id: "a",
        externalSource: "plan",
        externalId: "s1",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "b",
        externalSource: "agent",
        externalId: "s2",
        createdAt: "2026-01-03T00:00:00Z",
      },
      {
        id: "c",
        externalSource: "plan",
        externalId: "s3",
        createdAt: "2026-01-02T00:00:00Z",
      },
    ];
    expect(findLatestPlanComment(comments)?.id).toBe("c");
    expect(findLatestPlanComment([])).toBeNull();
  });
});
