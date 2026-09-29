import { describe, expect, it } from "vitest";

import {
  buildPreflightCritiqueInstructions,
  evaluateDispatchReadiness,
} from "./preflight";

const READY_ISSUE = {
  title: "Fix session cleanup in sweep",
  description:
    "Sessions stuck in `running` should be reaped after 30 minutes. " +
    "Verify that the sweep cancels them and that the issue reconciles.",
  repo: "VortexNYC/pile",
};

describe("evaluateDispatchReadiness", () => {
  it("marks a well-specified code ticket ready", () => {
    const report = evaluateDispatchReadiness(READY_ISSUE);

    expect(report.ready).toBe(true);
    expect(report.missing).toEqual([]);
  });

  it("flags an empty description", () => {
    const report = evaluateDispatchReadiness({
      title: "Fix the bug",
      description: null,
      repo: "VortexNYC/pile",
    });

    expect(report.ready).toBe(false);
    expect(report.missing).toContain("description is empty");
  });

  it("flags a one-line description", () => {
    const report = evaluateDispatchReadiness({
      title: "Update onboarding",
      description: "Add a section.",
      repo: "VortexNYC/pile",
    });

    expect(report.ready).toBe(false);
    expect(
      report.missing.some((m) => m.includes("description is too thin"))
    ).toBe(true);
  });

  it("flags a code task with no repository attached", () => {
    const report = evaluateDispatchReadiness({
      title: "Fix the crash on sign-in",
      description:
        "The sign-in endpoint should return a session token when credentials verify. Verify the existing tests pass.",
      repo: null,
    });

    expect(report.ready).toBe(false);
    expect(
      report.missing.some((m) => m.includes("no repository is attached"))
    ).toBe(true);
  });

  it("does not flag missing repo for non-code tasks", () => {
    const report = evaluateDispatchReadiness({
      title: "Draft changelog notes",
      description:
        "Summarize this week's merged PRs into changelog prose. The output should be three sections the team can review.",
      repo: null,
    });

    expect(
      report.missing.some((m) => m.includes("no repository is attached"))
    ).toBe(false);
  });

  it("flags missing acceptance criteria", () => {
    const report = evaluateDispatchReadiness({
      title: "Fix the thing in the worker",
      description:
        "Something in the sweep is off lately. Take a look around and tidy it up where needed, keeping behavior roughly the same.",
      repo: "VortexNYC/pile",
    });

    expect(report.missing.some((m) => m.includes("acceptance criteria"))).toBe(
      true
    );
  });

  it("flags placeholder language", () => {
    const report = evaluateDispatchReadiness({
      title: "Something TBD",
      description:
        "We should do something about the queue maybe. Details TBD but it should be whatever makes sense for now.",
      repo: "VortexNYC/pile",
    });

    expect(report.missing.some((m) => m.includes("placeholder language"))).toBe(
      true
    );
  });
});

describe("buildPreflightCritiqueInstructions", () => {
  it("forbids implementation and names the repo without cloning", () => {
    const prompt = buildPreflightCritiqueInstructions(READY_ISSUE);

    expect(prompt).toContain("do NOT implement");
    expect(prompt).toContain("VortexNYC/pile");
    expect(prompt).toContain("READY or NOT READY");
  });

  it("omits the repo line when none is attached", () => {
    const prompt = buildPreflightCritiqueInstructions({
      title: "T",
      description: null,
      repo: null,
    });

    expect(prompt).not.toContain("Target repository");
  });
});
