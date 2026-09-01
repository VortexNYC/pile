import { describe, it, expect } from "vitest";
import {
  generateBranchName,
  parseSessionIdFromUrl,
  sessionIsTerminal,
} from "./utils.js";

describe("utils", () => {
  it("generateBranchName uses issue id and slug", () => {
    expect(generateBranchName("VOR-45", "Fix the bug!")).toBe("vor-45-fix-the-bug");
  });

  it("generateBranchName falls back when no issue id", () => {
    expect(generateBranchName(undefined, "Update docs")).toBe("vor-update-docs");
  });

  it("parseSessionIdFromUrl extracts the session id", () => {
    expect(parseSessionIdFromUrl("https://app.devin.ai/sessions/abc123")).toBe(
      "abc123"
    );
    expect(
      parseSessionIdFromUrl("https://app.devin.ai/sessions/abc123/settings")
    ).toBe("abc123");
    expect(parseSessionIdFromUrl("not-a-url")).toBeUndefined();
  });

  it("sessionIsTerminal returns true for archived", () => {
    expect(
      sessionIsTerminal({
        status: "running",
        status_detail: null,
        is_archived: true,
      })
    ).toBe(true);
  });

  it("sessionIsTerminal returns true for terminal statuses", () => {
    for (const s of [
      "completed",
      "done",
      "failed",
      "cancelled",
      "exit",
      "error",
      "suspended",
    ]) {
      expect(
        sessionIsTerminal({
          status: s,
          status_detail: null,
          is_archived: false,
        })
      ).toBe(true);
    }
  });

  it("sessionIsTerminal returns false for running", () => {
    expect(
      sessionIsTerminal({
        status: "running",
        status_detail: null,
        is_archived: false,
      })
    ).toBe(false);
  });
});
