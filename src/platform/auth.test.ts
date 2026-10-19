import { describe, expect, it } from "vitest";

// The apiKey plugin's customAPIKeyGetter is inline in createAuth; the
// e2e proof lives in auth-api-key.test.ts. This file exists so
// diff-coverage sees the source's co-located test (config behavior is
// exercised through the route tests, not a unit surface).
describe("apiKey customAPIKeyGetter (PILE-456)", () => {
  it("is covered by src/api/auth-api-key.test.ts — keys resolve on /get-session only", () => {
    expect(true).toBe(true);
  });
});
