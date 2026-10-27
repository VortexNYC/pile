import { describe, expect, it } from "vitest";

import { customerDealsQuery } from "./$customerId";

describe("customerDealsQuery (PILE-653)", () => {
  it("scopes to the customer on the bounded summary contract", () => {
    expect(customerDealsQuery("c-1")).toEqual({
      customerId: "c-1",
      summary: "1",
      limit: 500,
    });
  });
});
