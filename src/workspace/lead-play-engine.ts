// PILE-514..527, PILE-531..537, PILE-549..563 — Dynamic Saved Audiences,
// Event-Triggered Lead Play Engine, Vendor Budget Hard-Stop, Book of Business
// Ownership Guard, 90-Day Pipeline Attribution, and Rep Morning Brief.

import { evaluateSendGate, type GateDecision } from "./send-gate.js";
import {
  DEFAULT_ICP_RULES,
  DEFAULT_SIGNAL_RULES,
  detectPosTechnographics,
  type MerchantRankBreakdown,
  type MerchantSignal,
  planDetectiveWaterfall,
  rankMerchantSignals,
} from "./signals-engine.js";

// ---- U-037..U-040 (PILE-514..517): Dynamic Saved Audiences & AND/OR Filter Builder ----

export type AudienceFilterOp =
  | "eq"
  | "neq"
  | "in"
  | "gte"
  | "lte"
  | "contains"
  | "has_signal";

export interface AudiencePredicate {
  field: string;
  op: AudienceFilterOp;
  value: string | number | boolean | Array<string | number>;
}

export interface AudienceFilterGroup {
  logic: "and" | "or";
  predicates: AudiencePredicate[];
  groups?: AudienceFilterGroup[];
}

export interface AudienceCandidateMerchant {
  id: string;
  name: string;
  domain?: string | null;
  vertical?: string | null;
  neighborhood?: string | null;
  address?: string | null;
  phone?: string | null;
  processor?: string | null;
  ownerId?: string | null;
  priorityScore?: number | null;
  fitScore?: number | null;
  fitStatus?: string | null;
  suppressed?: boolean;
  signalTypes?: string[];
  whyNow?: string | null;
}

export function evaluateAudiencePredicate(
  merchant: AudienceCandidateMerchant,
  pred: AudiencePredicate
): boolean {
  if (pred.op === "has_signal") {
    const types = merchant.signalTypes ?? [];
    if (Array.isArray(pred.value)) {
      return pred.value.some((v) => types.includes(String(v)));
    }
    return types.includes(String(pred.value));
  }
  const record: Record<string, unknown> = {
    id: merchant.id,
    name: merchant.name,
    domain: merchant.domain ?? "",
    vertical: (merchant.vertical ?? "").toLowerCase(),
    neighborhood: (merchant.neighborhood ?? "").toLowerCase(),
    address: merchant.address ?? "",
    phone: merchant.phone ?? "",
    processor: (merchant.processor ?? "").toLowerCase(),
    ownerId: merchant.ownerId ?? "",
    priorityScore: merchant.priorityScore ?? 0,
    fitScore: merchant.fitScore ?? 0,
    fitStatus: (merchant.fitStatus ?? "").toLowerCase(),
    hasAddress: Boolean(merchant.address),
    hasPhone: Boolean(merchant.phone),
    hasDomain: Boolean(merchant.domain),
  };
  const actual = record[pred.field];
  switch (pred.op) {
    case "eq":
      return typeof actual === "string" && typeof pred.value === "string"
        ? actual.toLowerCase() === pred.value.toLowerCase()
        : actual === pred.value;
    case "neq":
      return typeof actual === "string" && typeof pred.value === "string"
        ? actual.toLowerCase() !== pred.value.toLowerCase()
        : actual !== pred.value;
    case "in":
      return (
        Array.isArray(pred.value) &&
        pred.value.some((v) =>
          typeof actual === "string"
            ? actual.toLowerCase() === String(v).toLowerCase()
            : actual === v
        )
      );
    case "gte":
      return (
        typeof actual === "number" &&
        typeof pred.value === "number" &&
        actual >= pred.value
      );
    case "lte":
      return (
        typeof actual === "number" &&
        typeof pred.value === "number" &&
        actual <= pred.value
      );
    case "contains":
      return (
        typeof actual === "string" &&
        actual.toLowerCase().includes(String(pred.value).toLowerCase())
      );
    default:
      return false;
  }
}

