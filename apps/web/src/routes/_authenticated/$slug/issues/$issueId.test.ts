import { describe, expect, it } from "vitest";

import { childIssuesQuery, issueSessionsQuery } from "./$issueId";

describe("issueSessionsQuery (PILE-653)", () => {
  it("scopes to the issue on the bounded summary contract", () => {
    expect(issueSessionsQuery("iss-1")).toEqual({
      issueId: "iss-1",
      summary: "1",
      limit: "200",
    });
  });
});

describe("childIssuesQuery", () => {
  it("caps the sub-issue fetch", () => {
    expect(childIssuesQuery("iss-1")).toEqual({
      parentId: "iss-1",
      limit: 100,
    });
  });
});
