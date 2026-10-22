// PILE-483..494 (Unify-parity U-006..U-017) — Outbound Mailboxes, Domain
// Health, Opt-Out Footer Rotation, Core Sales Fields, Cadence Step Graph,
// Enrollment/Touch State Machine, Drafter, Approval Queue, and Executor.

import {
  computeMailboxCurrentCap,
  type ContactPermissionFlags,
  evaluateSendGate,
  type GateDecision,
  type SendGateInput,
  type TouchChannel,
} from "./send-gate.js";

// ---- U-006 / U-007 (PILE-483 / PILE-484): Outbound Mailboxes & Ramp ----

export type MailboxProvider = "google_workspace" | "smtp";
export type MailboxState = "connected" | "unauthorized" | "paused";

export interface OutboundMailbox {
  id: string;
  address: string;
  domain: string;
  ownerUserId: string;
  provider: MailboxProvider;
  state: MailboxState;
  pausedReason?: string | null;
  dailyCap: number;
  rampStartedAt: string;
  sentToday: number;
}

const PRIMARY_CORPORATE_DOMAINS = new Set([
  "vortex.nyc",
  "pile.nyc",
  "plasmapos.com",
  "veil.nyc",
]);

export const DEFAULT_COLD_MAILBOX_DAILY_CAP = 20;

/** U-006 (PILE-483): cold outbound mail must come from secondary domains,
 *  never a primary corporate domain. */
export function isAllowedColdSendingDomain(domain: string): boolean {
  const clean = domain.trim().toLowerCase();
  if (!clean || !clean.includes(".")) return false;
  return !PRIMARY_CORPORATE_DOMAINS.has(clean);
}

/** U-007 (PILE-484): raising a mailbox's dailyCap restarts its +5/day ramp. */
export function updateMailboxDailyCap(
  mailbox: OutboundMailbox,
  newDailyCap: number,
  nowIso = new Date().toISOString()
): OutboundMailbox {
  const clamped = Math.max(1, Math.floor(newDailyCap));
  const restartRamp = clamped > mailbox.dailyCap;
  return {
    ...mailbox,
    dailyCap: clamped,
    rampStartedAt: restartRamp ? nowIso : mailbox.rampStartedAt,
  };
}

// ---- U-008 (PILE-485): Sending Domain DNS Health Check ----

export interface SendingDomainHealth {
  domain: string;
  spfOk: boolean;
  dkimOk: boolean;
  dmarcOk: boolean;
  mxOk: boolean;
  checkedAt: string;
}

export function evaluateSendingDomainHealth(health: SendingDomainHealth): {
  healthy: boolean;
  missingRecords: Array<"spf" | "dkim" | "dmarc" | "mx">;
} {
  const missingRecords: Array<"spf" | "dkim" | "dmarc" | "mx"> = [];
  if (!health.spfOk) missingRecords.push("spf");
  if (!health.dkimOk) missingRecords.push("dkim");
  if (!health.dmarcOk) missingRecords.push("dmarc");
  if (!health.mxOk) missingRecords.push("mx");
  return {
    healthy: missingRecords.length === 0,
    missingRecords,
  };
}

export function pauseMailboxesForUnhealthyDomain(
  mailboxes: OutboundMailbox[],
  health: SendingDomainHealth
): { mailboxes: OutboundMailbox[]; pausedIds: string[] } {
  const evalRes = evaluateSendingDomainHealth(health);
  if (evalRes.healthy) return { mailboxes, pausedIds: [] };
  const targetDomain = health.domain.trim().toLowerCase();
  const reason = `DNS health check failed (${evalRes.missingRecords.join(", ")})`;
  const pausedIds: string[] = [];
  const next = mailboxes.map((mb) => {
    if (mb.domain.trim().toLowerCase() !== targetDomain) return mb;
    pausedIds.push(mb.id);
    return {
      ...mb,
      state: "paused" as const,
      pausedReason: reason,
    };
  });
  return { mailboxes: next, pausedIds };
}

