import { describe, expect, it } from "vitest";

import {
  evaluateDiffCoverage,
  findExplanation,
  isSourceFile,
  isTestFile,
} from "./diff-coverage";

describe("diff-coverage", () => {
  it("classifies source, test, and generated files", () => {
    expect(isSourceFile("src/agents/sweep.ts")).toBe(true);
    expect(isSourceFile("packages/cli/src/fleet.ts")).toBe(true);
    expect(isSourceFile("src/agents/sweep.test.ts")).toBe(false);
    expect(isSourceFile("src/types/env.d.ts")).toBe(false);
    expect(isSourceFile("src/mcp/mcp-tools.ts")).toBe(false);
    expect(isSourceFile("src/mcp/openapi.json")).toBe(false);
    expect(isSourceFile("scripts/contract-check.ts")).toBe(false);
    expect(isTestFile("src/agents/runner/lane.node.test.ts")).toBe(true);
    expect(isTestFile("src/test/apply-migrations.ts")).toBe(true);
    expect(isTestFile("packages/cli/e2e/login.spec.ts")).toBe(true);
  });

  it("passes when no source changed", () => {
    const report = evaluateDiffCoverage(["README.md", "wrangler.toml"], "");
    expect(report).toMatchObject({ ok: true, reason: "no-source-changes" });
  });

  it("fails when a source file's co-located test wasn't touched (PILE-298)", () => {
    const report = evaluateDiffCoverage(
      [
        "src/agents/sweep.ts",
        "src/agents/sweep.test.ts",
        "src/agents/github.ts",
      ],
      ""
    );
    expect(report).toMatchObject({ ok: false, reason: "missing-tests" });
    expect(report.untestedSourceFiles).toEqual(["src/agents/github.ts"]);
  });

  it("passes when every changed source file's test is touched", () => {
    const report = evaluateDiffCoverage(
      [
        "src/agents/sweep.ts",
        "src/agents/sweep.test.ts",
        "src/agents/github.ts",
        "src/agents/github.test.ts",
      ],
      ""
    );
    expect(report).toMatchObject({ ok: true, reason: "tests-changed" });
  });

  it("fails when source changed without tests or explanation", () => {
    const report = evaluateDiffCoverage(["src/agents/sweep.ts"], "## Summary");
    expect(report).toMatchObject({ ok: false, reason: "missing-tests" });
  });

  it("passes when the PR body explains the missing tests", () => {
    const report = evaluateDiffCoverage(
      ["src/agents/sweep.ts"],
      "## Summary\n\nNo tests: log message wording only\n"
    );
    expect(report).toMatchObject({
      ok: true,
      reason: "explained",
      explanation: "log message wording only",
    });
  });

  it("parses explanations case-insensitively, ignoring markup and comments", () => {
    expect(findExplanation("- **No tests:** pure rename")).toBe("pure rename");
    expect(findExplanation("no TESTS: types only")).toBe("types only");
    expect(findExplanation("No tests:   ")).toBeNull();
    expect(findExplanation('<!-- "No tests: <reason>" -->')).toBeNull();
    expect(findExplanation("Tests: none")).toBeNull();
  });
});
