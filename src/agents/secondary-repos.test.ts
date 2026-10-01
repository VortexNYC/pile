import { describe, expect, it } from "vitest";

import {
  parseStoredSecondaryRepos,
  secondaryReposSchema,
  validateSecondaryRepos,
} from "./secondary-repos.js";

describe("secondaryRepos (PILE-294)", () => {
  it("defaults access to read and rejects malformed repo names", () => {
    expect(secondaryReposSchema.parse([{ repo: "acme/vortex" }])).toEqual([
      { repo: "acme/vortex", access: "read" },
    ]);
    expect(
      secondaryReposSchema.safeParse([{ repo: "not-a-repo" }]).success
    ).toBe(false);
    expect(
      secondaryReposSchema.safeParse([{ repo: "a/b", access: "admin" }]).success
    ).toBe(false);
  });

  it("caps the list length", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ repo: `acme/r${i}` }));
    expect(secondaryReposSchema.safeParse(many).success).toBe(false);
  });

  it("rejects duplicates of the primary repo or each other", () => {
    expect(() =>
      validateSecondaryRepos("acme/pile", [
        { repo: "Acme/Pile", access: "read" },
      ])
    ).toThrow("duplicates");
    expect(() =>
      validateSecondaryRepos("acme/pile", [
        { repo: "acme/vortex", access: "read" },
        { repo: "acme/vortex", access: "write" },
      ])
    ).toThrow("duplicates");
  });

  it("requires a primary repo", () => {
    expect(() =>
      validateSecondaryRepos(null, [{ repo: "acme/vortex", access: "read" }])
    ).toThrow("primary repository");
    expect(validateSecondaryRepos(null, undefined)).toEqual([]);
  });

  it("reads stored JSON defensively", () => {
    expect(parseStoredSecondaryRepos(null)).toEqual([]);
    expect(parseStoredSecondaryRepos("{bad")).toEqual([]);
    expect(
      parseStoredSecondaryRepos('[{"repo":"acme/vortex","access":"write"}]')
    ).toEqual([{ repo: "acme/vortex", access: "write" }]);
  });
});
