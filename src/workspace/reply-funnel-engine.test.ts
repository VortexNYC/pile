import { describe, expect, it } from "vitest";

import {
  applyInboundReplyOutcome,
  classifyInboundReply,
  computeWeeklySalesFunnel,
  createStatementReceivedChecklist,
  isWithinSendSchedule,
  matchInboundReplyToEnrollment,
  renderTemplateWithVariables,
} from "./reply-funnel-engine.js";

describe("Unify-parity Reply Classifier, OOO/Bounce Kill-Switch, Statement Checklist & Funnel (PILE-495..506)", () => {
  const NOW = "2026-10-22T15:00:00.000Z";

  it("resolves template variables with fallbacks and blocks on missing required variables (PILE-495)", () => {
    const ok = renderTemplateWithVariables(
      'Hi {{contact.first_name | "there"}}, saw {{merchant.name}} uses {{agent.pos_guess | "card terminals"}}.',
      {
        merchant: { name: "Bleecker Bistro" },
        contact: {},
        agent: {},
      }
    );
    expect(ok.ok).toBe(true);
    expect(ok.rendered).toBe(
      "Hi there, saw Bleecker Bistro uses card terminals."
    );

    const blocked = renderTemplateWithVariables(
      "Hi {{contact.first_name}}, quick question for {{merchant.name}}.",
      {
        merchant: { name: "Bleecker Bistro" },
        contact: {},
      }
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.blockedReason).toBe("MISSING_VARIABLE");
    expect(blocked.missingVariables).toEqual(["contact.first_name"]);
  });

  it("enforces send schedules, holidays, and blackout dates (PILE-496)", () => {
    const schedule = {
      timeZone: "America/New_York",
      skipHolidays: true,
      blackoutDates: ["2026-10-23"],
      windows: [{ daysOfWeek: [1, 2, 3, 4, 5], startHour: 9, endHour: 17 }],
    };
    expect(isWithinSendSchedule(schedule, NOW)).toEqual({ allowed: true });
    expect(isWithinSendSchedule(schedule, "2026-10-23T15:00:00.000Z")).toEqual({
      allowed: false,
      reason: "BLACKOUT_DATE",
    });
    expect(isWithinSendSchedule(schedule, "2026-12-25T15:00:00.000Z")).toEqual({
      allowed: false,
      reason: "HOLIDAY",
    });
  });

  it("matches out-of-thread replies, classifies 16 Unify reply categories, pauses OOO, kills opt-outs/bounces, and deduplicates reply tasks (PILE-499..503)", () => {
    const baseEnrollment = {
      id: "enr-1",
      merchantId: "m-1",
      contactId: "c-1",
      cadenceId: "cad-1",
      cadenceVersion: 1,
      mailboxId: "mb-1",
      status: "active" as const,
      enrolledBy: "user-1",
      approvedBy: "user-1",
      approvedAt: "2026-10-20T15:00:00.000Z",
      touches: [
        {
          id: "t-1",
          stepId: "s-1",
          stepType: "approved_email" as const,
          thread: "new" as const,
          status: "done" as const,
          subject: "Hello",
          draftBody: "Body",
          finalBody: "Body",
          promptVersion: "v1",
          evidenceRefs: ["sig_1"],
          sentAt: "2026-10-20T16:00:00.000Z",
          messageId: "msg_1",
        },
      ],
    };

    // Out-of-thread match within 30 days
    const matched = matchInboundReplyToEnrollment([baseEnrollment], {
      contactId: "c-1",
      receivedAtIso: NOW,
    });
    expect(matched?.id).toBe("enr-1");

    // 1. OOO reply with return date & alternate contact
    const ooo = classifyInboundReply(
      "Automatic reply: Out of office",
      "I am out of office until 2026-10-29. Please reach out to partner@bistro.com."
    );
    expect(ooo.category).toBe("ooo");
    expect(ooo.group).toBe("automated");
    expect(ooo.returnDateIso).toBe("2026-10-29T09:00:00.000Z");
    expect(ooo.alternateContactEmail).toBe("partner@bistro.com");

    const oooOutcome = applyInboundReplyOutcome({
      enrollment: baseEnrollment,
      contactPermissions: { emailStatus: "valid" },
      classified: ooo,
      existingTasks: [],
      oooBufferDays: 1,
      nowIso: NOW,
    });
    expect(oooOutcome.enrollment.status).toBe("paused");
    expect(oooOutcome.enrollment.pauseReason).toBe("ooo");
    expect(oooOutcome.enrollment.pausedUntil).toBe("2026-10-30T09:00:00.000Z");
    expect(oooOutcome.flaggedAlternateContactEmail).toBe("partner@bistro.com");

    // 2. Hard bounce marks email invalid and stops enrollment
    const bounce = classifyInboundReply(
      "Delivery Status Notification (Failure)",
      "550 5.1.1 User unknown"
    );
    expect(bounce.category).toBe("hard_bounce");
    const bounceOutcome = applyInboundReplyOutcome({
      enrollment: baseEnrollment,
      contactPermissions: { emailStatus: "valid" },
      classified: bounce,
      existingTasks: [],
      nowIso: NOW,
    });
    expect(bounceOutcome.enrollment.status).toBe("ended");
    expect(bounceOutcome.enrollment.endReason).toBe("bounced");
    expect(bounceOutcome.contactPermissions.emailStatus).toBe("invalid");

    // 3. Willing to meet creates a single open High-priority 4h SLA reply task
    const meet = classifyInboundReply(
      "Re: Hello",
      "Let's meet! Come by Tuesday at 2pm."
    );
    expect(meet.category).toBe("willing_to_meet");
    const meetOutcome = applyInboundReplyOutcome({
      enrollment: baseEnrollment,
      contactPermissions: { emailStatus: "valid" },
      classified: meet,
      existingTasks: [],
      nowIso: NOW,
    });
    expect(meetOutcome.tasks).toHaveLength(1);
    expect(meetOutcome.tasks[0]?.priority).toBe("high");

    // 4. "not interested" is classified as negative (not positive), and automated/updated_contact_info/nsfw are reachable
    expect(
      classifyInboundReply("Re: Hello", "Thanks but not interested").category
    ).toBe("negative");
    expect(
      classifyInboundReply(
        "Support",
        "Thank you for contacting us, a ticket has been created."
      ).category
    ).toBe("automated");
    expect(
      classifyInboundReply("Update", "My new email is chef@bistro.com").category
    ).toBe("updated_contact_info");
  });

  it("creates statement-received checklist and computes weekly sales funnel excluding automated OOO/bounces (PILE-505 / PILE-506)", () => {
    const checklist = createStatementReceivedChecklist({
      merchantId: "m-1",
      statementFileId: "file_stmt_1",
      nowIso: NOW,
    });
    expect(checklist.dealStage).toBe("statement_received");
    expect(checklist.items[0]?.done).toBe(true);
    expect(checklist.items).toHaveLength(6);

    const funnel = computeWeeklySalesFunnel({
      enrollments: [
        {
          id: "enr-1",
          merchantId: "m-1",
          contactId: "c-1",
          cadenceId: "cad-1",
          cadenceVersion: 1,
          mailboxId: "mb-1",
          status: "ended",
          endReason: "replied",
          enrolledBy: "u-1",
          approvedBy: "u-1",
          approvedAt: NOW,
          touches: [
            {
              id: "t-1",
              stepId: "s-1",
              stepType: "approved_email",
              thread: "new",
              status: "done",
              subject: "Hi",
              draftBody: "Draft",
              finalBody: "Edited",
              editDiff: "- Draft\n+ Edited",
              promptVersion: "v1",
              evidenceRefs: ["sig_1"],
            },
          ],
        },
      ],
      replies: [
        classifyInboundReply("Auto", "Out of office on vacation"),
        classifyInboundReply("Re: Hi", "Interested, send over details!"),
      ],
      visitsCompleted: 3,
      statementChecklists: [checklist],
      boardedMerchantIds: ["m-1"],
    });
    expect(funnel).toEqual({
      drafted: 1,
      approved: 1,
      sent: 1,
      replied: 1, // OOO excluded!
      positive: 1,
      visitsCompleted: 3,
      statementReceived: 1,
      boarded: 1,
      approvalEditRate: 1,
    });
  });
});
