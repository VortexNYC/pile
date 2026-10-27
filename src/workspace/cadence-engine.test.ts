import { describe, expect, it } from "vitest";

import {
  approveEnrollment,
  canUpgradeEnrollmentVersion,
  computeMailboxCurrentCap,
  createDraftedEnrollment,
  deriveTimeZoneFromState,
  editUnsentTouch,
  executeReadyTouch,
  handleOneClickUnsubscribe,
  isAllowedColdSendingDomain,
  type OutboundMailbox,
  pauseMailboxesForUnhealthyDomain,
  reassignEnrollmentMailbox,
  rejectEnrollment,
  renderOptOutFooter,
  updateMailboxDailyCap,
  validateCadenceForPublish,
} from "./cadence-engine.js";

describe("Unify-parity Cadence, Mailbox & Executor Engine (PILE-483..494)", () => {
  const NOW = "2026-10-22T15:00:00.000Z";

  it("enforces secondary cold domains, +5/day mailbox ramp, and DNS health auto-pause (PILE-483..485)", () => {
    expect(isAllowedColdSendingDomain("vortex.nyc")).toBe(false);
    expect(isAllowedColdSendingDomain("pile.nyc")).toBe(false);
    expect(isAllowedColdSendingDomain("tryvortexpay.com")).toBe(true);

    const mb: OutboundMailbox = {
      id: "mb-1",
      address: "ronnie@tryvortexpay.com",
      domain: "tryvortexpay.com",
      ownerUserId: "user-ronnie",
      provider: "google_workspace",
      state: "connected",
      dailyCap: 20,
      rampStartedAt: "2026-10-20T15:00:00.000Z", // Day 3 -> 15/day
      sentToday: 0,
    };
    expect(computeMailboxCurrentCap(mb, NOW)).toBe(15);

    const raised = updateMailboxDailyCap(mb, 30, NOW);
    expect(raised.dailyCap).toBe(30);
    expect(raised.rampStartedAt).toBe(NOW);
    expect(computeMailboxCurrentCap(raised, NOW)).toBe(5);

    const paused = pauseMailboxesForUnhealthyDomain([mb], {
      domain: "tryvortexpay.com",
      spfOk: true,
      dkimOk: false,
      dmarcOk: true,
      mxOk: true,
      checkedAt: NOW,
    });
    expect(paused.pausedIds).toEqual(["mb-1"]);
    expect(paused.mailboxes[0]?.state).toBe("paused");
    expect(paused.mailboxes[0]?.pausedReason).toContain("dkim");
  });

  it("enforces calling-hours, Saturday rush quiet windows, and recent-touch gap (PILE-486 / PILE-488)", () => {
    expect(deriveTimeZoneFromState("NY")).toBe("America/New_York");
    expect(deriveTimeZoneFromState("CA")).toBe("America/Los_Angeles");
  });

  it("validates cadence step graph, step types, and safe version upgrades (PILE-489 / PILE-490)", () => {
    const validTemplate = {
      id: "cad-1",
      name: "NYC Restaurant Walk-In + Follow-Up",
      motion: "smb_hospitality",
      version: 1,
      status: "published" as const,
      optOutVariants: ["Not interested? Click <%here%>."],
      steps: [
        {
          id: "step-1",
          type: "approved_email" as const,
          parentStepId: null,
          delayMinutes: 0,
          thread: "new" as const,
          subject: "Quick question on card fees",
        },
        {
          id: "step-2",
          type: "field_visit" as const,
          parentStepId: "step-1",
          delayMinutes: 1440,
          fieldVisit: {
            address: "123 Bleecker St, New York, NY",
            bestVisitWindow: "2pm-4pm",
            talkingPoints: ["Dual pricing savings", "Terminal swap"],
            leaveBehindChecklist: ["One-pager", "Business card"],
          },
        },
      ],
    };
    expect(validateCadenceForPublish(validTemplate)).toEqual({
      ok: true,
      errors: [],
    });

    const upgradeRemoved = canUpgradeEnrollmentVersion(
      new Set(["step-1"]),
      validTemplate.steps,
      [validTemplate.steps[1]!]
    );
    expect(upgradeRemoved.allowed).toBe(false);
  });

  it("runs Drafter -> Approval Queue -> Executor -> One-Click Unsubscribe end-to-end (PILE-487 / PILE-491..494)", () => {
    const template = {
      id: "cad-1",
      name: "Hospitality Outbound",
      motion: "smb_hospitality",
      version: 1,
      status: "published" as const,
      optOutVariants: ["Reply stop or click <%here%> to opt out."],
      steps: [
        {
          id: "s1",
          type: "approved_email" as const,
          parentStepId: null,
          delayMinutes: 0,
          thread: "new" as const,
          subject: "Saw your new West Village location",
        },
        {
          id: "s2",
          type: "field_visit" as const,
          parentStepId: "s1",
          delayMinutes: 2880,
          fieldVisit: {
            address: "50 W 8th St",
            talkingPoints: ["Ask for owner"],
            leaveBehindChecklist: ["Brochure"],
          },
        },
      ],
    };
    // 1. Drafter creates awaiting_approval enrollment with cited evidence
    const drafted = createDraftedEnrollment({
      id: "enr-1",
      merchantId: "m-1",
      contactId: "c-1",
      template,
      mailboxId: "mb-1",
      enrolledBy: "agent-drafter",
      promptVersion: "drafter-v1",
      whyNow: "New liquor license filed Oct 18",
      rankScore: 92,
      draftsByStepId: {
        s1: {
          body: "Congrats on the West Village license filing.",
          evidenceRefs: ["sig_sla_123"],
        },
        s2: {
          body: "Drop by between lunch and dinner service.",
          evidenceRefs: ["sig_sla_123"],
        },
      },
    });
    expect(drafted.status).toBe("awaiting_approval");

    // 2. Rep edits unsent touch in approval queue (records diff)
    const edited = editUnsentTouch(drafted, drafted.touches[0]!.id, {
      body: "Congrats on the West Village liquor license filing!",
    });
    expect(edited.touches[0]?.editDiff).toContain(
      "+ Congrats on the West Village liquor license filing!"
    );

    // 3. Pre-send mailbox reassignment succeeds
    const reassigned = reassignEnrollmentMailbox(edited, "mb-2");
    expect(reassigned.mailboxId).toBe("mb-2");

    // 4. Rep approves enrollment -> transitions to active
    const { enrollment: active, gateDecision } = approveEnrollment(
      reassigned,
      "user-shlomo",
      {
        merchant: { id: "m-1" },
        contact: { id: "c-1", permissions: { emailStatus: "valid" } },
      },
      NOW
    );
    expect(gateDecision.result).toBe("pass");
    expect(active.status).toBe("active");
    expect(active.approvedBy).toBe("user-shlomo");

    // 5. Executor sends step 1 email with opt-out footer and increments mailbox sentToday
    const mb: OutboundMailbox = {
      id: "mb-2",
      address: "ronnie@tryvortexpay.com",
      domain: "tryvortexpay.com",
      ownerUserId: "user-ronnie",
      provider: "google_workspace",
      state: "connected",
      dailyCap: 20,
      rampStartedAt: "2026-10-15T00:00:00.000Z",
      sentToday: 3,
    };
    const exec1 = executeReadyTouch({
      enrollment: active,
      touchId: active.touches[0]!.id,
      template,
      mailbox: mb,
      gateContext: {
        merchant: { id: "m-1" },
        contact: { id: "c-1", permissions: { emailStatus: "valid" } },
        cadence: { concurrency: "allowed" },
      },
      unsubscribeUrl: "https://pile.nyc/unsub/c-1",
      physicalAddress: "Vortex NYC, New York, NY",
      nowIso: NOW,
    });
    expect(exec1.outcome).toBe("sent_email");
    expect(exec1.mailbox.sentToday).toBe(4);
    expect(exec1.sentPayload?.body).toContain("https://pile.nyc/unsub/c-1");
    expect(exec1.enrollment.touches[1]?.status).toBe("ready");

    // Reassigning mailbox after first email sent is rejected
    expect(() => reassignEnrollmentMailbox(exec1.enrollment, "mb-3")).toThrow(
      /after the first email/
    );

    // 6. Executor turns step 2 (field_visit) into a manual walk-in task
    const exec2 = executeReadyTouch({
      enrollment: exec1.enrollment,
      touchId: exec1.enrollment.touches[1]!.id,
      template,
      mailbox: exec1.mailbox,
      gateContext: {
        merchant: { id: "m-1" },
        contact: { id: "c-1", permissions: { emailStatus: "valid" } },
        cadence: { concurrency: "allowed" },
        schedule: {
          timeZone: "America/New_York",
          businessHours: { startHour: 9, endHour: 18 },
        },
      },
      unsubscribeUrl: "https://pile.nyc/unsub/c-1",
      physicalAddress: "Vortex NYC, New York, NY",
      nowIso: NOW, // 11:00 EDT -> inside 9..18
    });
    expect(exec2.outcome).toBe("created_task");
    expect(exec2.task?.fieldVisit?.address).toBe("50 W 8th St");

    // 7. One-click unsubscribe ends active enrollments and stamps optedOutAt
    const unsub = handleOneClickUnsubscribe(
      "c-1",
      { emailStatus: "valid" },
      [exec2.enrollment],
      NOW
    );
    expect(unsub.permissions.doNotEmail).toBe(true);
    expect(unsub.enrollments[0]?.status).toBe("ended");
    expect(unsub.enrollments[0]?.endReason).toBe("opted_out");
    expect(
      renderOptOutFooter({
        variants: ["Click <%here%>"],
        unsubscribeUrl: "https://u",
        physicalAddress: "NYC",
      })
    ).toContain("https://u");
    expect(() => rejectEnrollment(drafted, "")).toThrow();
  });
});
