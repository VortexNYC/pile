// PILE-478..482 (Unify-parity U-001..U-005) — deterministic outbound send &
// claim gate for Pile sales motions:
//   - U-001 (PILE-478): merchant & contact permission flags (doNotContact,
//     doNotEmail, doNotCall, optedOutAt, optOutSource, euResident)
//   - U-002 (PILE-479): Reacher email verification status gate (valid, invalid,
//     catch_all, role, unknown + staleness window)
//   - U-003 (PILE-480): Exclusion lists with allow / warn / block per action
//     (engage vs claim), most restrictive wins
//   - U-004 (PILE-481): Deterministic SendGate returning GateDecision with
//     typed reason codes
//   - U-005 (PILE-482): Single active cadence per merchant, re-touch cooldown
//     from finished enrollments with >=1 completed step, and maxActiveContacts

export type TouchChannel = "email" | "call" | "visit" | "linkedin";

export type EmailVerificationStatus =
  | "valid"
  | "invalid"
  | "catch_all"
  | "role"
  | "unknown";

export type GateResult = "pass" | "warn" | "block";
export type ExclusionBehavior = "allow" | "warn" | "block";

export type GateReasonCode =
  | "MERCHANT_DO_NOT_CONTACT"
  | "CONTACT_OPTED_OUT"
  | "CONTACT_DO_NOT_EMAIL"
  | "CONTACT_DO_NOT_CALL"
  | "EU_RESIDENT_CONSENT_REQUIRED"
  | "EMAIL_INVALID"
  | "EMAIL_CATCH_ALL_BLOCKED"
  | "EMAIL_ROLE_ADDRESS_BLOCKED"
  | "EMAIL_UNVERIFIED"
  | "EMAIL_VERIFICATION_STALE"
  | "EXCLUDED_BY_POLICY"
  | "EXCLUSION_WARNING"
  | "ACTIVE_CADENCE_EXISTS"
  | "RETOUCH_COOLDOWN_ACTIVE"
  | "MERCHANT_CONTACT_CAP_REACHED";

export interface MerchantPermissionFlags {
  doNotContact?: boolean;
  doNotContactBy?: string | null;
  doNotContactAt?: string | null;
  doNotContactReason?: string | null;
  maxActiveContacts?: number | null;
}

export interface ContactPermissionFlags {
  doNotEmail?: boolean;
  doNotCall?: boolean;
  optedOutAt?: string | null;
  optOutSource?: string | null;
  euResident?: boolean;
  hasExplicitConsent?: boolean;
  emailStatus?: EmailVerificationStatus;
  emailVerifiedAt?: string | null;
}

export interface CadenceSendPolicy {
  allowCatchAll?: boolean;
  allowRole?: boolean;
  allowUnverified?: boolean;
  verificationMaxAgeDays?: number;
  concurrency?: "allowed" | "manual_only" | "not_allowed";
  reenrollWaitDays?: number;
}

export interface ExclusionRule {
  id: string;
  name: string;
  behaviorEngage: ExclusionBehavior;
  behaviorClaim: ExclusionBehavior;
  match: {
    customerIds?: string[];
    domains?: string[];
    customerStatuses?: string[];
    dealStages?: string[];
  };
}

export interface EnrollmentSnapshot {
  id: string;
  contactId: string;
  status: "active" | "finished" | "stopped";
  completedSteps: number;
  endedAt?: string | null;
}

export interface SendGateInput {
  touchId: string;
  channel: TouchChannel;
  action?: "engage" | "claim";
  isManualEnrollment?: boolean;
  now?: string;
  merchant: {
    id: string;
    domain?: string | null;
    status?: string | null;
    dealStages?: string[];
    permissions?: MerchantPermissionFlags;
  };
  contact: {
    id: string;
    email?: string | null;
    permissions?: ContactPermissionFlags;
  };
  cadence?: CadenceSendPolicy;
  exclusions?: ExclusionRule[];
  enrollments?: EnrollmentSnapshot[];
}

export interface GateDecision {
  touchId: string;
  channel: TouchChannel;
  result: GateResult;
  reasons: GateReasonCode[];
  matchedExclusions: string[];
  evaluatedAt: string;
}

const RESULT_RANK: Record<GateResult, number> = {
  pass: 0,
  warn: 1,
  block: 2,
};

function stricterResult(a: GateResult, b: GateResult): GateResult {
  return RESULT_RANK[a] >= RESULT_RANK[b] ? a : b;
}

/** U-001 (PILE-478): dialer 'do_not_call' / 'opt_out' dispositions stamp
 *  opt-out flags with provenance. */
export function applyCallDispositionPermissionFlags(
  current: ContactPermissionFlags,
  disposition:
    | "connected"
    | "voicemail"
    | "no_answer"
    | "do_not_call"
    | "opt_out",
  nowIso = new Date().toISOString()
): ContactPermissionFlags {
  if (disposition === "do_not_call") {
    return {
      ...current,
      doNotCall: true,
      optedOutAt: current.optedOutAt ?? nowIso,
      optOutSource: "call_disposition:do_not_call",
    };
  }
  if (disposition === "opt_out") {
    return {
      ...current,
      doNotCall: true,
      doNotEmail: true,
      optedOutAt: current.optedOutAt ?? nowIso,
      optOutSource: "call_disposition:opt_out",
    };
  }
  return current;
}

/** U-003 (PILE-480): evaluate exclusion rules for `engage` or `claim`; most
 *  restrictive behavior wins. */
