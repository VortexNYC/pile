import { describe, expect, it } from "vitest";

import {
  lookupNycBuildingSocrata,
  scoreBuildingLead,
} from "./building-scorecard.js";

describe("scoreBuildingLead (PILE-662)", () => {
  it("scores a pre-war large multifamily building as an A-tier XRF lead", () => {
    const breakdown = scoreBuildingLead({
      unitsTotal: 60,
      unitsRes: 58,
      yearBuilt: 1930,
      buildingSqft: 40_000,
      assessedTotalDollars: 4_500_000,
      hpdRegistrationId: "123456",
      openViolationsCount: 9,
      lastSaleDate: "2025-06-01",
      lastSalePriceDollars: 9_000_000,
    });
    // 35 units + 25 LL31 + 15 scale + 10 hpd + 15 violations + 10 sale = 110 → capped.
    expect(breakdown.score).toBe(100);
    expect(breakdown.tier).toBe("A");
    expect(breakdown.xrfLeadPaintEligible).toBe(true);
    expect(breakdown.portfolioScale).toBe("large_multifamily");
    expect(breakdown.whyNow).toContain("XRF");
    expect(breakdown.factors.map((f) => f.key)).toEqual(
      expect.arrayContaining([
        "units",
        "ll31_xrf_pre1960",
        "building_scale",
        "hpd_registered",
        "open_violations",
        "recent_sale",
      ])
    );
    expect(
      breakdown.factors.reduce((sum, f) => sum + f.points, 0)
    ).toBeGreaterThanOrEqual(breakdown.score);
  });

  it("marks 1960–1978 multifamily as XRF eligible with the +15 lead-era factor", () => {
    const breakdown = scoreBuildingLead({
      unitsTotal: 12,
      unitsRes: 12,
      yearBuilt: 1970,
    });
    expect(breakdown.xrfLeadPaintEligible).toBe(true);
    expect(
      breakdown.factors.find((f) => f.key === "pre1978_lead_paint_era")?.points
    ).toBe(15);
    // 20 units (6–19 band) + 15 lead-era = 35.
    expect(breakdown.score).toBe(35);
    expect(breakdown.portfolioScale).toBe("small_multifamily");
  });

  it("awards the specified points per unit-count band", () => {
    const bands: ReadonlyArray<readonly [number, number]> = [
      [50, 35],
      [20, 28],
      [6, 20],
      [3, 12],
      [1, 4],
      [49, 28],
      [19, 20],
      [5, 12],
      [2, 4],
    ];
    for (const [unitsTotal, points] of bands) {
      const breakdown = scoreBuildingLead({ unitsTotal });
      expect(
        breakdown.factors.find((f) => f.key === "units")?.points,
        `unitsTotal=${unitsTotal}`
      ).toBe(points);
      expect(breakdown.score).toBe(points);
    }
  });

  it("pre-1960 buildings under 3 units get no LL31 factor and are not eligible", () => {
    const breakdown = scoreBuildingLead({
      unitsTotal: 2,
      unitsRes: 2,
      yearBuilt: 1940,
    });
    expect(breakdown.xrfLeadPaintEligible).toBe(false);
    expect(
      breakdown.factors.find((f) => f.key === "ll31_xrf_pre1960")
    ).toBeUndefined();
    expect(breakdown.score).toBe(4);
    expect(breakdown.portfolioScale).toBe("single_or_commercial");
  });

  it("uses unitsRes as the dwelling-unit count when unitsTotal is absent", () => {
    const breakdown = scoreBuildingLead({
      unitsRes: 8,
      yearBuilt: 1920,
    });
    expect(breakdown.xrfLeadPaintEligible).toBe(true);
    expect(
      breakdown.factors.find((f) => f.key === "ll31_xrf_pre1960")?.points
    ).toBe(25);
  });

  it("building scale factor picks the higher band and accepts assessed value alone", () => {
    expect(scoreBuildingLead({ buildingSqft: 30_000 }).score).toBe(15);
    expect(scoreBuildingLead({ assessedTotalDollars: 2_500_000 }).score).toBe(
      15
    );
    expect(scoreBuildingLead({ buildingSqft: 6_000 }).score).toBe(8);
    expect(scoreBuildingLead({ assessedTotalDollars: 600_000 }).score).toBe(8);
    expect(scoreBuildingLead({ buildingSqft: 2_000 }).score).toBe(0);
  });

  it("recent ACRIS sale only counts inside the 3-year window", () => {
    const nowMs = Date.parse("2026-10-01T00:00:00.000Z");
    const recent = scoreBuildingLead(
      { lastSaleDate: "2025-01-15", lastSalePriceDollars: 1_200_000 },
      { nowMs }
    );
    expect(recent.factors.find((f) => f.key === "recent_sale")?.points).toBe(
      10
    );
    const stale = scoreBuildingLead({ lastSaleDate: "2020-01-15" }, { nowMs });
    expect(stale.factors.find((f) => f.key === "recent_sale")).toBeUndefined();
    const future = scoreBuildingLead({ lastSaleDate: "2027-01-15" }, { nowMs });
    expect(future.factors.find((f) => f.key === "recent_sale")).toBeUndefined();
  });

  it("tiers map to score bands; empty attributes score 0 / D", () => {
    const empty = scoreBuildingLead({});
    expect(empty.score).toBe(0);
    expect(empty.tier).toBe("D");
    expect(empty.xrfLeadPaintEligible).toBe(false);
    expect(empty.portfolioScale).toBe("single_or_commercial");
    expect(empty.factors).toHaveLength(0);

    // 25 (LL31) + 12 (3–5 units) = 37 → C; +10 HPD = 47 still C; +15
    // violations = 62 → B.
    expect(
      scoreBuildingLead({
        unitsTotal: 4,
        yearBuilt: 1950,
        hpdRegistrationId: "9",
      }).tier
    ).toBe("C");
    expect(
      scoreBuildingLead({
        unitsTotal: 4,
        yearBuilt: 1950,
        hpdRegistrationId: "9",
        openViolationsCount: 2,
      }).tier
    ).toBe("B");
  });
});

