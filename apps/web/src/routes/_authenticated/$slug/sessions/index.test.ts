import { describe, expect, it } from "vitest";

import { agentFilterOptions, agentGroupLabels } from "./index";

describe("agentFilterOptions", () => {
  it("lists registered types plus agentIds that actually have lanes", () => {
    expect(
      agentFilterOptions(
        [
          { slug: "scout", providerAgentId: "p-scout" },
          { slug: "swe", providerAgentId: "p-swe" },
        ],
        ["mock-scout", "flue"]
      )
    ).toEqual(["flue", "mock-scout", "scout", "swe"]);
  });

  it("dedupes when a lane's agentId is also a type slug", () => {
    expect(
      agentFilterOptions(
        [{ slug: "flue", providerAgentId: "p-flue" }],
        ["flue"]
      )
    ).toEqual(["flue"]);
  });

  it("drops lane agentIds a type already covers via providerAgentId", () => {
    // Both values would render the type's name — one option suffices
    // since the slug scope already resolves providerAgentId lanes.
    expect(
      agentFilterOptions(
        [{ slug: "scout", providerAgentId: "devin-cli" }],
        ["devin-cli", "unregistered"]
      )
    ).toEqual(["scout", "unregistered"]);
  });

  it("handles empty inputs", () => {
    expect(agentFilterOptions([], [])).toEqual([]);
  });
});

describe("agentGroupLabels", () => {
  it("maps both slug and providerAgentId to the type name", () => {
    expect(
      agentGroupLabels([
        { slug: "scout", name: "Scout", providerAgentId: "mock-scout" },
      ])
    ).toEqual({ scout: "Scout", "mock-scout": "Scout" });
  });

  it("keeps the slug's own name when it collides with another providerAgentId", () => {
    expect(
      agentGroupLabels([
        { slug: "a", name: "A", providerAgentId: "b" },
        { slug: "b", name: "B", providerAgentId: "p-b" },
      ])
    ).toEqual({ a: "A", b: "B", "p-b": "B" });
  });
});