export function evaluateExclusions(
  rules: ExclusionRule[],
  merchant: SendGateInput["merchant"],
  action: "engage" | "claim" = "engage"
): { result: GateResult; matchedNames: string[] } {
  let result: GateResult = "pass";
  const matchedNames: string[] = [];
  const normalizedDomain = merchant.domain?.trim().toLowerCase() ?? "";
  for (const rule of rules) {
    const m = rule.match;
    const hitCustomer = m.customerIds?.includes(merchant.id) ?? false;
    const hitDomain =
      normalizedDomain.length > 0 &&
      (m.domains?.some((d) => d.trim().toLowerCase() === normalizedDomain) ??
        false);
    const hitStatus =
      Boolean(merchant.status) &&
      (m.customerStatuses?.includes(merchant.status!) ?? false);
    const hitDeal = (merchant.dealStages ?? []).some(
      (stage) => m.dealStages?.includes(stage) ?? false
    );
    if (hitCustomer || hitDomain || hitStatus || hitDeal) {
      matchedNames.push(rule.name);
      const rawBehavior =
        action === "claim" ? rule.behaviorClaim : rule.behaviorEngage;
      const behavior: GateResult =
        rawBehavior === "allow" ? "pass" : rawBehavior;
      result = stricterResult(result, behavior);
    }
  }
  return { result, matchedNames };
}

/** U-004 (PILE-481): deterministic send/claim gate combining U-001, U-002,
 *  U-003, and U-005. */
export function evaluateSendGate(input: SendGateInput): GateDecision {
  const nowIso = input.now ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  const reasons: GateReasonCode[] = [];
  let result: GateResult = "pass";

  const mPerm = input.merchant.permissions ?? {};
  const cPerm = input.contact.permissions ?? {};
  const cadence = input.cadence ?? {};

  // 1. U-001: Merchant & contact permission flags
  if (mPerm.doNotContact) {
    reasons.push("MERCHANT_DO_NOT_CONTACT");
    result = "block";
  }
  if (cPerm.optedOutAt) {
    reasons.push("CONTACT_OPTED_OUT");
    result = "block";
  }
  if (input.channel === "email" && cPerm.doNotEmail) {
    reasons.push("CONTACT_DO_NOT_EMAIL");
    result = "block";
  }
  if (
    (input.channel === "call" || input.channel === "visit") &&
    cPerm.doNotCall
  ) {
    reasons.push("CONTACT_DO_NOT_CALL");
    result = "block";
  }
  if (cPerm.euResident && !cPerm.hasExplicitConsent) {
    reasons.push("EU_RESIDENT_CONSENT_REQUIRED");
    result = "block";
  }

  // 2. U-002: Email verification status (Reacher) gate for email touches
  if (input.channel === "email") {
    const status = cPerm.emailStatus ?? "unknown";
    if (status === "invalid") {
      reasons.push("EMAIL_INVALID");
      result = "block";
    } else if (status === "catch_all" && !cadence.allowCatchAll) {
      reasons.push("EMAIL_CATCH_ALL_BLOCKED");
      result = "block";
    } else if (status === "role" && !cadence.allowRole) {
      reasons.push("EMAIL_ROLE_ADDRESS_BLOCKED");
      result = "block";
    } else if (status === "unknown" && !cadence.allowUnverified) {
      reasons.push("EMAIL_UNVERIFIED");
      result = "block";
    }
    if (
      cadence.verificationMaxAgeDays != null &&
      cadence.verificationMaxAgeDays > 0
    ) {
      const verifiedMs = Date.parse(cPerm.emailVerifiedAt ?? "");
      const maxAgeMs = cadence.verificationMaxAgeDays * 86_400_000;
      if (!Number.isFinite(verifiedMs) || nowMs - verifiedMs > maxAgeMs) {
        reasons.push("EMAIL_VERIFICATION_STALE");
        result = "block";
      }
    }
  }

  // 3. U-003: Exclusion lists
  const excl = evaluateExclusions(
    input.exclusions ?? [],
    input.merchant,
    input.action ?? "engage"
  );
  if (excl.result === "block") {
    reasons.push("EXCLUDED_BY_POLICY");
    result = "block";
  } else if (excl.result === "warn") {
    reasons.push("EXCLUSION_WARNING");
    result = stricterResult(result, "warn");
  }

  // 4. U-005: Single active cadence per merchant, re-touch cooldown, and contact cap
  const enrollments = input.enrollments ?? [];
  const activeEnrollments = enrollments.filter((e) => e.status === "active");
  const concurrency = cadence.concurrency ?? "not_allowed";
  if (activeEnrollments.length > 0) {
    if (
      concurrency === "not_allowed" ||
      (concurrency === "manual_only" && !input.isManualEnrollment)
    ) {
      reasons.push("ACTIVE_CADENCE_EXISTS");
      result = "block";
    }
  }
  if (mPerm.maxActiveContacts != null && mPerm.maxActiveContacts > 0) {
    const activeContacts = new Set(activeEnrollments.map((e) => e.contactId));
    if (
      !activeContacts.has(input.contact.id) &&
      activeContacts.size >= mPerm.maxActiveContacts
    ) {
      reasons.push("MERCHANT_CONTACT_CAP_REACHED");
      result = "block";
    }
  }
  if (cadence.reenrollWaitDays != null && cadence.reenrollWaitDays > 0) {
    const waitMs = cadence.reenrollWaitDays * 86_400_000;
    const inCooldown = enrollments.some((e) => {
      if (e.status === "active" || e.completedSteps < 1 || !e.endedAt) {
        return false;
      }
      const endedMs = Date.parse(e.endedAt);
      return Number.isFinite(endedMs) && nowMs - endedMs < waitMs;
    });
    if (inCooldown) {
      reasons.push("RETOUCH_COOLDOWN_ACTIVE");
      result = "block";
    }
  }

  return {
    touchId: input.touchId,
    channel: input.channel,
    result,
    reasons,
    matchedExclusions: excl.matchedNames,
    evaluatedAt: nowIso,
  };
}
