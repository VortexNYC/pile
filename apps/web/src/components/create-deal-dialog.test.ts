import { describe, expect, it } from "vitest";

import { parseDealAmountCents } from "./create-deal-dialog";

describe("parseDealAmountCents", () => {
  it("converts decimal input to integer cents, empty stays unset", () => {
    expect(parseDealAmountCents("12.50")).toBe(1250);
    expect(parseDealAmountCents("")).toBeNull();
    expect(parseDealAmountCents("0.01")).toBe(1);
  });
});