describe("lookupNycBuildingSocrata (PILE-662)", () => {
  const plutoRow = {
    borough: "BK",
    zipcode: "11206",
    address: "123 KNICKERBOCKER AVENUE",
    bbl: "3043210021",
    bin: "3078965",
    unitsres: "6",
    unitstotal: "6",
    bldgarea: "7800",
    assesstot: "540000",
    yearbuilt: "1931",
  };

  it("maps PLUTO + HPD registration rows into BuildingAttributes", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/64uk-42ks.json")) {
        return new Response(JSON.stringify([plutoRow]), { status: 200 });
      }
      if (url.includes("/tesw-yqqr.json")) {
        return new Response(JSON.stringify([{ registrationid: "8899" }]), {
          status: 200,
        });
      }
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    const attrs = await lookupNycBuildingSocrata(
      "123 Knickerbocker Ave, Brooklyn, NY 11206",
      "Bushwick",
      { fetchFn }
    );

    expect(attrs.bbl).toBe("3043210021");
    expect(attrs.bin).toBe("3078965");
    expect(attrs.borough).toBe("Brooklyn");
    expect(attrs.zipcode).toBe("11206");
    expect(attrs.unitsRes).toBe(6);
    expect(attrs.unitsTotal).toBe(6);
    expect(attrs.buildingSqft).toBe(7800);
    expect(attrs.assessedTotalDollars).toBe(540000);
    expect(attrs.yearBuilt).toBe(1931);
    expect(attrs.hpdRegistrationId).toBe("8899");

    // PLUTO query hits the dataset with the (suffix-expanded) street name
    // and the Brooklyn borough clause derived from the address.
    const plutoCall = calls.find((u) => u.includes("64uk-42ks"));
    expect(plutoCall).toBeDefined();
    expect(plutoCall).toContain("KNICKERBOCKER");
    expect(plutoCall).toContain("borough");
    // HPD query resolves the registration by the PLUTO bbl.
    const hpdCall = calls.find((u) => u.includes("tesw-yqqr"));
    expect(hpdCall).toBeDefined();
    expect(hpdCall).toContain("boroid");
  });

  it("retries the PLUTO query without the house number when the strict match is empty", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/64uk-42ks.json")) {
        // First call carries the house-number clause → empty; the
        // street-only retry finds the row.
        return url.includes("123")
          ? new Response("[]", { status: 200 })
          : new Response(JSON.stringify([plutoRow]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    }) as typeof fetch;

    const attrs = await lookupNycBuildingSocrata(
      "123 Knickerbocker Ave",
      "Brooklyn",
      { fetchFn }
    );
    expect(
      calls.filter((u) => u.includes("64uk-42ks")).length
    ).toBeGreaterThanOrEqual(2);
    expect(attrs.bbl).toBe("3043210021");
    expect(attrs.unitsTotal).toBe(6);
  });

  it("degrades gracefully on HTTP errors and empty results", async () => {
    const failing = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;
    const attrs = await lookupNycBuildingSocrata("999 Nowhere Ln", "Brooklyn", {
      fetchFn: failing,
    });
    expect(attrs.borough).toBe("Brooklyn");
    expect(attrs.unitsTotal).toBeUndefined();
    expect(attrs.bbl).toBeUndefined();

    const empty = (async () =>
      new Response("[]", { status: 200 })) as typeof fetch;
    const attrs2 = await lookupNycBuildingSocrata("999 Nowhere Ln", null, {
      fetchFn: empty,
    });
    expect(attrs2.unitsTotal).toBeUndefined();
    expect(attrs2.bbl).toBeUndefined();
  });

  it("never throws on a network-level failure", async () => {
    const throwing = (async () => {
      throw new Error("socket hangup");
    }) as typeof fetch;
    const attrs = await lookupNycBuildingSocrata("1 Main St", "Queens", {
      fetchFn: throwing,
    });
    expect(attrs.borough).toBe("Queens");
    expect(attrs.unitsTotal).toBeUndefined();
  });
});
