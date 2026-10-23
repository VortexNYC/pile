import { describe, expect, it } from "vitest";

import {
  applyFieldWriteWithProvenance,
  backfillSignalsFromSourceItems,
  computeSmbMatchKey,
  detectPosTechnographics,
  identifyContactWithConsent,
  mapPostHogEventToSignal,
  planDetectiveWaterfall,
  rankMerchantSignals,
  validateResearchAnswer,
} from "./signals-engine.js";

describe("Unify-parity Signals, Ranker v2, Provenance & Technographics (PILE-507..533)", () => {
  const NOW = "2026-10-22T18:00:00.000Z";

  it("backfills signals, evaluates ICP + decayed signals + 3-signal stack bonus, and generates cited Why Now (PILE-507..510)", () => {
    const signals = backfillSignalsFromSourceItems([
      {
        id: "sla-1",
        merchantId: "m-1",
        sourceName: "nys_sla",
        signalType: "new_license",
        observedAt: "2026-10-20T00:00:00.000Z",
        evidenceUrl: "https://data.ny.gov/sla/1",
        strength: 95,
        summary: "Pending liquor license filed Oct 20",
      },
      {
        id: "own-1",
        merchantId: "m-1",
        sourceName: "ny_dos",
        signalType: "ownership_change",
        observedAt: "2026-10-18T00:00:00.000Z",
        evidenceUrl: "https://dos.ny.gov/corp/1",
        strength: 90,
        summary: "New LLC officer registered",
      },
    ]);
    const pos = detectPosTechnographics({
      merchantId: "m-1",
      pageUrl: "https://bleeckerbistro.example.com",
      html: '<script src="https://order.toasttab.com/widget.js"></script>',
      observedAt: "2026-10-21T00:00:00.000Z",
    });
    expect(pos.posGuess).toBe("toast");
    signals.push(pos.signal!);

    const breakdown = rankMerchantSignals({
      merchantId: "m-1",
      merchantAttrs: {
        category: "restaurant",
        monthlyVolume: 65_000,
      },
      signals,
      config: {
        motion: "smb_hospitality",
        icpRules: [
          {
            id: "icp-cat",
            motion: "smb_hospitality",
            field: "category",
            op: "in",
            value: ["restaurant", "bar"],
            weight: 25,
          },
          {
            id: "icp-vol",
            motion: "smb_hospitality",
            field: "monthlyVolume",
            op: "gte",
            value: 50_000,
            weight: 15,
          },
        ],
        signalRules: [
          {
            type: "new_license",
            polarity: "positive",
            weight: 40,
            activeForDays: 60,
          },
          {
            type: "ownership_change",
            polarity: "positive",
            weight: 30,
            activeForDays: 60,
          },
          {
            type: "pos_detected",
            polarity: "positive",
            weight: 25,
            activeForDays: 90,
          },
        ],
      },
      nowIso: NOW,
    });

    expect(breakdown.fitScore).toBe(90);
    expect(breakdown.fitRating).toBe("great");
    expect(breakdown.stackBonusApplied).toBe(true);
    expect(breakdown.priorityScore).toBeGreaterThanOrEqual(85);
    expect(breakdown.whyNow).toContain(
      "Pending liquor license filed Oct 20 [sig_sla-1]"
    );
    expect(breakdown.whyNowSignalIds).toHaveLength(3);
  });

  it("enforces consent-based identify and maps PostHog product events to Signals (PILE-511 / PILE-513)", () => {
    expect(
      identifyContactWithConsent({
        contactId: "c-1",
        merchantId: "m-1",
        email: "owner@bistro.com",
        posthogDistinctId: "ph_user_1",
        source: "ip_reveal",
        explicitConsent: true,
      })
    ).toBeNull();

    const consented = identifyContactWithConsent({
      contactId: "c-1",
      merchantId: "m-1",
      email: "owner@bistro.com",
      posthogDistinctId: "ph_user_1",
      source: "signup",
      explicitConsent: true,
      nowIso: NOW,
    });
    expect(consented?.consentSource).toBe("signup");

    const sig = mapPostHogEventToSignal({
      eventId: "evt_99",
      eventName: "pricing_view",
      distinctId: "ph_user_1",
      timestamp: NOW,
      identity: consented,
      mappings: [
        {
          eventName: "pricing_view",
          signalType: "pricing_view",
          strength: 80,
          summaryTemplate: "Viewed pricing page after signup",
        },
      ],
    });
    expect(sig?.type).toBe("pricing_view");
    expect(sig?.source).toBe("posthog");
  });

  it("validates typed research answers with cited evidence, SMB match keys, field provenance, and Detective waterfall (PILE-512 / PILE-518..530)", () => {
    const q = {
      key: "pos_system",
      type: "select" as const,
      prompt: "Which POS is visible?",
      options: ["toast", "square", "clover", "unknown"],
    };
    expect(
      validateResearchAnswer(q, {
        merchantId: "m-1",
        key: "pos_system",
        value: "toast",
        evidenceUrl: "",
        confidence: 0.9,
        answeredAt: NOW,
      }).valid
    ).toBe(false);
    expect(
      validateResearchAnswer(q, {
        merchantId: "m-1",
        key: "pos_system",
        value: "toast",
        evidenceUrl: "https://bleeckerbistro.example.com",
        confidence: 0.95,
        answeredAt: NOW,
      }).valid
    ).toBe(true);

    const k1 = computeSmbMatchKey({
      name: "The Bleecker Street Cafe LLC",
      address: "123 Bleecker Street, Suite 2",
      phone: "(212) 555-0199",
    });
    const k2 = computeSmbMatchKey({
      name: "Bleecker St Cafe",
      address: "123 Bleecker St Ste 2",
      phone: "1-212-555-0199",
    });
    expect(k1.matchKey).toBe(k2.matchKey);
    expect(k1.phoneE164).toBe("+12125550199");

    // Field provenance: human value beats agent overwrite
    const step1 = applyFieldWriteWithProvenance(
      {},
      {},
      {
        entityId: "m-1",
        field: "phone",
        value: "+12125550100",
        source: "manual_edit",
        actorId: "user-ronnie",
        writerRole: "human",
        mode: "overwrite",
        nowIso: NOW,
      }
    );
    expect(step1.applied).toBe(true);
    const step2 = applyFieldWriteWithProvenance(
      step1.record,
      step1.provenanceByField,
      {
        entityId: "m-1",
        field: "phone",
        value: "+12125559999",
        source: "detective",
        actorId: "agent-detective",
        writerRole: "agent",
        mode: "overwrite",
        nowIso: NOW,
      }
    );
    expect(step2.applied).toBe(false);
    expect(step2.record.phone).toBe("+12125550100");

    // Detective waterfall: free first, paid only above rank threshold + budget
    expect(
      planDetectiveWaterfall({
        rankScore: 60,
        paidRankThreshold: 80,
        monthlyBudgetRemainingCents: 10_000,
        estimatedPaidLookupCents: 50,
      })
    ).toEqual(["pile_records", "public_registries", "website_crawl"]);
    expect(
      planDetectiveWaterfall({
        rankScore: 88,
        paidRankThreshold: 80,
        monthlyBudgetRemainingCents: 10_000,
        estimatedPaidLookupCents: 50,
      })
    ).toEqual([
      "pile_records",
      "public_registries",
      "website_crawl",
      "paid_vendor",
    ]);
  });
});
