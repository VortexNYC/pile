import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  CollectorSourceError,
  ComputeBackendError,
  enrichCandidatesWithEffect,
  evaluateApprovedBatchWithEffect,
  fetchHtmlWaterfallEffect,
  isSafePublicDomain,
  partitionTasksWithEffect,
  pullSourceEffect,
  runMacMiniFetchWithRetryEffect,
  VendorBudgetExceededError,
  withFailoverEffect,
  withPaidVendorBudgetEffect,
} from "./collectors-effect.js";
import {
  classifyMerchantLead,
  deriveDomainFromEmail,
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

  it("pullSourceEffect retries transient Socrata 503 failure with Effect.retry and surfaces CollectorSourceError on unsupported kind", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("busy", { status: 503 });
        }
        return new Response(
          JSON.stringify([
            {
              license_sl_no: "100999",
              license_type: "MASTER PLUMBER",
              business_name: "ACME PLUMBING LLC",
              business_phone_number: "2125550100",
              business_email: "ops@acmeplumbing.nyc",
            },
          ]),
          { status: 200 }
        );
      })
    );
    const res = await Effect.runPromise(
      pullSourceEffect(
        PRESET_NON_POS_SMB_SOURCES.nyc_dob_contractors_and_trades,
        undefined,
        { limit: 1 }
      )
    );
    expect(calls).toBe(2);
    expect(res.candidates[0]?.domain).toBe("acmeplumbing.nyc");

    const bad = await Effect.runPromise(
      Effect.flip(
        pullSourceEffect({
          id: "bad-1",
          name: "bad",
          kind: "unknown_kind",
          config: "{}",
          cursorField: null,
          cursorValue: null,
          signal: "new_license",
        })
      )
    );
    expect(bad).toBeInstanceOf(CollectorSourceError);
    expect(bad._tag).toBe("CollectorSourceError");
    vi.unstubAllGlobals();
  });

  it("enrichCandidatesWithEffect probes public domains concurrently, fingerprints billing stack + mailto, and blocks unsafe SSRF domains", async () => {
    expect(isSafePublicDomain("localhost")).toBe(false);
    expect(isSafePublicDomain("127.0.0.1")).toBe(false);
    expect(isSafePublicDomain("internal.local")).toBe(false);
    expect(isSafePublicDomain("acmeplumbing.nyc")).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            '<html><body><a href="mailto:owner@acmeplumbing.nyc">Email</a><script src="https://connect.intuit.com/quickbooks.js"></script></body></html>',
            { status: 200 }
          )
      )
    );
    const enriched = await Effect.runPromise(
      enrichCandidatesWithEffect([
        {
          name: "ACME PLUMBING LLC",
          externalId: "socrata:t8hj-ruu2:1",
          domain: "acmeplumbing.nyc",
          signal: "new_license",
        },
        {
          name: "LOCALHOST CO",
          externalId: "socrata:t8hj-ruu2:2",
          domain: "localhost",
          signal: "new_license",
        },
      ])
    );
    expect(enriched[0]).toMatchObject({
      email: "owner@acmeplumbing.nyc",
      posGuess: "quickbooks",
      posEvidenceUrl: "https://acmeplumbing.nyc",
    });
    expect(enriched[1]?.posGuess).toBeNull();
    vi.unstubAllGlobals();
  });

  it("promotes VTX-692 Detective rules into Tier 1: paired DOB Master Electrician (license_sl_no+1), NY DOS n9v6-gdp6 lookup, Mac mini Scrapling/Firecrawl waterfall, international freemail guard, and VendorBudgetExceededError", async () => {
    expect(deriveDomainFromEmail("marcolamberti@yahoo.it")).toBeNull();
    expect(deriveDomainFromEmail("user@hotmail.co.uk")).toBeNull();
    expect(deriveDomainFromEmail("info@precisionprecastconcrete.com")).toBe(
      "precisionprecastconcrete.com"
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("t8hj-ruu2.json")) {
          return new Response(
            JSON.stringify([
              {
                license_sl_no: "102953",
                first_name: "MARCO",
                last_name: "LAMBERTI",
              },
            ]),
            { status: 200 }
          );
        }
        if (url.includes("n9v6-gdp6.json")) {
          return new Response(
            JSON.stringify([
              {
                dos_id: "7574460",
                initial_dos_filing_date: "2025-02-05T00:00:00.000",
                dos_process_name: "LAMBERTI ELECTRIC INC.",
              },
            ]),
            { status: 200 }
          );
        }
        if (url === "https://blocked-contractor.nyc") {
          return new Response("Just a moment... cf-browser-verification", {
            status: 200,
          });
        }
        if (url === "https://scrapling.pile.nyc/fetch") {
          return new Response(
            JSON.stringify({
              html: '<html><script src="https://getjobber.com/widget.js"></script></html>',
            }),
            { status: 200 }
          );
        }
        return new Response("", { status: 404 });
      })
    );

    const wf = await Effect.runPromise(
      fetchHtmlWaterfallEffect("https://blocked-contractor.nyc", {
        scraplingBaseUrl: "https://scrapling.pile.nyc",
        firecrawlBaseUrl: "https://firecrawl.pile.nyc",
      })
    );
    expect(wf.tier).toBe("scrapling");

    const enriched = await Effect.runPromise(
      enrichCandidatesWithEffect(
        [
          {
            name: "LAMBERTI ELECTRIC INC",
            externalId: "socrata:t8hj-ruu2:102952",
            domain: "blocked-contractor.nyc",
            ownerName: null,
            signal: "new_license",
          },
        ],
        {
          scraplingBaseUrl: "https://scrapling.pile.nyc",
          lookupDos: true,
        }
      )
    );
    expect(enriched[0]).toMatchObject({
      ownerName: "MARCO LAMBERTI",
      dosId: "7574460",
      posGuess: "jobber",
      scrapeTier: "scrapling",
    });

    const budgetErr = await Effect.runPromise(
      Effect.flip(
        withPaidVendorBudgetEffect(
          {
            vendor: "apollo",
            monthlyCapCents: 10_000,
            spentThisMonthCents: 9_980,
            requestedCents: 50,
          },
          Effect.succeed("ok")
        )
      )
    );
    expect(budgetErr).toBeInstanceOf(VendorBudgetExceededError);
    expect(budgetErr._tag).toBe("VendorBudgetExceededError");
    vi.unstubAllGlobals();
  });

  it("runs all 4 Effect orchestrator primitives: runMacMiniFetchWithRetryEffect (502 tunnel retry), withFailoverEffect (primary -> fallback), partitionTasksWithEffect, and evaluateApprovedBatchWithEffect", async () => {
    let tunnelCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        tunnelCalls += 1;
        if (tunnelCalls === 1) {
          return new Response("bad gateway", { status: 502 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );
    const macRes = await Effect.runPromise(
      runMacMiniFetchWithRetryEffect({
        tier: "firecrawl scrape",
        url: "https://firecrawl.pile.nyc/v1/scrape",
        init: { method: "POST" },
      })
    );
    expect(tunnelCalls).toBe(2);
    expect(macRes.status).toBe(200);
    vi.unstubAllGlobals();

    const switched: ComputeBackendError[] = [];
    const failoverResult = await Effect.runPromise(
      withFailoverEffect({
        operation: "createSandbox",
        primaryName: "daytona",
        fallbackName: "cloudflare",
        primary: async () => {
          throw new Error("daytona quota reached");
        },
        fallback: async () => "cf-sandbox-1",
        onSwitch: (err) => switched.push(err),
      })
    );
    expect(failoverResult).toBe("cf-sandbox-1");
    expect(switched[0]?.backend).toBe("daytona");

    const part = await Effect.runPromise(
      partitionTasksWithEffect([1, 2, 3], async (n) => {
        if (n === 2) throw new Error("item 2 failed");
        return n * 10;
      })
    );
    expect(part.successes).toEqual([10, 30]);
    expect(part.failures).toEqual([{ message: "item 2 failed" }]);

    const batchGate = await Effect.runPromise(
      evaluateApprovedBatchWithEffect([
        {
          customerId: "c-pass",
          name: "Metro Electric",
          channel: "email",
          contactEmail: "owner@metroelectric.nyc",
          emailStatus: "valid",
        },
        {
          customerId: "c-block",
          name: "Opted Out Corp",
          channel: "email",
          contactEmail: "owner@optedout.nyc",
          suppressedCustomer: true,
        },
      ])
    );
    expect(batchGate.approved).toHaveLength(1);
    expect(batchGate.approved[0]?.customerId).toBe("c-pass");
    expect(batchGate.blocked).toHaveLength(1);
    expect(batchGate.blocked[0]?.customerId).toBe("c-block");

    expect(
      classifyMerchantLead({
        name: "JAEHWAN LEE CPA P.C.",
        vertical: "DOMESTIC PROFESSIONAL SERVICE CORPORATION",
      })
    ).toMatchObject({
      sheetKey: "partners_accounting",
      categoryLabel: "Bookkeeper / CPA Partner",
    });
    expect(
      classifyMerchantLead({
        name: "MARINO VENTURES LLC",
        vertical: "DOMESTIC LIMITED LIABILITY COMPANY",
      })
    ).toMatchObject({
      sheetKey: "partners_vc",
      categoryLabel: "VC / Fund Partner",
    });
  });
});
