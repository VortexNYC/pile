// PILE-495..506 (Unify-parity U-018..U-029) — Template Variables, Send
// Schedules, Daily Rep Touch Queue, Inbound Reply Ingestion, 16-Category Reply
// Classifier, Reply SLA Task Deduplication, OOO Auto-Pause, Opt-Out / Bounce
// Kill-Switch, Call & Walk-In Dispositions, Statement-Received Checklist, and
// Weekly Sales Funnel Metrics.

import type { CadenceEnrollment } from "./cadence-engine.js";
import type { ContactPermissionFlags } from "./send-gate.js";

// ---- U-018 (PILE-495): Template Variables with Fallbacks & MISSING_VARIABLE Gate ----

export function renderTemplateWithVariables(
  template: string,
  variables: Record<string, Record<string, string | number | null | undefined>>
): {
  ok: boolean;
  rendered: string;
  missingVariables: string[];
  blockedReason?: "MISSING_VARIABLE";
} {
  const missingVariables: string[] = [];
  const rendered = template.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)(?:\s*\|\s*"([^"]*)")?\s*\}\}/g,
    (_full, ns: string, key: string, fallback?: string) => {
      const val = variables[ns]?.[key];
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        return String(val);
      }
      if (fallback !== undefined) {
        return fallback;
      }
      missingVariables.push(`${ns}.${key}`);
      return "";
    }
  );
  return {
    ok: missingVariables.length === 0,
    rendered,
    missingVariables,
    ...(missingVariables.length > 0
      ? { blockedReason: "MISSING_VARIABLE" as const }
      : {}),
  };
}

// ---- U-019 (PILE-496): Send Windows, Holidays & Blackout Dates ----

export interface SendWindow {
  daysOfWeek: number[]; // 0=Sun..6=Sat
  startHour: number; // 0..23
  endHour: number; // 1..24
}

export interface SendSchedule {
  timeZone: string;
  windows: SendWindow[];
  skipHolidays?: boolean;
  blackoutDates?: string[]; // YYYY-MM-DD
}

const US_FIXED_HOLIDAYS_MMDD = new Set(["01-01", "07-04", "11-11", "12-25"]);

export function isWithinSendSchedule(
  schedule: SendSchedule,
  nowIso = new Date().toISOString()
): {
  allowed: boolean;
  reason?: "BLACKOUT_DATE" | "HOLIDAY" | "OUTSIDE_WINDOW";
} {
  const d = new Date(Date.parse(nowIso));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timeZone || "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    hour12: false,
    weekday: "short",
  }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")?.value ?? "2026";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  const ymd = `${year}-${month}-${day}`;
  const mmdd = `${month}-${day}`;

  if (schedule.blackoutDates?.includes(ymd)) {
    return { allowed: false, reason: "BLACKOUT_DATE" };
  }
  if (schedule.skipHolidays && US_FIXED_HOLIDAYS_MMDD.has(mmdd)) {
    return { allowed: false, reason: "HOLIDAY" };
  }
  const wkMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const wk =
    wkMap[parts.find((p) => p.type === "weekday")?.value ?? "Mon"] ?? 1;
  const rawHour = Number(parts.find((p) => p.type === "hour")?.value ?? "12");
  const hour = rawHour === 24 ? 0 : rawHour;

  const inWindow = schedule.windows.some(
    (w) => w.daysOfWeek.includes(wk) && hour >= w.startHour && hour < w.endHour
  );
  return inWindow
    ? { allowed: true }
    : { allowed: false, reason: "OUTSIDE_WINDOW" };
}

// ---- U-022 & U-023 (PILE-499 & PILE-500): Reply Ingestion & 16-Category Classifier ----

export const UNIFY_REPLY_CATEGORIES = [
  "positive",
  "willing_to_meet",
  "needs_more_info",
  "bad_timing",
  "has_solution",
  "neutral",
  "negative",
  "referral",
  "updated_contact_info",
  "left_job",
  "opt_out",
  "ooo",
  "automated",
  "soft_bounce",
  "hard_bounce",
  "nsfw",
] as const;

export type UnifyReplyCategory = (typeof UNIFY_REPLY_CATEGORIES)[number];

export type UnifyReplyGroup =
  | "automated"
  | "positive"
  | "objection"
  | "negative"
  | "neutral";

export interface ClassifiedReply {
  category: UnifyReplyCategory;
  group: UnifyReplyGroup;
  confidence: number;
  needsHumanReview: boolean;
  returnDateIso?: string | null;
  alternateContactEmail?: string | null;
}