// ---- U-010 (PILE-487): Opt-Out Footer Variants & One-Click Unsubscribe ----

export const MAX_OPT_OUT_VARIANTS = 8;

export function renderOptOutFooter(input: {
  variants: string[];
  unsubscribeUrl: string;
  physicalAddress: string;
  variantIndex?: number;
}): string {
  const pool =
    input.variants.length > 0
      ? input.variants.slice(0, MAX_OPT_OUT_VARIANTS)
      : ["If you'd prefer not to hear from me, click <%here%> to opt out."];
  const idx =
    input.variantIndex != null ? Math.abs(input.variantIndex) % pool.length : 0;
  const template = pool[idx]!;
  const withLink = template.includes("<%here%>")
    ? template.replaceAll("<%here%>", input.unsubscribeUrl)
    : `${template} (${input.unsubscribeUrl})`;
  return `${withLink}\n${input.physicalAddress.trim()}`;
}

// ---- U-011 (PILE-488): Merchant & Contact Core Sales Fields ----

export type MerchantSalesStatus =
  | "new"
  | "researching"
  | "contacted"
  | "engaged"
  | "qualified"
  | "disqualified"
  | "boarded";

export interface MerchantSalesFields {
  ownerUserId: string | null;
  leadSource: string | null;
  salesStatus: MerchantSalesStatus;
  lastTouchAt: string | null;
  timeZone: string | null;
}

const US_STATE_TIMEZONES: Record<string, string> = {
  NY: "America/New_York",
  NJ: "America/New_York",
  CT: "America/New_York",
  PA: "America/New_York",
  MA: "America/New_York",
  FL: "America/New_York",
  GA: "America/New_York",
  IL: "America/Chicago",
  TX: "America/Chicago",
  CO: "America/Denver",
  AZ: "America/Phoenix",
  CA: "America/Los_Angeles",
  WA: "America/Los_Angeles",
  NV: "America/Los_Angeles",
};

export function deriveTimeZoneFromState(
  stateCode: string | null | undefined
): string {
  const code = (stateCode ?? "").trim().toUpperCase();
  return US_STATE_TIMEZONES[code] ?? "America/New_York";
}

// ---- U-012 / U-013 (PILE-489 / PILE-490): Cadence Step Graph & Step Types ----

export type CadenceStepType =
  | "approved_email"
  | "manual_email"
  | "call"
  | "field_visit"
  | "linkedin_manual"
  | "action_item";

export type StepPriority = "low" | "medium" | "high" | "urgent";

export interface FieldVisitMeta {
  address: string;
  bestVisitWindow?: string;
  talkingPoints: string[];
  leaveBehindChecklist: string[];
}

export interface StepConditionGroup {
  op: "and" | "or";
  predicates: Array<{
    field: string;
    equals: string | boolean | number;
  }>;
}

export interface CadenceStep {
  id: string;
  type: CadenceStepType;
  parentStepId: string | null;
  delayMinutes: number;
  condition?: StepConditionGroup;
  priority?: StepPriority;
  dueInMinutes?: number;
  autoSkipOnDue?: boolean;
  thread?: "reply" | "new";
  subject?: string;
  fallbackSubject?: string;
  bodyTemplate?: string;
  fieldVisit?: FieldVisitMeta;
}

export interface CadenceTemplate {
  id: string;
  name: string;
  motion: string;
  version: number;
  status: "draft" | "published";
  paused?: boolean;
  optOutVariants?: string[];
  steps: CadenceStep[];
}

export function stepChannel(type: CadenceStepType): TouchChannel {
  if (type === "approved_email" || type === "manual_email") return "email";
  if (type === "call") return "call";
  if (type === "field_visit") return "visit";
  return "linkedin";
}

