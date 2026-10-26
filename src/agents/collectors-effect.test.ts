import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  isSafePublicDomain,
  VendorBudgetExceededError,
  withPaidVendorBudgetEffect,
} from "./collectors-effect.js";

describe("isSafePublicDomain", () => {
  it("accepts ordinary public domains", () => {
    expect(isSafePublicDomain("example.com")).toBe(true);
    expect(isSafePublicDomain("sub.example.co.uk")).toBe(true);
    expect(isSafePublicDomain(" Acme-Shop.IO ")).toBe(true);
  });

  it("rejects localhost, local, and internal hosts", () => {
    expect(isSafePublicDomain("localhost")).toBe(false);
    expect(isSafePublicDomain("foo.local")).toBe(false);
    expect(isSafePublicDomain("foo.internal")).toBe(false);
    expect(isSafePublicDomain("foo.localhost")).toBe(false);
  });

  it("rejects malformed and empty input", () => {
    expect(isSafePublicDomain(null)).toBe(false);
    expect(isSafePublicDomain(undefined)).toBe(false);
    expect(isSafePublicDomain("")).toBe(false);
    expect(isSafePublicDomain("not a domain!!")).toBe(false);
  });
});

describe("withPaidVendorBudgetEffect", () => {
  it("fails with VendorBudgetExceededError when the budget is exhausted", async () => {
    const attempt = withPaidVendorBudgetEffect(
      {
        vendor: "test-vendor",
        monthlyCapCents: 500,
        spentThisMonthCents: 450,
        requestedCents: 100,
      },
      Effect.succeed("never-called")
    );
    const error = await Effect.runPromise(
      Effect.flip(attempt as Effect.Effect<string, VendorBudgetExceededError>)
    );
    expect(error).toBeInstanceOf(VendorBudgetExceededError);
  });

  it("runs the call and returns its value when the budget covers it", async () => {
    const attempt = withPaidVendorBudgetEffect(
      {
        vendor: "test-vendor",
        monthlyCapCents: 500,
        spentThisMonthCents: 100,
        requestedCents: 100,
      },
      Effect.succeed({ enriched: true })
    );
    const result = await Effect.runPromise(attempt);
    expect(result).toEqual({ enriched: true });
  });
});