export function categoryToReplyGroup(cat: UnifyReplyCategory): UnifyReplyGroup {
  if (
    cat === "ooo" ||
    cat === "automated" ||
    cat === "soft_bounce" ||
    cat === "hard_bounce"
  ) {
    return "automated";
  }
  if (cat === "positive" || cat === "willing_to_meet") return "positive";
  if (
    cat === "needs_more_info" ||
    cat === "bad_timing" ||
    cat === "has_solution"
  ) {
    return "objection";
  }
  if (cat === "negative" || cat === "opt_out" || cat === "nsfw") {
    return "negative";
  }
  return "neutral";
}

/** U-023 (PILE-500): classify an inbound email reply into one of the 16 Unify
 *  categories with confidence and OOO return-date / alternate-contact extraction. */
export function classifyInboundReply(
  subject: string,
  body: string
): ClassifiedReply {
  const combined = `${subject}\n${body}`.toLowerCase();
  const emailMatch = body.match(
    /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/
  );
  const isoDateMatch = body.match(/\b(20\d{2}-\d{2}-\d{2})\b/);

  let category: UnifyReplyCategory = "neutral";
  let confidence = 0.65;

  if (
    /550\s+5\.1\.1|user unknown|address not found|does not exist|hard bounce/i.test(
      combined
    )
  ) {
    category = "hard_bounce";
    confidence = 0.98;
  } else if (
    /mailbox full|temporarily deferred|452\s|soft bounce/i.test(combined)
  ) {
    category = "soft_bounce";
    confidence = 0.95;
  } else if (
    /out of office|on vacation|away from my desk|automatic reply|auto-reply/i.test(
      combined
    )
  ) {
    category = "ooo";
    confidence = 0.96;
  } else if (
    /thank you for contacting|received your message|ticket has been created|do not reply to this email|noreply/i.test(
      combined
    )
  ) {
    category = "automated";
    confidence = 0.93;
  } else if (
    /unsubscribe|remove me|stop emailing|take me off|do not contact|opt out/i.test(
      combined
    )
  ) {
    category = "opt_out";
    confidence = 0.97;
  } else if (/\b(?:fuck off|go to hell|spammer scum)\b/i.test(combined)) {
    category = "nsfw";
    confidence = 0.95;
  } else if (
    /not interested|no thanks|pass for now|don't reach out|never interested/i.test(
      combined
    )
  ) {
    category = "negative";
    confidence = 0.91;
  } else if (
    /no longer with|left the company|no longer works here/i.test(combined)
  ) {
    category = "left_job";
    confidence = 0.92;
  } else if (
    /new email is|my new number|updated my email|reach me at my new/i.test(
      combined
    )
  ) {
    category = "updated_contact_info";
    confidence = 0.89;
  } else if (
    /reach out to|talk to my partner|better person to contact|contact .* instead/i.test(
      combined
    )
  ) {
    category = "referral";
    confidence = 0.88;
  } else if (
    /let's meet|book a time|free tomorrow|stop by|come by|tuesday at|thursday at|schedule a call/i.test(
      combined
    )
  ) {
    category = "willing_to_meet";
    confidence = 0.91;
  } else if (
    /what are your rates|how much|send pricing|more info|how does it work/i.test(
      combined
    )
  ) {
    category = "needs_more_info";
    confidence = 0.86;
  } else if (
    /already use|locked into a contract|happy with toast|happy with square/i.test(
      combined
    )
  ) {
    category = "has_solution";
    confidence = 0.85;
  } else if (
    /next quarter|check back in|busy right now|after the holidays/i.test(
      combined
    )
  ) {
    category = "bad_timing";
    confidence = 0.85;
  } else if (
    /\b(?:interested|sounds good|send over|love to chat|yes please)\b/i.test(
      combined
    )
  ) {
    category = "positive";
    confidence = 0.87;
  }

  return {
    category,
    group: categoryToReplyGroup(category),
    confidence,
    needsHumanReview: confidence < 0.75,
    returnDateIso: isoDateMatch ? `${isoDateMatch[1]}T09:00:00.000Z` : null,
    alternateContactEmail: emailMatch ? emailMatch[0].toLowerCase() : null,
  };
}

/** U-022 (PILE-499): match an inbound reply to an enrollment — by inReplyTo
 *  messageId first, then out-of-thread by contactId within 30 days. */
