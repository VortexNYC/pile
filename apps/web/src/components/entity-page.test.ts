import { describe, expect, it } from "vitest";

import { ENTITY_RAIL_CLASS } from "./entity-page";

describe("ENTITY_RAIL_CLASS (PILE-653)", () => {
  it("stacks the rail full-width under lg instead of hiding it", () => {
    expect(ENTITY_RAIL_CLASS).not.toContain("hidden");
    expect(ENTITY_RAIL_CLASS).toContain("w-full");
    expect(ENTITY_RAIL_CLASS).toContain("lg:w-72");
    expect(ENTITY_RAIL_CLASS).toContain("lg:border-l");
  });
});
