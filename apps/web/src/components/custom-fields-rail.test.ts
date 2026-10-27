import { describe, expect, it } from "vitest";

import { hasFieldDefs } from "./custom-fields-rail";

describe("hasFieldDefs (PILE-653)", () => {
  it("gates the values fetch on defined fields", () => {
    expect(hasFieldDefs(undefined)).toBe(false);
    expect(hasFieldDefs([])).toBe(false);
    expect(hasFieldDefs([{ id: "f1" }])).toBe(true);
  });
});
