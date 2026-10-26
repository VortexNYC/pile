import { describe, expect, it } from "vitest";

import { developerDescription } from "./developer";

describe("developerDescription", () => {
  it("scopes copy to the caller's own keys for members", () => {
    expect(developerDescription(false)).toContain("your own keys");
  });

  it("describes the full workspace key list for admins", () => {
    expect(developerDescription(true)).toContain("workspace-scoped");
  });
});