/** U-012 (PILE-489): validate a draft CadenceTemplate before publishing. */
export function validateCadenceForPublish(template: CadenceTemplate): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (template.steps.length === 0) {
    errors.push("Cadence must contain at least one step.");
  }
  if (
    template.optOutVariants &&
    template.optOutVariants.length > MAX_OPT_OUT_VARIANTS
  ) {
    errors.push(
      `At most ${MAX_OPT_OUT_VARIANTS} opt-out variants are allowed.`
    );
  }
  const byId = new Map<string, CadenceStep>();
  for (const step of template.steps) {
    if (byId.has(step.id)) {
      errors.push(`Duplicate step id: ${step.id}`);
    }
    byId.set(step.id, step);
    if (step.delayMinutes < 0) {
      errors.push(`Step ${step.id} has negative delayMinutes.`);
    }
    if (
      step.type === "field_visit" &&
      (!step.fieldVisit?.address || step.fieldVisit.talkingPoints.length === 0)
    ) {
      errors.push(
        `field_visit step ${step.id} requires address and talkingPoints.`
      );
    }
    if (
      (step.type === "approved_email" || step.type === "manual_email") &&
      step.thread === "reply" &&
      !step.fallbackSubject
    ) {
      errors.push(`Reply email step ${step.id} requires a fallbackSubject.`);
    }
  }
  for (const step of template.steps) {
    if (step.parentStepId && !byId.has(step.parentStepId)) {
      errors.push(
        `Step ${step.id} references unknown parentStepId ${step.parentStepId}.`
      );
    }
    // Cycle detection
    const seen = new Set<string>([step.id]);
    let cur = step.parentStepId;
    while (cur) {
      if (seen.has(cur)) {
        errors.push(`Cycle detected in step graph involving ${step.id}.`);
        break;
      }
      seen.add(cur);
      cur = byId.get(cur)?.parentStepId ?? null;
    }
  }
  return { ok: errors.length === 0, errors };
}

/** U-012 (PILE-489): upgrades are refused if they remove a completed step or
 *  insert a new ancestor before a completed step. */
export function canUpgradeEnrollmentVersion(
  completedStepIds: ReadonlySet<string>,
  oldSteps: CadenceStep[],
  newSteps: CadenceStep[]
): { allowed: boolean; reason?: string } {
  const oldById = new Map(oldSteps.map((s) => [s.id, s]));
  const newById = new Map(newSteps.map((s) => [s.id, s]));
  for (const doneId of completedStepIds) {
    const newStep = newById.get(doneId);
    if (!newStep) {
      return {
        allowed: false,
        reason: `Completed step ${doneId} was removed in the new version.`,
      };
    }
    const oldStep = oldById.get(doneId);
    if (oldStep && oldStep.parentStepId !== newStep.parentStepId) {
      return {
        allowed: false,
        reason: `Parent chain before completed step ${doneId} changed.`,
      };
    }
  }
  return { allowed: true };
}

// ---- U-014 / U-015 / U-016 / U-017 (PILE-491..494): Enrollment, Touch, Drafter, Approval Queue & Executor ----

export type EnrollmentStatus =
  | "draft"
  | "awaiting_approval"
  | "active"
  | "paused"
  | "blocked"
  | "ended";

export type EnrollmentEndReason =
  | "completed"
  | "replied"
  | "opted_out"
  | "bounced"
  | "bounce_stopped"
  | "excluded"
  | "canceled"
  | "rejected"
  | "manual";

export type TouchStatus =
  | "not_started"
  | "scheduled"
  | "ready"
  | "done"
  | "skipped"
  | "canceled"
  | "errored";

export interface EnrollmentTouch {
  id: string;
  stepId: string;
  stepType: CadenceStepType;
  thread: "reply" | "new";
  status: TouchStatus;
  subject: string;
  draftBody: string;
  finalBody: string;
  editDiff?: string | null;
  promptVersion: string;
  evidenceRefs: string[];
  dueAt?: string | null;
  assigneeUserId?: string | null;
  sentAt?: string | null;
  messageId?: string | null;
}

export interface CadenceEnrollment {
  id: string;
  merchantId: string;
  contactId: string;
  cadenceId: string;
  cadenceVersion: number;
  mailboxId: string;
  status: EnrollmentStatus;
  endReason?: EnrollmentEndReason | null;
  enrolledBy: string;
  approvedBy?: string | null;
  approvedAt?: string | null;
  rejectedReason?: string | null;
  whyNow?: string | null;
  rankScore?: number;
  touches: EnrollmentTouch[];
}

