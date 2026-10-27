import { describe, expect, it } from "vitest";

import { contactDealsQuery } from "./$contactId";

describe("contactDealsQuery (PILE-653)", () => {
  it("scopes to the contact on the bounded summary contract", () => {
    expect(contactDealsQuery("ct-1")).toEqual({
      contactId: "ct-1",
      summary: "1",
      limit: 500,
    });
  });
});
