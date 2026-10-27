import { describe, expect, it } from "vitest";

import {
  ISSUES_PAGE_SESSION_POLL_MS,
  issuesListQuery,
  sessionGroupLabels,
} from "./index";

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

describe("issuesListQuery (PILE-652)", () => {
  it("maps URL drill-down params onto the wire contract", () => {
    expect(
      issuesListQuery({ search: "fix", status: "in_progress", team: "team-1" })
    ).toEqual({
      limit: 50,
      search: "fix",
      status: "in_progress",
      teamId: "team-1",
    });
  });

  it("leaves unset filters undefined so the API returns the unfiltered list", () => {
    expect(issuesListQuery({})).toEqual({
      limit: 50,
      search: undefined,
      status: undefined,
      teamId: undefined,
    });
  });
});

describe("ISSUES_PAGE_SESSION_POLL_MS (PILE-653)", () => {
  it("slows the embedded sessions panel to a 15s ambient cadence", () => {
    expect(ISSUES_PAGE_SESSION_POLL_MS).toBe(15_000);
  });
});
