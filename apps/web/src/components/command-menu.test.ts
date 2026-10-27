import { describe, expect, it } from "vitest";

import { paletteDeepQueryEnabled, paletteRoute } from "./command-menu";

describe("paletteDeepQueryEnabled (PILE-645)", () => {
  it("only fetches heavy palette feeds once a term is typed", () => {
    expect(paletteDeepQueryEnabled(false, "foo")).toBe(false);
    expect(paletteDeepQueryEnabled(true, "")).toBe(false);
    expect(paletteDeepQueryEnabled(true, "   ")).toBe(false);
    expect(paletteDeepQueryEnabled(true, "doc")).toBe(true);
  });
});

describe("paletteRoute (PILE-652)", () => {
  it("joins workspace-relative hrefs under the slug — no /app prefix, the router owns the basepath", () => {
    expect(paletteRoute("acme", "/issues/ISS-4")).toBe("/acme/issues/ISS-4");
    expect(paletteRoute("acme", "/documents")).toBe("/acme/documents");
  });

  it("normalizes hrefs missing the leading slash", () => {
    expect(paletteRoute("acme", "issues")).toBe("/acme/issues");
  });
});
