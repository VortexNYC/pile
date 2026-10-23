import { describe, expect, it, vi } from "vitest";

import {
  PRESET_NON_POS_SMB_SOURCES,
  pullSource,
  scoreCandidate,
  type MerchantCandidate,
} from "./collectors.js";

const base: MerchantCandidate = {
  name: "Test Co",
  externalId: "test:1",
  signal: "registration",
  signalDate: null,
};

describe("scoreCandidate", () => {
  it("ranks license_pending above registration", () => {
    const today = new Date().toISOString();
    const pending = scoreCandidate({
      ...base,
      signal: "license_pending",
      signalDate: today,
    });
    const reg = scoreCandidate({ ...base, signalDate: today });
    expect(pending).toBeGreaterThan(reg);
  });

  it("decays stale signals — a filing this week outranks last quarter", () => {
    const fresh = scoreCandidate({
      ...base,
      signal: "corp_filing",
      signalDate: new Date(Date.now() - 86400000).toISOString(),
    });
    const stale = scoreCandidate({
      ...base,
      signal: "corp_filing",
      signalDate: new Date(Date.now() - 90 * 86400000).toISOString(),
    });
    expect(fresh).toBeGreaterThan(stale);
  });

  it("unknown signals get a base weight and still decay", () => {
    const score = scoreCandidate({
      ...base,
      signal: "weird_signal",
      signalDate: new Date().toISOString(),
    });
    expect(score).toBeLessThanOrEqual(0.4);
    expect(score).toBeGreaterThan(0);
    const ancient = scoreCandidate({ ...base, signal: "weird_signal" });
    expect(ancient).toBe(0);
  });

  it("pulls NYC non-POS SMB presets from Socrata and extracts phone, borough, and composed street address", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                license_nbr: "2099111-DCA",
                business_name: "METRO HVAC & CONTRACTING CORP",
                business_category: "Home Improvement Contractor",
                license_creation_date: "2026-03-10T00:00:00.000",
                contact_phone: "7185550199",
                address_building: "420",
                address_street_name: "LEXINGTON AVE",
                address_city: "NEW YORK",
                address_state: "NY",
                address_zip: "10170",
                address_borough: "Manhattan",
              },
            ]),
            { status: 200 }
          )
      )
    );
    const out = await pullSource(
      PRESET_NON_POS_SMB_SOURCES.nyc_home_improvement_contractors,
      undefined,
      { limit: 5, extraWhere: "address_borough='Manhattan'" }
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toMatchObject({
      name: "METRO HVAC & CONTRACTING CORP",
      phone: "7185550199",
      neighborhood: "Manhattan",
      vertical: "Home Improvement Contractor",
      address: "420 LEXINGTON AVE, NEW YORK, NY, 10170",
    });
    vi.unstubAllGlobals();
  });
});
