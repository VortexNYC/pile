import { describe, expect, it } from "vitest";

import { DOCUMENTS_LIST_QUERY } from "./index";

describe("DOCUMENTS_LIST_QUERY (PILE-645)", () => {
  it("locks the documents index to the content-stripped list", () => {
    expect(DOCUMENTS_LIST_QUERY).toEqual({ summary: "1" });
  });
});
