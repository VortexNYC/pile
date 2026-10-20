import { describe, expect, it } from "vitest";

import { user } from "./schema.js";

describe("global user schema (PILE-456)", () => {
  it("agent users do not default to admin role", () => {
    const cols = user as unknown as { role?: { default?: string } };
    expect(cols.role?.default ?? "user").not.toBe("admin");
  });
});