export function matchInboundReplyToEnrollment(
  enrollments: CadenceEnrollment[],
  reply: {
    inReplyToMessageId?: string | null;
    contactId: string;
    receivedAtIso: string;
  }
): CadenceEnrollment | null {
  if (reply.inReplyToMessageId) {
    const byMsg = enrollments.find((e) =>
      e.touches.some((t) => t.messageId === reply.inReplyToMessageId)
    );
    if (byMsg) return byMsg;
  }
  const recvMs = Date.parse(reply.receivedAtIso);
  const thirtyDaysMs = 30 * 86_400_000;
  return (
    enrollments.find((e) => {
      if (e.contactId !== reply.contactId) return false;
      return e.touches.some((t) => {
        if (!t.sentAt) return false;
        const sentMs = Date.parse(t.sentAt);
        return Number.isFinite(sentMs) && recvMs - sentMs <= thirtyDaysMs;
      });
    }) ?? null
  );
}

// ---- U-024, U-025, U-026 (PILE-501..503): Reply SLA Task, OOO Pause & Opt-Out/Bounce Kill-Switch ----

export interface ReplyTask {
  id: string;
  enrollmentId: string;
  merchantId: string;
  contactId: string;
  classification: UnifyReplyCategory;
  priority: "low" | "medium" | "high" | "urgent";
  dueAt: string;
  status: "open" | "completed";
}

export function applyInboundReplyOutcome(input: {
  enrollment: CadenceEnrollment & {
    pausedUntil?: string | null;
    pauseReason?: string | null;
  };
  contactPermissions: ContactPermissionFlags;
  classified: ClassifiedReply;
  existingTasks: ReplyTask[];
  oooBufferDays?: number;
  nowIso?: string;
}): {
  enrollment: CadenceEnrollment & {
    pausedUntil?: string | null;
    pauseReason?: string | null;
  };
  contactPermissions: ContactPermissionFlags;
  tasks: ReplyTask[];
  flaggedAlternateContactEmail?: string | null;
} {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const cat = input.classified.category;

  // U-025 (PILE-502): OOO pauses until returnDate + bufferDays (or +14d default)
  if (cat === "ooo") {
    const bufferDays = input.oooBufferDays ?? 1;
    const baseMs = input.classified.returnDateIso
      ? Date.parse(input.classified.returnDateIso)
      : nowMs + 14 * 86_400_000;
    const resumeAt = new Date(
      baseMs + (input.classified.returnDateIso ? bufferDays * 86_400_000 : 0)
    ).toISOString();
    return {
      enrollment: {
        ...input.enrollment,
        status: "paused",
        pausedUntil: resumeAt,
        pauseReason: "ooo",
      },
      contactPermissions: input.contactPermissions,
      tasks: input.existingTasks,
      flaggedAlternateContactEmail:
        input.classified.alternateContactEmail ?? null,
    };
  }

  // U-026 (PILE-503): Opt-out or hard bounce stops cadence & updates contact permissions
  if (cat === "opt_out") {
    return {
      enrollment: {
        ...input.enrollment,
        status: "ended",
        endReason: "opted_out",
      },
      contactPermissions: {
        ...input.contactPermissions,
        doNotEmail: true,
        optedOutAt: input.contactPermissions.optedOutAt ?? nowIso,
        optOutSource: "reply:opt_out",
      },
      tasks: input.existingTasks,
    };
  }
  if (cat === "hard_bounce") {
    return {
      enrollment: {
        ...input.enrollment,
        status: "ended",
        endReason: "bounced",
      },
      contactPermissions: {
        ...input.contactPermissions,
        emailStatus: "invalid",
        emailVerifiedAt: nowIso,
      },
      tasks: input.existingTasks,
    };
  }

  if (cat === "soft_bounce" || cat === "automated") {
    return {
      enrollment: input.enrollment,
      contactPermissions: input.contactPermissions,
      tasks: input.existingTasks,
    };
  }

  // Actionable human reply ends active sequence as "replied" and ensures at most
  // one open reply task per enrollment (U-024, PILE-501).
  const dueHours =
    cat === "willing_to_meet" || cat === "positive"
      ? 4
      : cat === "needs_more_info"
        ? 8
        : 24;
  const priority: ReplyTask["priority"] =
    cat === "willing_to_meet" || cat === "positive"
      ? "high"
      : cat === "needs_more_info"
        ? "medium"
        : "low";
  const dueAt = new Date(nowMs + dueHours * 3_600_000).toISOString();
  const existingIdx = input.existingTasks.findIndex(
    (t) => t.enrollmentId === input.enrollment.id && t.status === "open"
  );
  const tasks = [...input.existingTasks];
  if (existingIdx >= 0) {
    tasks[existingIdx] = {
      ...tasks[existingIdx]!,
      classification: cat,
      priority,
      dueAt,
    };
  } else {
    tasks.push({
      id: `rtask_${input.enrollment.id}`,
      enrollmentId: input.enrollment.id,
      merchantId: input.enrollment.merchantId,
      contactId: input.enrollment.contactId,
      classification: cat,
      priority,
      dueAt,
      status: "open",
    });
  }

  return {
    enrollment: {
      ...input.enrollment,
      status: "ended",
      endReason: "replied",
    },
    contactPermissions: input.contactPermissions,
    tasks,
  };
}

