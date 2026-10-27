import { describe, expect, it } from "vitest";

import { issuePermalink } from "./issue-context-menu";

describe("issuePermalink", () => {
  it("builds the /app-prefixed issue URL", () => {
    expect(issuePermalink("https://pile.nyc", "acme", "abc-1")).toBe(
      "https://pile.nyc/app/acme/issues/abc-1"
    );
  });
});
