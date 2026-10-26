import { describe, expect, it } from "vitest";

import { LIVE_SESSIONS_LIST_QUERY } from "./index";

describe("LIVE_SESSIONS_LIST_QUERY (PILE-645)", () => {
  it("locks the overview live-lanes fetch to summary rows", () => {
    expect(LIVE_SESSIONS_LIST_QUERY).toEqual({
      summary: "1",
      limit: "30",
    });
  });
});
