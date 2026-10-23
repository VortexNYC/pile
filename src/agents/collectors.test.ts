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

  it("pulls NYC non-POS SMB presets from Socrata and extracts phone, email, ownerName, derived domain, borough, and composed street address", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                license_sl_no: "100826",
                license_type: "GENERAL CONTRACTOR",
                first_name: "GEORGE",
                last_name: "PAPADIONISOPOULOS",
                business_name: "DECO CONSTRUCTION INC",
                business_house_number: "92",
                business_street_name: "SEQUOIA DRIVE",
                license_business_city: "CORAM",
                business_state: "NY",
                business_zip_code: "11727",
                business_email: "INFO@DECOCONSTRUCTIONINC.COM",
                business_phone_number: "3476547642",
                license_status: "ACTIVE",
              },
            ]),
            { status: 200 }
          )
      )
    );
    const out = await pullSource(
      PRESET_NON_POS_SMB_SOURCES.nyc_dob_contractors_and_trades,
      undefined,
      { limit: 5, offset: 10 }
    );
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toMatchObject({
      name: "DECO CONSTRUCTION INC",
      ownerName: "GEORGE PAPADIONISOPOULOS",
      email: "info@decoconstructioninc.com",
      domain: "decoconstructioninc.com",
      phone: "3476547642",
      neighborhood: "CORAM",
      vertical: "GENERAL CONTRACTOR",
      address: "92 SEQUOIA DRIVE, CORAM, NY, 11727",
    });
    vi.unstubAllGlobals();
  });
});