// ---- U-027, U-028, U-029 (PILE-504..506): Dispositions, Statement Checklist & Weekly Funnel ----

export type FieldVisitDisposition =
  | "owner_present"
  | "owner_absent"
  | "come_back_at"
  | "statement_promised"
  | "statement_received"
  | "not_interested"
  | "do_not_return"
  | "closed_business";

export interface StatementChecklistItem {
  key:
    | "statement_attached"
    | "processor_identified"
    | "volume_and_rate_captured"
    | "savings_analysis_drafted"
    | "human_reviewed_proposal"
    | "followup_visit_scheduled";
  label: string;
  done: boolean;
}

export interface StatementChecklist {
  merchantId: string;
  dealStage: "statement_received";
  statementFileId?: string | null;
  items: StatementChecklistItem[];
  createdAt: string;
  completedAt?: string | null;
}

export function createStatementReceivedChecklist(input: {
  merchantId: string;
  statementFileId?: string | null;
  nowIso?: string;
}): StatementChecklist {
  return {
    merchantId: input.merchantId,
    dealStage: "statement_received",
    statementFileId: input.statementFileId ?? null,
    createdAt: input.nowIso ?? new Date().toISOString(),
    completedAt: null,
    items: [
      {
        key: "statement_attached",
        label: "Processing statement attached",
        done: Boolean(input.statementFileId),
      },
      {
        key: "processor_identified",
        label: "Current processor and POS identified",
        done: false,
      },
      {
        key: "volume_and_rate_captured",
        label: "Monthly card volume and effective rate captured",
        done: false,
      },
      {
        key: "savings_analysis_drafted",
        label: "Savings analysis drafted (no internal margin exposed)",
        done: false,
      },
      {
        key: "human_reviewed_proposal",
        label: "Proposal reviewed and approved by human",
        done: false,
      },
      {
        key: "followup_visit_scheduled",
        label: "Follow-up closing visit scheduled",
        done: false,
      },
    ],
  };
}

export interface WeeklySalesFunnel {
  drafted: number;
  approved: number;
  sent: number;
  replied: number;
  positive: number;
  visitsCompleted: number;
  statementReceived: number;
  boarded: number;
  approvalEditRate: number;
}

export function computeWeeklySalesFunnel(input: {
  enrollments: CadenceEnrollment[];
  replies: ClassifiedReply[];
  visitsCompleted: number;
  statementChecklists: StatementChecklist[];
  boardedMerchantIds: string[];
}): WeeklySalesFunnel {
  const drafted = input.enrollments.length;
  const approvedEnrollments = input.enrollments.filter((e) =>
    Boolean(e.approvedAt)
  );
  const approved = approvedEnrollments.length;
  const allTouches = input.enrollments.flatMap((e) => e.touches);
  const sent = allTouches.filter((t) => t.status === "done").length;
  const editedTouches = allTouches.filter((t) => Boolean(t.editDiff)).length;
  const humanReplies = input.replies.filter((r) => r.group !== "automated");
  const replied = humanReplies.length;
  const positive = humanReplies.filter((r) => r.group === "positive").length;

  return {
    drafted,
    approved,
    sent,
    replied,
    positive,
    visitsCompleted: input.visitsCompleted,
    statementReceived: input.statementChecklists.length,
    boarded: input.boardedMerchantIds.length,
    approvalEditRate:
      allTouches.length > 0
        ? Math.round((editedTouches / allTouches.length) * 100) / 100
        : 0,
  };
}