/** U-015 (PILE-492): Drafter creates an Enrollment in `awaiting_approval`
 *  with every touch drafted and backed by evidence; never activates directly. */
export function createDraftedEnrollment(input: {
  id: string;
  merchantId: string;
  contactId: string;
  template: CadenceTemplate;
  mailboxId: string;
  enrolledBy: string;
  promptVersion: string;
  whyNow: string;
  rankScore?: number;
  draftsByStepId: Record<
    string,
    { subject?: string; body: string; evidenceRefs: string[] }
  >;
}): CadenceEnrollment {
  if (input.template.status !== "published") {
    throw new Error("Cannot enroll into an unpublished cadence template.");
  }
  const touches: EnrollmentTouch[] = input.template.steps.map((step, idx) => {
    const draft = input.draftsByStepId[step.id];
    if (!draft || draft.evidenceRefs.length === 0) {
      throw new Error(
        `Drafter requires draft body and cited evidenceRefs for step ${step.id}.`
      );
    }
    return {
      id: `${input.id}-touch-${idx + 1}`,
      stepId: step.id,
      stepType: step.type,
      thread: step.thread ?? "new",
      status: idx === 0 ? "ready" : "not_started",
      subject:
        draft.subject ?? step.subject ?? step.fallbackSubject ?? "Follow-up",
      draftBody: draft.body,
      finalBody: draft.body,
      promptVersion: input.promptVersion,
      evidenceRefs: [...draft.evidenceRefs],
      assigneeUserId: null,
    };
  });
  return {
    id: input.id,
    merchantId: input.merchantId,
    contactId: input.contactId,
    cadenceId: input.template.id,
    cadenceVersion: input.template.version,
    mailboxId: input.mailboxId,
    status: "awaiting_approval",
    enrolledBy: input.enrolledBy,
    whyNow: input.whyNow,
    rankScore: input.rankScore ?? 0,
    touches,
  };
}

/** U-016 (PILE-493): edit an unsent touch in the approval queue; reply steps
 *  forbid subject edits; records editDiff. */
export function editUnsentTouch(
  enrollment: CadenceEnrollment,
  touchId: string,
  patch: { subject?: string; body?: string }
): CadenceEnrollment {
  const idx = enrollment.touches.findIndex((t) => t.id === touchId);
  if (idx === -1) throw new Error(`Touch ${touchId} not found.`);
  const touch = enrollment.touches[idx]!;
  if (touch.status === "done") {
    throw new Error("Cannot edit a touch that has already been sent.");
  }
  if (
    patch.subject !== undefined &&
    patch.subject !== touch.subject &&
    touch.thread === "reply"
  ) {
    throw new Error("Cannot change subject on a reply-threaded touch.");
  }
  const nextBody = patch.body ?? touch.finalBody;
  const editDiff =
    nextBody !== touch.draftBody
      ? `- ${touch.draftBody}\n+ ${nextBody}`
      : (touch.editDiff ?? null);
  const updated: EnrollmentTouch = {
    ...touch,
    subject: patch.subject ?? touch.subject,
    finalBody: nextBody,
    editDiff,
  };
  const touches = [...enrollment.touches];
  touches[idx] = updated;
  return { ...enrollment, touches };
}

/** U-014 & U-016 (PILE-491 / PILE-493): approve an `awaiting_approval`
 *  enrollment after running the deterministic send gate. */