export function evaluateAudienceFilter(
  merchant: AudienceCandidateMerchant,
  filter: AudienceFilterGroup
): boolean {
  if (merchant.suppressed) return false;
  const predResults = filter.predicates.map((p) =>
    evaluateAudiencePredicate(merchant, p)
  );
  const groupResults = (filter.groups ?? []).map((g) =>
    evaluateAudienceFilter(merchant, g)
  );
  const all = [...predResults, ...groupResults];
  if (all.length === 0) return true;
  return filter.logic === "and" ? all.every(Boolean) : all.some(Boolean);
}

export function queryDynamicAudience(
  merchants: AudienceCandidateMerchant[],
  filter: AudienceFilterGroup,
  limit = 50
): AudienceCandidateMerchant[] {
  return merchants
    .filter((m) => evaluateAudienceFilter(m, filter))
    .toSorted((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
    .slice(0, Math.max(1, limit));
}

// ---- U-080 (PILE-553): Monthly Vendor Budget Hard-Stop ----

export interface VendorBudgetState {
  vendor: string;
  monthlyCapCents: number;
  spentThisMonthCents: number;
}

export function checkVendorBudgetHardStop(
  budget: VendorBudgetState,
  proposedCostCents: number
): {
  allowed: boolean;
  remainingCents: number;
  reason?: "VENDOR_BUDGET_EXCEEDED";
} {
  const cost = Math.max(0, proposedCostCents);
  const remainingCents = Math.max(
    0,
    budget.monthlyCapCents - budget.spentThisMonthCents
  );
  if (cost > remainingCents) {
    return {
      allowed: false,
      remainingCents,
      reason: "VENDOR_BUDGET_EXCEEDED",
    };
  }
  return {
    allowed: true,
    remainingCents: remainingCents - cost,
  };
}

// ---- U-075 (PILE-549): Book of Business Ownership Guard ----

export function checkBookOwnershipGuard(input: {
  merchantOwnerId?: string | null;
  actorUserId: string;
  action: "claim" | "engage";
}): {
  allowed: boolean;
  warning?: "OWNED_BY_OTHER_REP";
  blockedReason?: "ALREADY_CLAIMED_BY_OTHER_REP";
} {
  if (!input.merchantOwnerId || input.merchantOwnerId === input.actorUserId) {
    return { allowed: true };
  }
  if (input.action === "claim") {
    return {
      allowed: false,
      blockedReason: "ALREADY_CLAIMED_BY_OTHER_REP",
    };
  }
  return {
    allowed: true,
    warning: "OWNED_BY_OTHER_REP",
  };
}

// ---- U-045..U-052 (PILE-521..527): Event-Triggered Lead Play Runner ----

export interface LeadPlayStepLog {
  step:
    | "ownership_guard"
    | "profiler_rank"
    | "detective_waterfall"
    | "send_gate"
    | "drafter_queue";
  status: "completed" | "skipped" | "blocked";
  detail: string;
}

export interface LeadPlayRunReceipt {
  merchantId: string;
  playName: string;
  status: "awaiting_approval" | "blocked" | "nurture_low_rank";
  breakdown: MerchantRankBreakdown;
  posGuess: string | null;
  newSignal: MerchantSignal | null;
  waterfallSteps: Array<
    "pile_records" | "public_registries" | "website_crawl" | "paid_vendor"
  >;
  gateDecision: GateDecision;
  draftedTouch: {
    channel: "email" | "visit" | "call";
    subject: string;
    body: string;
    evidenceSignalIds: string[];
  } | null;
  steps: LeadPlayStepLog[];
}

export function runMerchantLeadPlay(input: {
  merchant: AudienceCandidateMerchant;
  signals: MerchantSignal[];
  html?: string;
  pageUrl?: string;
  playName?: string;
  minDraftRankScore?: number;
  paidRankThreshold?: number;
  vendorBudget?: VendorBudgetState;
  estimatedPaidLookupCents?: number;
  suppressed?: boolean;
  domainSuppressed?: boolean;
  emailSuppressed?: boolean;
  contactEmail?: string | null;
  emailStatus?: "valid" | "invalid" | "catch_all" | "role" | "unknown";
  allowUnverified?: boolean;
  actorUserId?: string;
  action?: "engage" | "claim";
  nowIso?: string;
}): LeadPlayRunReceipt {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const playName = input.playName ?? "nyc_smb_signal_to_draft";
  const allSignals = [...input.signals];
  let posGuess = input.merchant.processor ?? null;
  let newSignal: MerchantSignal | null = null;

  if (input.html && input.pageUrl) {
    const det = detectPosTechnographics({
      merchantId: input.merchant.id,
      pageUrl: input.pageUrl,
      html: input.html,
      observedAt: nowIso,
    });
    if (det.posGuess) posGuess = det.posGuess;
    if (det.signal) {
      newSignal = det.signal;
      allSignals.push(det.signal);
    }
  }

  // Step 1: Profiler ICP Fit + Ranker v2
  const breakdown = rankMerchantSignals({
    merchantId: input.merchant.id,
    merchantAttrs: {
      vertical: (input.merchant.vertical ?? "").toLowerCase(),
      hasAddress: Boolean(input.merchant.address),
      hasPhone: Boolean(input.merchant.phone),
    },
    signals: allSignals,
    config: {
      motion: "smb_default",
      icpRules: DEFAULT_ICP_RULES,
      signalRules: DEFAULT_SIGNAL_RULES,
    },
    nowIso,
  });
  const steps: LeadPlayStepLog[] = [];
  if (input.actorUserId) {
    const ownership = checkBookOwnershipGuard({
      merchantOwnerId: input.merchant.ownerId,
      actorUserId: input.actorUserId,
      action: input.action ?? "engage",
    });
    if (!ownership.allowed) {
      steps.push({
        step: "ownership_guard",
        status: "blocked",
        detail: ownership.blockedReason ?? "ALREADY_CLAIMED_BY_OTHER_REP",
      });
      return {
        merchantId: input.merchant.id,
        playName,
        status: "blocked",
        breakdown,
        posGuess,
        newSignal,
        waterfallSteps: [],
        gateDecision: {
          touchId: `play_${input.merchant.id}`,
          channel: "visit",
          evaluatedAt: nowIso,
          result: "block",
          reasons: ["EXCLUDED_BY_POLICY"],
          matchedExclusions: [],
        },
        draftedTouch: null,
        steps,
      };
    }
    steps.push({
      step: "ownership_guard",
      status: "completed",
      detail: ownership.warning ?? "allowed",
    });
  }
  steps.push({
    step: "profiler_rank",
    status: "completed",
    detail: `priorityScore=${breakdown.priorityScore} fit=${breakdown.fitScore} (${breakdown.fitRating}) timing=${breakdown.timingScore}`,
  });

  // Step 2: Detective free-first waterfall gated by rank & vendor budget
  const estimatedCost = input.estimatedPaidLookupCents ?? 50;
  const budgetCheck = input.vendorBudget
    ? checkVendorBudgetHardStop(input.vendorBudget, estimatedCost)
    : { allowed: true, remainingCents: 10_000 };
  const waterfallSteps = planDetectiveWaterfall({
    rankScore: breakdown.priorityScore,
    paidRankThreshold: input.paidRankThreshold ?? 75,
    monthlyBudgetRemainingCents: budgetCheck.allowed
      ? budgetCheck.remainingCents + estimatedCost
      : 0,
    estimatedPaidLookupCents: estimatedCost,
    alreadyHasVerifiedEmailAndPhone:
      Boolean(input.contactEmail) && Boolean(input.merchant.phone),
    // PILE-610 — vendorBudget is the explicit vendor configuration carrier;
    // without it the waterfall never plans a paid lookup.
    paidVendorConfigured: Boolean(input.vendorBudget),
  });
  steps.push({
    step: "detective_waterfall",
    status: "completed",
    detail: `sources=${waterfallSteps.join("->")}${budgetCheck.reason ? ` (${budgetCheck.reason})` : ""}`,
  });

  // Step 3: Send Gate
  const preferredChannel: "email" | "visit" | "call" = input.contactEmail
    ? "email"
    : input.merchant.address
      ? "visit"
      : "call";
  const gateDecision = evaluateSendGate({
    touchId: `play_${input.merchant.id}`,
    channel: preferredChannel,
    action: input.action ?? "engage",
    now: nowIso,
    merchant: {
      id: input.merchant.id,
      domain: input.merchant.domain,
      permissions: {
        doNotContact:
          Boolean(input.suppressed) || Boolean(input.domainSuppressed),
      },
    },
    contact: {
      id: input.contactEmail ?? `contact_${input.merchant.id}`,
      email: input.contactEmail ?? null,
      permissions: {
        doNotEmail: Boolean(input.emailSuppressed),
        emailStatus: input.emailStatus ?? "valid",
      },
    },
    cadence: {
      allowUnverified: input.allowUnverified ?? !input.emailStatus,
      concurrency: "allowed",
    },
  });
  if (gateDecision.result === "block") {
    steps.push({
      step: "send_gate",
      status: "blocked",
      detail: `blocked: ${gateDecision.reasons.join(",")}`,
    });
    return {
      merchantId: input.merchant.id,
      playName,
      status: "blocked",
      breakdown,
      posGuess,
      newSignal,
      waterfallSteps,
      gateDecision,
      draftedTouch: null,
      steps,
    };
  }
  steps.push({
    step: "send_gate",
    status: "completed",
    detail: `result=${gateDecision.result}`,
  });

  // Step 4: Drafter creates awaiting_approval touch cited by Signal IDs
  const minDraftRank = input.minDraftRankScore ?? 35;
  if (breakdown.priorityScore < minDraftRank) {
    steps.push({
      step: "drafter_queue",
      status: "skipped",
      detail: `priorityScore ${breakdown.priorityScore} below minDraftRankScore ${minDraftRank}`,
    });
    return {
      merchantId: input.merchant.id,
      playName,
      status: "nurture_low_rank",
      breakdown,
      posGuess,
      newSignal,
      waterfallSteps,
      gateDecision,
      draftedTouch: null,
      steps,
    };
  }

  const posAngle = posGuess
    ? `We noticed ${input.merchant.name} is running ${posGuess.toUpperCase()} and wanted to share a side-by-side processing rate breakdown.`
    : `We put together a processing rate & dual-pricing savings breakdown for ${input.merchant.name}.`;
  const draftedTouch = {
    channel: preferredChannel,
    subject: `Quick question for ${input.merchant.name}`,
    body: `${breakdown.whyNow}\n\n${posAngle}`,
    evidenceSignalIds: breakdown.whyNowSignalIds,
  };
  steps.push({
    step: "drafter_queue",
    status: "completed",
    detail: `queued ${preferredChannel} draft in awaiting_approval (${breakdown.whyNowSignalIds.length} signal citations)`,
  });

  return {
    merchantId: input.merchant.id,
    playName,
    status: "awaiting_approval",
    breakdown,
    posGuess,
    newSignal,
    waterfallSteps,
    gateDecision,
    draftedTouch,
    steps,
  };
}

// ---- U-084 / U-085 / U-088 (PILE-555..559): 90-Day Pipeline Attribution & Rep Morning Brief ----

export interface PipelineAttributionTouchpoint {
  merchantId: string;
  signalType: string;
  playName: string;
  cadenceId: string;
  touchedAt: string;
  replied: boolean;
  costCents: number;
}

export interface BoardedAttributionCredit {
  merchantId: string;
  boardedAt: string;
  attributionType: "direct" | "indirect" | "unattributed";
  firstTouchSignal: string | null;
  mostRecentPlay: string | null;
  mostRecentCadence: string | null;
  totalAcquisitionCostCents: number;
}

export function computePipelineAttribution(input: {
  merchantId: string;
  boardedAt: string;
  touchpoints: PipelineAttributionTouchpoint[];
  windowDays?: number;
}): BoardedAttributionCredit {
  const windowMs = (input.windowDays ?? 90) * 86_400_000;
  const boardedMs = Date.parse(input.boardedAt);
  const inWindow = input.touchpoints
    .filter((tp) => {
      if (tp.merchantId !== input.merchantId) return false;
      const tMs = Date.parse(tp.touchedAt);
      return (
        Number.isFinite(tMs) && tMs <= boardedMs && boardedMs - tMs <= windowMs
      );
    })
    .toSorted((a, b) => Date.parse(a.touchedAt) - Date.parse(b.touchedAt));

  const totalCost = inWindow.reduce((sum, tp) => sum + tp.costCents, 0);
  if (inWindow.length === 0) {
    return {
      merchantId: input.merchantId,
      boardedAt: input.boardedAt,
      attributionType: "unattributed",
      firstTouchSignal: null,
      mostRecentPlay: null,
      mostRecentCadence: null,
      totalAcquisitionCostCents: 0,
    };
  }
  const first = inWindow[0]!;
  const last = inWindow[inWindow.length - 1]!;
  const anyReplied = inWindow.some((tp) => tp.replied);
  return {
    merchantId: input.merchantId,
    boardedAt: input.boardedAt,
    attributionType: anyReplied ? "direct" : "indirect",
    firstTouchSignal: first.signalType,
    mostRecentPlay: last.playName,
    mostRecentCadence: last.cadenceId,
    totalAcquisitionCostCents: totalCost,
  };
}

export interface MorningBriefItem {
  merchantId: string;
  name: string;
  priorityScore: number;
  fitScore: number;
  fitStatus: string | null;
  processor: string | null;
  whyNow: string;
  address: string | null;
  phone: string | null;
  domain: string | null;
  recommendedAction: "walk_in_visit" | "call_owner" | "send_approved_email";
}

export function buildRepMorningBrief(input: {
  merchants: AudienceCandidateMerchant[];
  ownerId?: string | null;
  limit?: number;
}): {
  generatedAt: string;
  totalCandidates: number;
  items: MorningBriefItem[];
} {
  const eligible = input.merchants.filter((m) => {
    if (m.suppressed) return false;
    if (input.ownerId && m.ownerId && m.ownerId !== input.ownerId) {
      return false;
    }
    return (m.priorityScore ?? 0) > 0 || Boolean(m.address) || Boolean(m.phone);
  });
  const sorted = eligible.toSorted(
    (a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0)
  );
  const items: MorningBriefItem[] = sorted
    .slice(0, Math.max(1, input.limit ?? 15))
    .map((m) => ({
      merchantId: m.id,
      name: m.name,
      priorityScore: m.priorityScore ?? 0,
      fitScore: m.fitScore ?? 0,
      fitStatus: m.fitStatus ?? null,
      processor: m.processor ?? null,
      whyNow: m.whyNow ?? "High-fit SMB in target corridor.",
      address: m.address ?? null,
      phone: m.phone ?? null,
      domain: m.domain ?? null,
      recommendedAction: m.address
        ? "walk_in_visit"
        : m.phone
          ? "call_owner"
          : "send_approved_email",
    }));

  return {
    generatedAt: new Date().toISOString(),
    totalCandidates: eligible.length,
    items,
  };
}
