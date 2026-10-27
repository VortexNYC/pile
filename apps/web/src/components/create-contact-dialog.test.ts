import { describe, expect, it } from "vitest";

import { newContactBody } from "./create-contact-dialog";

describe("newContactBody", () => {
  it("trims fields and only links a company when one is picked", () => {
    expect(
      newContactBody({
        email: "  a@b.co ",
        fullName: "  ",
        phone: "",
        customerId: "",
      })
    ).toEqual({
      email: "a@b.co",
      fullName: undefined,
      phone: undefined,
      companies: undefined,
    });
    expect(
      newContactBody({
        email: "a@b.co",
        fullName: "A B",
        phone: "555",
        customerId: "cust-1",
      }).companies
    ).toEqual([{ companyId: "cust-1", isPrimary: true }]);
  });
});
