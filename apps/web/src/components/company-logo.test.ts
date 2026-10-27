import { describe, expect, it } from "vitest";

import { logoCandidates } from "./company-logo";

describe("logoCandidates (PILE-653)", () => {
  it("never emits the retired Clearbit endpoint", () => {
    const candidates = logoCandidates({ domain: "acme.com" });
    expect(candidates.some((c) => c.includes("clearbit"))).toBe(false);
    expect(candidates).toEqual([
      "https://www.google.com/s2/favicons?domain=acme.com&sz=64",
    ]);
  });

  it("prefers the record logoUrl and falls back to favicon", () => {
    expect(
      logoCandidates({ logoUrl: "https://x/logo.png", domain: "acme.com" })
    ).toEqual([
      "https://x/logo.png",
      "https://www.google.com/s2/favicons?domain=acme.com&sz=64",
    ]);
  });

  it("yields no candidates without a logo or resolvable host", () => {
    expect(logoCandidates({})).toEqual([]);
  });
});
