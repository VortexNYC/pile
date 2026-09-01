import { describe, it, expect } from "vitest";
import {
  extractSelect,
  extractText,
  extractUrl,
  extractCheckbox,
  sessionIsTerminal,
  parseSessionIdFromUrl,
  buildNotionPrompt,
  hmacSha256Hex,
  timingSafeEqualHex,
  generateBranchName,
} from "./index";

describe("extract helpers", () => {
  it("extractSelect returns the selected name", () => {
    expect(extractSelect({ type: "select", select: { name: "Ready" } } as any)).toBe("Ready");
  });

  it("extractSelect returns undefined when empty", () => {
    expect(extractSelect(undefined as any)).toBeUndefined();
    expect(extractSelect({ type: "select", select: null } as any)).toBeUndefined();
  });

  it("extractText joins plain text", () => {
    expect(extractText({ type: "title", title: [{ plain_text: "Hello ", text: { content: "Hello " } }, { plain_text: "World", text: { content: "World" } }] } as any)).toBe("Hello World");
  });

  it("extractUrl returns the url", () => {
    expect(extractUrl({ type: "url", url: "https://example.com" } as any)).toBe("https://example.com");
    expect(extractUrl({ type: "url", url: null } as any)).toBeUndefined();
  });

  it("extractCheckbox returns the checked state", () => {
    expect(extractCheckbox({ type: "checkbox", checkbox: true } as any)).toBe(true);
    expect(extractCheckbox({ type: "checkbox", checkbox: false } as any)).toBe(false);
    expect(extractCheckbox(undefined as any)).toBe(false);
  });
});

describe("session lifecycle", () => {
  it("sessionIsTerminal returns true for archived", () => {
    expect(sessionIsTerminal({ status: "running", status_detail: null, is_archived: true } as any)).toBe(true);
  });

  it("sessionIsTerminal returns true for terminal statuses", () => {
    for (const s of ["completed", "done", "failed", "cancelled", "exit", "error", "suspended"]) {
      expect(sessionIsTerminal({ status: s, status_detail: null, is_archived: false } as any)).toBe(true);
    }
  });

  it("sessionIsTerminal returns false for running", () => {
    expect(sessionIsTerminal({ status: "running", status_detail: null, is_archived: false } as any)).toBe(false);
  });
});

describe("branch names", () => {
  it("generateBranchName uses issue id and slug", () => {
    expect(generateBranchName("VOR-45", "Fix the bug!")).toBe("vor-45-fix-the-bug");
  });

  it("generateBranchName falls back when no issue id", () => {
    expect(generateBranchName(undefined, "Update docs")).toBe("vor-update-docs");
  });
});

describe("urls and prompts", () => {
  it("parseSessionIdFromUrl extracts the session id", () => {
    expect(parseSessionIdFromUrl("https://app.devin.ai/sessions/abc123")).toBe("abc123");
    expect(parseSessionIdFromUrl("https://app.devin.ai/sessions/abc123/settings")).toBe("abc123");
    expect(parseSessionIdFromUrl("not-a-url")).toBeUndefined();
  });

  it("buildNotionPrompt includes all fields", () => {
    const prompt = buildNotionPrompt("page-1", {
      name: "Fix bug",
      description: "Desc",
      repo: "org/repo",
      branch: "main",
      linear: "https://linear.app/issue/VOR-1",
      pr: "https://github.com/org/repo/pull/1",
      model: "swe-1-7-medium",
      platform: "user:daytona-linux",
    });
    expect(prompt).toContain("Fix bug");
    expect(prompt).toContain("Desc");
    expect(prompt).toContain("org/repo");
    expect(prompt).toContain("main");
    expect(prompt).toContain("VOR-1");
    expect(prompt).toContain("pull/1");
  });
});

describe("crypto", () => {
  it("hmacSha256Hex produces a stable hex string", async () => {
    const sig = await hmacSha256Hex("secret", "message");
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sig).toBe(await hmacSha256Hex("secret", "message"));
  });

  it("timingSafeEqualHex rejects mismatched lengths", () => {
    expect(timingSafeEqualHex("a", "bb")).toBe(false);
  });

  it("timingSafeEqualHex matches equal hex", () => {
    expect(timingSafeEqualHex("deadbeef", "deadbeef")).toBe(true);
    expect(timingSafeEqualHex("deadbeef", "deadbeee")).toBe(false);
  });
});
