import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  enrichCandidatesWithEffect,
  isSafePublicDomain,
  lookupGooglePlaceDetailsEffect,
  pdlCompanyEnrich,
  pdlRevenueBucketMidpointCents,
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

describe("lookupGooglePlaceDetailsEffect (PILE-657)", () => {
  it("fetches place details with the X-Goog field mask and returns rating + userRatingCount", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return new Response(
          JSON.stringify({
            id: "ChIJ123",
            displayName: { text: "Mile End Delicatessen" },
            rating: 4.5,
            userRatingCount: 1834,
            priceLevel: "PRICE_LEVEL_MODERATE",
            nationalPhoneNumber: "(718) 852-7510",
            websiteUri: "https://www.mileenddeli.com/",
          }),
          { status: 200 }
        );
      })
    );
    const details = await Effect.runPromise(
      lookupGooglePlaceDetailsEffect("gplace:ChIJ123", "places-key")
    );
    expect(calls[0]?.url).toBe(
      "https://places.googleapis.com/v1/places/ChIJ123"
    );
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("x-goog-api-key")).toBe("places-key");
    expect(headers.get("x-goog-fieldmask")).toContain("userRatingCount");
    expect(details).toMatchObject({
      placeId: "ChIJ123",
      displayName: "Mile End Delicatessen",
      rating: 4.5,
      userRatingCount: 1834,
      phone: "(718) 852-7510",
      websiteUri: "https://www.mileenddeli.com/",
    });
    vi.unstubAllGlobals();
  });

  it("returns null without an api key or on HTTP failure", async () => {
    expect(
      await Effect.runPromise(
        lookupGooglePlaceDetailsEffect("gplace:x", undefined)
      )
    ).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 403 }))
    );
    expect(
      await Effect.runPromise(lookupGooglePlaceDetailsEffect("gplace:x", "key"))
    ).toBeNull();
    vi.unstubAllGlobals();
  });

  it("enrichCandidatesWithEffect enriches gplace candidates with foot-traffic volume + revenue_estimate signal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("places.googleapis.com/v1/places/")) {
          return new Response(
            JSON.stringify({
              id: "ChIJ123",
              rating: 4.5,
              userRatingCount: 210,
              nationalPhoneNumber: "(718) 555-0199",
              websiteUri: "https://mileenddeli.com",
            }),
            { status: 200 }
          );
        }
        return new Response("<html></html>", { status: 200 });
      })
    );
    const enriched = await Effect.runPromise(
      enrichCandidatesWithEffect(
        [
          {
            name: "Mile End Delicatessen",
            externalId: "gplace:ChIJ123",
            signal: "contact_found",
          },
        ],
        { googlePlacesApiKey: "places-key" }
      )
    );
    const cand = enriched[0]!;
    expect(cand.placesRating).toBe(4.5);
    expect(cand.placesUserRatingCount).toBe(210);
    expect(cand.domain).toBe("mileenddeli.com");
    expect(cand.phone).toBe("(718) 555-0199");
    // 210 reviews × $150/mo foot-traffic proxy → 3.15M cents.
    expect(cand.estMonthlyVolumeCents).toBe(3_150_000);
    const sig = cand.signals?.find((s) => s.type === "revenue_estimate");
    expect(sig).toMatchObject({
      type: "revenue_estimate",
      source: "google_places",
      strength: 65,
      merchantId: "gplace:ChIJ123",
    });
    expect(sig?.summary).toBe(
      "Google Places foot-traffic proxy: 4.5★ (210 reviews)"
    );
    vi.unstubAllGlobals();
  });
});

describe("pdlCompanyEnrich (PILE-658)", () => {
  it("parses inferred_revenue bucket midpoints to cents", () => {
    expect(pdlRevenueBucketMidpointCents("$1M-$10M")).toBe(550_000_000);
    expect(pdlRevenueBucketMidpointCents("$500K-$1M")).toBe(75_000_000);
    expect(pdlRevenueBucketMidpointCents("$10B+")).toBe(1_000_000_000_000);
    expect(pdlRevenueBucketMidpointCents("<$1M")).toBe(100_000_000);
    expect(pdlRevenueBucketMidpointCents("not-a-bucket")).toBeUndefined();
    expect(pdlRevenueBucketMidpointCents("")).toBeUndefined();
  });

  it("returns inferredRevenue, employeeCount, estMonthlyVolumeCents and a revenue_estimate signal", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls.push({ url: String(input), init });
        return new Response(
          JSON.stringify({
            inferred_revenue: "$1M-$10M",
            employee_count: 42,
            display_name: "Deco Construction Inc",
          }),
          { status: 200 }
        );
      }
    ) as unknown as typeof fetch;
    const enrich = pdlCompanyEnrich("pdl-key", fetchFn);
    const res = await enrich({
      name: "Deco Construction Inc",
      externalId: "socrata:t8hj-ruu2:1",
      address: "92 Sequoia Dr, Coram, NY 11727",
      domain: "decoconstructioninc.com",
      signal: "new_license",
    });
    expect(fetchCalls[0]?.url).toContain(
      "api.peopledatalabs.com/v5/company/enrich"
    );
    expect(fetchCalls[0]?.url).toContain("name=Deco+Construction+Inc");
    expect(new Headers(fetchCalls[0]?.init?.headers).get("x-api-key")).toBe(
      "pdl-key"
    );
    expect(res.inferredRevenue).toBe("$1M-$10M");
    expect(res.employeeCount).toBe(42);
    // $5.5M/yr midpoint → ~$458k/mo card-volume estimate.
    expect(res.estMonthlyVolumeCents).toBe(Math.round(550_000_000 / 12));
    expect(res.signals?.[0]).toMatchObject({
      type: "revenue_estimate",
      source: "pdl_company_enrich",
      strength: 70,
    });
    expect(res.signals?.[0]?.summary).toContain("$1M-$10M");
  });

  it("enrichCandidatesWithEffect wires pdlApiKey as the default paid vendor and merges the result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.peopledatalabs.com")) {
          return new Response(
            JSON.stringify({
              inferred_revenue: "$500K-$1M",
              employee_count: 8,
            }),
            { status: 200 }
          );
        }
        // No mailto/contact email in the crawl → vendor step runs.
        return new Response("<html></html>", { status: 200 });
      })
    );
    const enriched = await Effect.runPromise(
      enrichCandidatesWithEffect(
        [
          {
            name: "No Email Co",
            externalId: "v-2",
            domain: null,
            email: null,
            signal: "new_license",
          },
        ],
        {
          pdlApiKey: "pdl-key",
          paidVendorBudget: {
            vendor: "pdl",
            monthlyCapCents: 10_000,
            spentThisMonthCents: 0,
            requestedCents: 50,
          },
        }
      )
    );
    expect(enriched[0]?.inferredRevenue).toBe("$500K-$1M");
    expect(enriched[0]?.employeeCount).toBe(8);
    expect(enriched[0]?.estMonthlyVolumeCents).toBe(
      Math.round(75_000_000 / 12)
    );
    expect(enriched[0]?.signals?.[0]?.source).toBe("pdl_company_enrich");
    vi.unstubAllGlobals();
  });
});
