import { describe, expect, it } from "vitest";

import { filterEntityOptions, SERVER_SEARCH_TYPES } from "./entity-links";

const opts = [
  { id: "1", label: "Acme Corp" },
  { id: "2", label: "Beta LLC" },
];

describe("filterEntityOptions (PILE-653)", () => {
  it("returns server-filtered types unfiltered and caps at 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `${i}`,
      label: `Item ${i}`,
    }));
    expect(filterEntityOptions("customer", many, "zzz")).toHaveLength(8);
    expect(filterEntityOptions("issue", opts, "beta")).toEqual(opts);
  });

  it("filters client-side types by label substring", () => {
    expect(filterEntityOptions("deal", opts, "acme")).toEqual([opts[0]]);
    expect(filterEntityOptions("project", opts, "")).toEqual(opts);
    expect(filterEntityOptions("document", opts, "nothing")).toEqual([]);
  });

  it("keeps the server-search contract honest", () => {
    expect(SERVER_SEARCH_TYPES.has("customer")).toBe(true);
    expect(SERVER_SEARCH_TYPES.has("deal")).toBe(false);
  });
});