export function approveEnrollment(
  enrollment: CadenceEnrollment,
  approverUserId: string,
  gateInput: Omit<SendGateInput, "touchId" | "channel">,
  nowIso = new Date().toISOString()
): { enrollment: CadenceEnrollment; gateDecision: GateDecision } {
  if (enrollment.status !== "awaiting_approval") {
    throw new Error(
      `Only awaiting_approval enrollments can be approved (got ${enrollment.status}).`
    );
  }
  if (!approverUserId.trim()) {
    throw new Error("approverUserId is required to activate an enrollment.");
  }
  const firstTouch = enrollment.touches[0];
  const channel: TouchChannel = firstTouch
    ? stepChannel(firstTouch.stepType)
    : "email";
  const decision = evaluateSendGate({
    ...gateInput,
    touchId: firstTouch?.id ?? enrollment.id,
    channel,
    now: nowIso,
  });
  if (decision.result === "block") {
    return {
      enrollment: {
        ...enrollment,
        status: "blocked",
      },
      gateDecision: decision,
    };
  }
  return {
    enrollment: {
      ...enrollment,
      status: "active",
      approvedBy: approverUserId,
      approvedAt: nowIso,
    },
    gateDecision: decision,
  };
}

export function rejectEnrollment(
  enrollment: CadenceEnrollment,
  reason: string
): CadenceEnrollment {
  if (enrollment.status !== "awaiting_approval") {
    throw new Error("Only awaiting_approval enrollments can be rejected.");
  }
  if (!reason.trim()) {
    throw new Error("Rejection reason is required.");
  }
  return {
    ...enrollment,
    status: "ended",
    endReason: "rejected",
    rejectedReason: reason.trim(),
  };
}

/** U-010 (PILE-487): one-click unsubscribe stamps Contact.optedOutAt and stops
 *  every active enrollment for that contact. */
export function handleOneClickUnsubscribe(
  contactId: string,
  permissions: ContactPermissionFlags,
  enrollments: CadenceEnrollment[],
  nowIso = new Date().toISOString()
): {
  permissions: ContactPermissionFlags;
  enrollments: CadenceEnrollment[];
} {
  const nextPerms: ContactPermissionFlags = {
    ...permissions,
    doNotEmail: true,
    optedOutAt: permissions.optedOutAt ?? nowIso,
    optOutSource: "one_click_unsubscribe",
  };
  const nextEnrollments = enrollments.map((e) => {
    if (e.contactId !== contactId || e.status === "ended") return e;
    return {
      ...e,
      status: "ended" as const,
      endReason: "opted_out" as const,
    };
  });
  return { permissions: nextPerms, enrollments: nextEnrollments };
}

/** U-017 (PILE-494): reassigning an enrollment's mailbox is only permitted
 *  before the first email touch has been sent. */
export function reassignEnrollmentMailbox(
  enrollment: CadenceEnrollment,
  newMailboxId: string
): CadenceEnrollment {
  const anyEmailSent = enrollment.touches.some(
    (t) =>
      (t.stepType === "approved_email" || t.stepType === "manual_email") &&
      t.status === "done"
  );
  if (anyEmailSent) {
    throw new Error(
      "Cannot reassign mailbox after the first email in the enrollment has been sent."
    );
  }
  return { ...enrollment, mailboxId: newMailboxId };
}

export interface ManualStepTask {
  touchId: string;
  enrollmentId: string;
  merchantId: string;
  contactId: string;
  stepType: Exclude<CadenceStepType, "approved_email">;
  title: string;
  fieldVisit?: FieldVisitMeta;
}

/** U-017 (PILE-494): execute a ready touch on an active enrollment — re-runs
 *  the send gate, enforces sequence/enrollment pause, sends approved_email
 *  via the assigned mailbox (with opt-out footer + cap increment), or creates
 *  a rep task for manual steps. */
