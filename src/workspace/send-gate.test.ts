import { describe, expect, it } from "vitest";

import {
  applyCallDispositionPermissionFlags,
  evaluateExclusions,
  evaluateSendGate,
} from "./send-gate.js";

describe("Outbound Send Gate & Permission Foundation (PILE-478..482)", () => {
  const NOW = "2026-10-22T20:00:00.000Z";

  it("blocks on merchant DNC, contact opt-out, channel flags, and EU consent (PILE-478)", () => {
    const dnc = evaluateSendGate({
      touchId: "t-1",
      channel: "email",
      now: NOW,
      merchant: {
        id: "m-1",
        permissions: { doNotContact: true },
      },
      contact: {
        id: "c-1",
        permissions: { emailStatus: "valid" },
      },
    });
    expect(dnc.result).toBe("block");
    expect(dnc.reasons).toContain("MERCHANT_DO_NOT_CONTACT");

    const updatedFlags = applyCallDispositionPermissionFlags(
      {},
      "do_not_call",
      NOW
    );
    expect(updatedFlags.doNotCall).toBe(true);
    expect(updatedFlags.optedOutAt).toBe(NOW);

    const callCheck = evaluateSendGate({
      touchId: "t-2",
      channel: "call",
      now: NOW,
      merchant: { id: "m-1" },
      contact: {
        id: "c-1",
        permissions: { ...updatedFlags, euResident: true },
      },
    });
    expect(callCheck.result).toBe("block");
    expect(callCheck.reasons).toEqual(
      expect.arrayContaining([
        "CONTACT_OPTED_OUT",
        "CONTACT_DO_NOT_CALL",
        "EU_RESIDENT_CONSENT_REQUIRED",
      ])
    );
  });

  it("enforces Reacher email verification status and staleness rules (PILE-479)", () => {
    const invalid = evaluateSendGate({
      touchId: "t-inv",
      channel: "email",
      now: NOW,
      merchant: { id: "m-1" },
      contact: { id: "c-1", permissions: { emailStatus: "invalid" } },
    });
    expect(invalid.result).toBe("block");
    expect(invalid.reasons).toEqual(["EMAIL_INVALID"]);

    const catchAllBlocked = evaluateSendGate({
      touchId: "t-ca",
      channel: "email",
      now: NOW,
      merchant: { id: "m-1" },
      contact: {
        id: "c-1",
        permissions: {
          emailStatus: "catch_all",
          emailVerifiedAt: "2026-09-01T00:00:00.000Z",
        },
      },
      cadence: { allowCatchAll: false, verificationMaxAgeDays: 30 },
    });
    expect(catchAllBlocked.result).toBe("block");
    expect(catchAllBlocked.reasons).toEqual([
      "EMAIL_CATCH_ALL_BLOCKED",
      "EMAIL_VERIFICATION_STALE",
    ]);

    const catchAllAllowed = evaluateSendGate({
      touchId: "t-ca-ok",
      channel: "email",
      now: NOW,
      merchant: { id: "m-1" },
      contact: {
        id: "c-1",
        permissions: {
          emailStatus: "catch_all",
          emailVerifiedAt: "2026-10-20T00:00:00.000Z",
        },
      },
      cadence: { allowCatchAll: true, verificationMaxAgeDays: 30 },
    });
    expect(catchAllAllowed.result).toBe("pass");
    expect(catchAllAllowed.reasons).toEqual([]);
  });

  it("evaluates exclusion lists separately for engage vs claim with most-restrictive-wins (PILE-480)", () => {
    const rules = [
      {
        id: "ex-1",
        name: "Open Opportunity",
        behaviorEngage: "warn" as const,
        behaviorClaim: "allow" as const,
        match: { dealStages: ["proposal"] },
      },
      {
        id: "ex-2",
        name: "Competitor Domain",
        behaviorEngage: "block" as const,
        behaviorClaim: "warn" as const,
        match: { domains: ["toasttab.com"] },
      },
    ];
    const merchant = {
      id: "m-comp",
      domain: "ToastTab.com",
      dealStages: ["proposal"],
    };
    expect(evaluateExclusions(rules, merchant, "engage")).toEqual({
      result: "block",
      matchedNames: ["Open Opportunity", "Competitor Domain"],
    });
    expect(evaluateExclusions(rules, merchant, "claim")).toEqual({
      result: "warn",
      matchedNames: ["Open Opportunity", "Competitor Domain"],
    });
  });

  it("enforces single active cadence, re-touch cooldown, and maxActiveContacts cap (PILE-481 / PILE-482)", () => {
    const decision = evaluateSendGate({
      touchId: "t-cad",
      channel: "email",
      now: NOW,
      merchant: {
        id: "m-1",
        permissions: { maxActiveContacts: 1 },
      },
      contact: {
        id: "c-2",
        permissions: { emailStatus: "valid" },
      },
      cadence: {
        concurrency: "not_allowed",
        reenrollWaitDays: 45,
      },
      enrollments: [
        {
          id: "e-active",
          contactId: "c-1",
          status: "active",
          completedSteps: 1,
        },
        {
          id: "e-finished",
          contactId: "c-2",
          status: "finished",
          completedSteps: 2,
          endedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    });
    expect(decision.result).toBe("block");
    expect(decision.reasons).toEqual([
      "ACTIVE_CADENCE_EXISTS",
      "MERCHANT_CONTACT_CAP_REACHED",
      "RETOUCH_COOLDOWN_ACTIVE",
    ]);

    const capAndHours = evaluateSendGate({
      touchId: "t-visit",
      channel: "visit",
      now: "2026-10-24T16:00:00.000Z", // Saturday 12:00 EDT
      merchant: { id: "m-1" },
      contact: { id: "c-1" },
      schedule: {
        timeZone: "America/New_York",
        businessHours: { startHour: 9, endHour: 18 },
        quietWindows: [
          {
            dayOfWeek: 6,
            startHour: 10,
            endHour: 15,
            reason: "Saturday salon rush",
          },
        ],
        minTouchGapHours: 24,
        lastTouchAt: "2026-10-24T10:00:00.000Z",
      },
    });
    expect(capAndHours.result).toBe("block");
    expect(capAndHours.reasons).toEqual(["RECENT_TOUCH", "OUTSIDE_HOURS"]);
  });
});
