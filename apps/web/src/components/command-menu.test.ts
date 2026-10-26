import { describe, expect, it } from "vitest";

import { paletteDeepQueryEnabled } from "./command-menu";

describe("paletteDeepQueryEnabled (PILE-645)", () => {
  it("only fetches heavy palette feeds once a term is typed", () => {
    expect(paletteDeepQueryEnabled(false, "foo")).toBe(false);
    expect(paletteDeepQueryEnabled(true, "")).toBe(false);
    expect(paletteDeepQueryEnabled(true, "   ")).toBe(false);
    expect(paletteDeepQueryEnabled(true, "doc")).toBe(true);
  });
});