export function executeReadyTouch(input: {
  enrollment: CadenceEnrollment;
  touchId: string;
  template: CadenceTemplate;
  mailbox: OutboundMailbox;
  domainHealthy?: boolean;
  gateContext: Omit<SendGateInput, "touchId" | "channel" | "mailbox">;
  unsubscribeUrl: string;
  physicalAddress: string;
  nowIso?: string;
}): {
  outcome: "sent_email" | "created_task" | "paused" | "blocked";
  enrollment: CadenceEnrollment;
  mailbox: OutboundMailbox;
  gateDecision?: GateDecision;
  sentPayload?: {
    toMailboxId: string;
    subject: string;
    body: string;
    messageId: string;
  };
  task?: ManualStepTask;
} {
  const nowIso = input.nowIso ?? new Date().toISOString();
  if (input.template.paused || input.enrollment.status === "paused") {
    return {
      outcome: "paused",
      enrollment: input.enrollment,
      mailbox: input.mailbox,
    };
  }
  if (
    input.enrollment.status !== "active" ||
    !input.enrollment.approvedBy ||
    !input.enrollment.approvedAt
  ) {
    throw new Error(
      "Cannot execute a touch on an enrollment that is not active and human-approved."
    );
  }
  const idx = input.enrollment.touches.findIndex((t) => t.id === input.touchId);
  if (idx === -1) throw new Error(`Touch ${input.touchId} not found.`);
  const touch = input.enrollment.touches[idx]!;
  const step = input.template.steps.find((s) => s.id === touch.stepId);
  const channel = stepChannel(touch.stepType);

  const decision = evaluateSendGate({
    ...input.gateContext,
    touchId: touch.id,
    channel,
    now: nowIso,
    mailbox: {
      state: input.mailbox.state,
      dailyCap: input.mailbox.dailyCap,
      rampStartedAt: input.mailbox.rampStartedAt,
      sentToday: input.mailbox.sentToday,
      domainHealthy: input.domainHealthy ?? true,
    },
  });
  if (decision.result === "block") {
    const endReason: EnrollmentEndReason | undefined =
      decision.reasons.includes("EMAIL_INVALID")
        ? "bounce_stopped"
        : decision.reasons.includes("EXCLUDED_BY_POLICY")
          ? "excluded"
          : decision.reasons.includes("CONTACT_OPTED_OUT")
            ? "opted_out"
            : undefined;
    return {
      outcome: "blocked",
      enrollment: {
        ...input.enrollment,
        status: endReason ? "ended" : "blocked",
        ...(endReason ? { endReason } : {}),
      },
      mailbox: input.mailbox,
      gateDecision: decision,
    };
  }

  if (touch.stepType === "approved_email") {
    const footer = renderOptOutFooter({
      variants: input.template.optOutVariants ?? [],
      unsubscribeUrl: input.unsubscribeUrl,
      physicalAddress: input.physicalAddress,
      variantIndex: idx,
    });
    const fullBody = `${touch.finalBody.trim()}\n\n--\n${footer}`;
    const messageId = `msg_${touch.id}_${Date.parse(nowIso)}`;
    const updatedTouch: EnrollmentTouch = {
      ...touch,
      status: "done",
      sentAt: nowIso,
      messageId,
    };
    const touches = [...input.enrollment.touches];
    touches[idx] = updatedTouch;
    if (
      idx + 1 < touches.length &&
      touches[idx + 1]!.status === "not_started"
    ) {
      touches[idx + 1] = { ...touches[idx + 1]!, status: "ready" };
    }
    const allDone = touches.every(
      (t) => t.status === "done" || t.status === "skipped"
    );
    return {
      outcome: "sent_email",
      enrollment: {
        ...input.enrollment,
        status: allDone ? "ended" : input.enrollment.status,
        ...(allDone ? { endReason: "completed" } : {}),
        touches,
      },
      mailbox: {
        ...input.mailbox,
        sentToday: input.mailbox.sentToday + 1,
      },
      gateDecision: decision,
      sentPayload: {
        toMailboxId: input.mailbox.id,
        subject: touch.subject,
        body: fullBody,
        messageId,
      },
    };
  }

  return {
    outcome: "created_task",
    enrollment: input.enrollment,
    mailbox: input.mailbox,
    gateDecision: decision,
    task: {
      touchId: touch.id,
      enrollmentId: input.enrollment.id,
      merchantId: input.enrollment.merchantId,
      contactId: input.enrollment.contactId,
      stepType: touch.stepType,
      title: touch.subject,
      ...(step?.fieldVisit ? { fieldVisit: step.fieldVisit } : {}),
    },
  };
}

export { computeMailboxCurrentCap };
