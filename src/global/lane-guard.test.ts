import { describe, expect, it } from "vitest";

import { sanitizeLaneResult } from "./lane-guard.js";

describe("sanitizeLaneResult", () => {
  it("drops a prUrl pointing outside the session repo", () => {
    const out = sanitizeLaneResult(
      {
        prUrl: "https://github.com/other/repo/pull/1",
        prState: "open",
      },
      "owner/repo"
    );
    expect(out.prUrl).toBeNull();
    expect(out.prState).toBeNull();
  });

  it("keeps a prUrl on the session repo", () => {
    const out = sanitizeLaneResult(
      {
        prUrl: "https://github.com/owner/repo/pull/1",
        prState: "open",
      },
      "owner/repo"
    );
    expect(out.prUrl).toBe("https://github.com/owner/repo/pull/1");
    expect(out.prState).toBe("open");
  });

  it("nulls a non-canonical prState", () => {
    for (const state of ["draft", "open", "merged", "closed"]) {
      expect(sanitizeLaneResult({ prState: state }, null).prState).toBe(state);
    }
    expect(
      sanitizeLaneResult({ prState: "in_review" }, null).prState
    ).toBeNull();
    expect(sanitizeLaneResult({ prState: "opened" }, null).prState).toBeNull();
  });
});
