import { describe, expect, it } from "vitest";

import {
  buildRepMorningBrief,
  checkBookOwnershipGuard,
  checkVendorBudgetHardStop,
  computePipelineAttribution,
  queryDynamicAudience,
  runMerchantLeadPlay,
} from "./lead-play-engine.js";

const NOW = "2026-04-20T14:00:00.000Z";

describe("lead-play-engine (PILE-514..527, PILE-549..563)", () => {
  it("queries dynamic audiences with nested AND/OR filters and excludes suppressed merchants (PILE-514..517)", () => {
    const merchants = [
      {
        id: "m-1",
        name: "Bleecker Osteria",
        vertical: "restaurant",
        neighborhood: "west village",
        processor: "toast",
        priorityScore: 88,
        fitScore: 90,
        fitStatus: "great",
        address: "123 Bleecker St",
        phone: "+12125550101",
        signalTypes: ["new_license", "pos_detected"],
      },
      {
        id: "m-2",
        name: "SoHo Dry Cleaners",
        vertical: "retail",
        neighborhood: "soho",
        processor: "square",
        priorityScore: 72,
        fitScore: 75,
        fitStatus: "good",
        address: "45 Spring St",
        phone: "+12125550102",
        signalTypes: ["pos_detected"],
      },
      {
        id: "m-3",
        name: "Suppressed Trattoria",
        vertical: "restaurant",
        neighborhood: "west village",
        processor: "toast",
        priorityScore: 95,
        fitScore: 95,
        fitStatus: "great",
        suppressed: true,
        signalTypes: ["new_license"],
      },
    ];

    const matched = queryDynamicAudience(merchants, {
      logic: "and",
      predicates: [
        { field: "vertical", op: "eq", value: "restaurant" },
        { field: "priorityScore", op: "gte", value: 75 },
        { field: "signal", op: "has_signal", value: "new_license" },
      ],
    });
    expect(matched.map((m) => m.id)).toEqual(["m-1"]);
  });

  it("predicates and lead play rank on reported monthly card volume (PILE-654)", () => {
    const volumeMerchants = [
      { id: "m-big", name: "Big Deli", estMonthlyVolumeCents: 5_000_000 },
      { id: "m-small", name: "Small Cart", estMonthlyVolumeCents: 400_000 },
      { id: "m-unknown", name: "Unknown Co" },
    ];
    // gte hits only reported volume; lte must not treat unknown as zero.
    expect(
      queryDynamicAudience(volumeMerchants, {
        logic: "and",
        predicates: [
          { field: "estMonthlyVolumeCents", op: "gte", value: 1_000_000 },
        ],
      }).map((m) => m.id)
    ).toEqual(["m-big"]);
    expect(
      queryDynamicAudience(volumeMerchants, {
        logic: "and",
        predicates: [
          { field: "estMonthlyVolumeCents", op: "lte", value: 6_000_000 },
        ],
      })
        .map((m) => m.id)
        .toSorted()
    ).toEqual(["m-big", "m-small"]);

    const receipt = runMerchantLeadPlay({
      merchant: {
        id: "m-big",
        name: "Big Deli",
        vertical: "retail",
        estMonthlyVolumeCents: 5_000_000,
      },
      signals: [
        {
          id: "sig_intake_v1",
          merchantId: "m-big",
          type: "revenue_estimate",
          source: "intake",
          observedAt: NOW,
          evidenceUrl: "intake:visit-1",
          strength: 90,
        },
      ],
      nowIso: NOW,
    });
    expect(receipt.breakdown.matchedIcpRules).toContain(
      "icp-est-monthly-card-volume"
    );
    expect(receipt.breakdown.priorityScore).toBeGreaterThan(0);
  });

  it("enforces vendor budget hard-stops and book ownership guards (PILE-549, PILE-553)", () => {
    const budgetOk = checkVendorBudgetHardStop(
      { vendor: "reacher", monthlyCapCents: 5000, spentThisMonthCents: 4900 },
      50
    );
    expect(budgetOk.allowed).toBe(true);
    expect(budgetOk.remainingCents).toBe(50);

    const budgetBlocked = checkVendorBudgetHardStop(
      { vendor: "apollo", monthlyCapCents: 5000, spentThisMonthCents: 4980 },
      50
    );
    expect(budgetBlocked.allowed).toBe(false);
    expect(budgetBlocked.reason).toBe("VENDOR_BUDGET_EXCEEDED");

    expect(
      checkBookOwnershipGuard({
        merchantOwnerId: "rep-ronnie",
        actorUserId: "rep-other",
        action: "claim",
      })
    ).toEqual({
      allowed: false,
      blockedReason: "ALREADY_CLAIMED_BY_OTHER_REP",
    });

    expect(
      checkBookOwnershipGuard({
        merchantOwnerId: "rep-ronnie",
        actorUserId: "rep-other",
        action: "engage",
      })
    ).toEqual({
      allowed: true,
      warning: "OWNED_BY_OTHER_REP",
    });
  });

  it("runs end-to-end lead play (Profiler -> Detective -> SendGate -> Drafter awaiting_approval) (PILE-521..527)", () => {
    const receipt = runMerchantLeadPlay({
      merchant: {
        id: "m-1",
        name: "Metro HVAC & Contracting",
        vertical: "home improvement contractor",
        address: "123 Bleecker St, New York, NY",
        phone: "+12125550101",
      },
      signals: [
        {
          id: "sig_sla_1",
          merchantId: "m-1",
          type: "new_license",
          source: "sla",
          observedAt: NOW,
          evidenceUrl: "https://sla.ny.gov/lic/1",
          strength: 90,
        },
      ],
      html: '<script src="https://www.toasttab.com/restaurants/bleecker"></script>',
      pageUrl: "https://bleeckerosteria.com",
      paidRankThreshold: 60,
      // PILE-610 — paid_vendor requires explicit vendor configuration.
      vendorBudget: {
        vendor: "hunter",
        monthlyCapCents: 10_000,
        spentThisMonthCents: 0,
      },
      nowIso: NOW,
    });

    expect(receipt.status).toBe("awaiting_approval");
    expect(receipt.posGuess).toBe("toast");
    expect(receipt.breakdown.priorityScore).toBeGreaterThanOrEqual(60);
    expect(receipt.waterfallSteps).toContain("paid_vendor");
    expect(receipt.draftedTouch?.channel).toBe("visit");
    expect(receipt.draftedTouch?.body).toContain("Why now:");
    expect(receipt.draftedTouch?.body).toContain("TOAST");
    expect(receipt.draftedTouch?.evidenceSignalIds).toContain("sig_sla_1");
  });

  it("computes 90-day pipeline attribution and builds rep morning brief (PILE-555..559)", () => {
    const attr = computePipelineAttribution({
      merchantId: "m-1",
      boardedAt: "2026-04-20T14:00:00.000Z",
      touchpoints: [
        {
          merchantId: "m-1",
          signalType: "new_license",
          playName: "nyc_smb_signal_to_draft",
          cadenceId: "cad_hospitality_v1",
          touchedAt: "2026-03-15T10:00:00.000Z",
          replied: true,
          costCents: 45,
        },
      ],
    });
    expect(attr.attributionType).toBe("direct");
    expect(attr.firstTouchSignal).toBe("new_license");
    expect(attr.mostRecentPlay).toBe("nyc_smb_signal_to_draft");
    expect(attr.totalAcquisitionCostCents).toBe(45);

    const brief = buildRepMorningBrief({
      merchants: [
        {
          id: "m-2",
          name: "Low Priority Cafe",
          priorityScore: 42,
          fitScore: 60,
          address: "10 MacDougal St",
        },
        {
          id: "m-1",
          name: "Bleecker Osteria",
          priorityScore: 91,
          fitScore: 90,
          processor: "toast",
          whyNow:
            "Why now: New liquor license [sig_sla_1]; Uses Toast POS [sig_pos_1].",
          address: "123 Bleecker St",
          phone: "+12125550101",
        },
      ],
      limit: 5,
    });
    expect(brief.items[0]?.merchantId).toBe("m-1");
    expect(brief.items[0]?.recommendedAction).toBe("walk_in_visit");
  });
});
