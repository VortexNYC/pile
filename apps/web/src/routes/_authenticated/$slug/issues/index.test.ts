import { describe, expect, it } from "vitest";

import { sessionGroupLabels } from "./index";

describe("sessionGroupLabels", () => {
  it("labels issues by identifier and title", () => {
    expect(
      sessionGroupLabels([
        { id: "uuid-1", identifier: "ISS-1", title: "Fix thing" },
      ])
    ).toEqual({ "uuid-1": "ISS-1 — Fix thing" });
  });

  it("falls back to the bare title when an issue has no identifier", () => {
    expect(
      sessionGroupLabels([
        { id: "uuid-2", identifier: null, title: "Untracked" },
        { id: "uuid-3", title: "No ident field" },
      ])
    ).toEqual({ "uuid-2": "Untracked", "uuid-3": "No ident field" });
  });

  it("returns an empty map for no issues", () => {
    expect(sessionGroupLabels([])).toEqual({});
  });
});
