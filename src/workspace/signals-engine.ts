// PILE-507..513, PILE-518, PILE-520, PILE-528..530, PILE-532, PILE-533
// (Unify-parity Signals, Ranking v2, ICP Fit/Timing, "Why Now", PostHog
// Product Signals, Typed Research Questions, Consent Identify, SMB Dedup Match
// Keys, Field Provenance, Detective Waterfall, POS Technographics, and Public
// Registry Signals).

// ---- U-030 (PILE-507): Signal Records & Backfill ----

export type SignalType =
  | "new_license"
  | "license_pending"
  | "ownership_change"
  | "new_location"
  | "pos_detected"
  | "product_signup"
  | "onboarding_step"
  | "pricing_view"
  | "invoice_created"
  | "stalled_onboarding"
  | "review_velocity_spike"
  | "hiring_activity"
  | "revenue_estimate"
  | "negative_closure";

export interface MerchantSignal {
  id: string;
  merchantId: string;
  type: SignalType | string;
  observedAt: string;
  source: string;
  evidenceUrl: string;
  strength: number; // 0..100
  summary?: string | null;
  expiresAt?: string | null;
}

export interface RawMerchantSourceItem {
  id: string;
  merchantId: string;
  sourceName: string;
  signalType: SignalType | string;
  observedAt: string;
  evidenceUrl: string;
  strength?: number;
  summary?: string | null;
  activeForDays?: number;
}

export function backfillSignalsFromSourceItems(
  items: RawMerchantSourceItem[]
): MerchantSignal[] {
  return items.map((item) => {
    const obsMs = Date.parse(item.observedAt);
    const activeDays = item.activeForDays ?? 90;
    const expiresAt = Number.isFinite(obsMs)
      ? new Date(obsMs + activeDays * 86_400_000).toISOString()
      : null;
    return {
      id: `sig_${item.id}`,
      merchantId: item.merchantId,
      type: item.signalType,
      observedAt: item.observedAt,
      source: item.sourceName,
      evidenceUrl: item.evidenceUrl,
      strength: Math.max(0, Math.min(100, item.strength ?? 75)),
      summary: item.summary ?? null,
      expiresAt,
    };
  });
}

// ---- U-031 / U-032 / U-033 (PILE-508..510): ICP Fit, Timing, Ordered Ranker v2 & "Why Now" ----

export type IntelRating = "poor" | "fair" | "good" | "great";

export interface IcpRule {
  id: string;
  motion: string;
  field: string;
  op: "eq" | "in" | "gte" | "lte";
  value: string | number | boolean | Array<string | number>;
  weight: number; // positive or negative points
}

export interface SignalRuleConfig {
  type: SignalType | string;
  polarity: "positive" | "negative";
  weight: number;
  activeForDays: number;
  halfLifeDays?: number;
  label?: string;
}

export interface RankingConfig {
  motion: string;
  icpRules: IcpRule[];
  signalRules: SignalRuleConfig[];
  stackBonusThreshold?: number;
  stackBonusMultiplier?: number;
}

/** Attributes a ranker call site knows about a merchant. The index
 *  signature keeps the shape open for workspace-specific keys; the named
 *  fields are the ones ICP rules conventionally predicate on. */
export interface MerchantAttrs {
  vertical?: string;
  hasAddress?: boolean;
  hasPhone?: boolean;
  /** PILE-654 — reported monthly card volume in integer cents, written
   *  to the `monthly_card_volume_cents` custom field by /intake. */
  estMonthlyVolumeCents?: number;
  /** PILE-663 — explicit opt-in: storefronts count as targets even without a
   *  collected volume figure (e.g. a storefront-sourced lead sheet). */
  allowStorefronts?: boolean;
  /** PILE-663 — set internally by rankMerchantSignals when a storefront
   *  merchant has revenue proof; drives `icp-storefront-with-volume`. */
  storefrontWithVolume?: boolean;
  [key: string]: unknown;
}

/** PILE-654 — read the intake-derived monthly card volume back off a
 *  customer's custom-field map (a `Record<string, string>` from the DO,
 *  or the same map as a JSON string). Returns undefined when the field is
 *  absent or non-numeric so gte/lte rules simply don't fire. */
export function estMonthlyVolumeCentsFromFields(
  fields: unknown
): number | undefined {
  try {
    const map =
      typeof fields === "string" ? (JSON.parse(fields) as unknown) : fields;
    if (!map || typeof map !== "object") return undefined;
    const raw = (map as Record<string, unknown>).monthly_card_volume_cents;
    if (raw === null || raw === undefined || raw === "") return undefined;
    const cents = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(cents) && cents >= 0 ? Math.round(cents) : undefined;
  } catch {
    return undefined;
  }
}

export interface SignalContribution {
  signalId: string;
  type: string;
  polarity: "positive" | "negative";
  points: number;
  evidenceUrl: string;
  summary: string;
}

export interface MerchantRankBreakdown {
  merchantId: string;
  motion: string;
  priorityScore: number;
  fitScore: number;
  timingScore: number;
  fitRating: IntelRating;
  timingRating: IntelRating;
  stackBonusApplied: boolean;
  signalContributions: SignalContribution[];
  matchedIcpRules: string[];
  whyNow: string;
  whyNowSignalIds: string[];
  scoredAt: string;
}

export function scoreToRating(score: number): IntelRating {
  if (score >= 75) return "great";
  if (score >= 50) return "good";
  if (score >= 25) return "fair";
  return "poor";
}

export function evaluateIcpFit(
  merchantAttrs: MerchantAttrs,
  rules: IcpRule[]
): { fitScore: number; rating: IntelRating; matchedRules: string[] } {
  let raw = 50; // neutral baseline
  const matchedRules: string[] = [];
  for (const rule of rules) {
    const val = merchantAttrs[rule.field];
    let hit = false;
    if (rule.op === "eq") {
      hit = val === rule.value;
    } else if (rule.op === "in" && Array.isArray(rule.value)) {
      hit = rule.value.includes(val as string | number);
    } else if (
      rule.op === "gte" &&
      typeof val === "number" &&
      typeof rule.value === "number"
    ) {
      hit = val >= rule.value;
    } else if (
      rule.op === "lte" &&
      typeof val === "number" &&
      typeof rule.value === "number"
    ) {
      hit = val <= rule.value;
    }
    if (hit) {
      raw += rule.weight;
      matchedRules.push(rule.id);
    }
  }
  const fitScore = Math.max(0, Math.min(100, Math.round(raw)));
  return {
    fitScore,
    rating: scoreToRating(fitScore),
    matchedRules,
  };
}

/** U-033 (PILE-510): generate plain-English "why now" from top 3 positive
 *  signals, cited by Signal ID. */
export function generateWhyNow(contributions: SignalContribution[]): {
  whyNow: string;
  signalIds: string[];
} {
  const topPositive = contributions
    .filter((c) => c.polarity === "positive" && c.points > 0)
    .toSorted((a, b) => b.points - a.points)
    .slice(0, 3);
  if (topPositive.length === 0) {
    return { whyNow: "No active timing signals.", signalIds: [] };
  }
  const parts = topPositive.map((c) => `${c.summary} [${c.signalId}]`);
  return {
    whyNow: `Why now: ${parts.join("; ")}.`,
    signalIds: topPositive.map((c) => c.signalId),
  };
}

// ---- PILE-663: storefront exclusion-bias relief ----

/** Vertical keywords treated as storefront (card-present) businesses. */
export const STOREFRONT_VERTICAL_KEYWORDS = [
  "restaurant",
  "bar",
  "cafe",
  "nightclub",
  "retail",
  "grocery",
  "salon",
  "bakery",
  "pizzeria",
  "deli",
  "bistro",
  "taqueria",
  "barber",
  "boutique",
];

/** The default exclusion rule that buries storefronts by -40. */
export const STOREFRONT_EXCLUSION_RULE_ID =
  "icp-vertical-pos-bound-restaurant-penalty";

/** Signal types that prove a storefront is a card-present revenue business
 *  (collected/estimated dollars or a switch/pain event worth competing on). */
const STOREFRONT_RELIEF_SIGNAL_TYPES = new Set([
  "revenue_estimate",
  "pos_detected",
  "ownership_change",
  "tax_warrant",
  "warrant",
  "violation",
  "award",
  "ucc_filing",
  "payment_award",
]);

/** Monthly-volume floor (in cents) that counts as proven card volume —
 *  aligned with the `icp-est-monthly-card-volume` gte threshold. */
export const STOREFRONT_VOLUME_THRESHOLD_CENTS = 1_000_000;

export function isStorefrontVertical(vertical?: string | null): boolean {
  const v = (vertical ?? "").toLowerCase();
  if (!v) return false;
  return STOREFRONT_VERTICAL_KEYWORDS.some((k) => v.includes(k));
}

/** PILE-663 — a storefront with a positive revenue signal is a card-present
 *  rate-competition target, not a POS exclusion. True when the merchant has
 *  an intake/collected volume ≥ threshold, an explicit `allowStorefronts`
 *  opt-in, or a revenue/pain/switch signal on record. */
export function hasStorefrontRevenueProof(
  merchantAttrs: MerchantAttrs,
  signals: MerchantSignal[],
  merchantId?: string
): boolean {
  if (merchantAttrs.allowStorefronts === true) return true;
  if (
    typeof merchantAttrs.estMonthlyVolumeCents === "number" &&
    merchantAttrs.estMonthlyVolumeCents >= STOREFRONT_VOLUME_THRESHOLD_CENTS
  ) {
    return true;
  }
  return signals.some(
    (s) =>
      (!merchantId || s.merchantId === merchantId) &&
      STOREFRONT_RELIEF_SIGNAL_TYPES.has(s.type) &&
      s.strength > 0
  );
}

/** U-031 (PILE-508): ordered Ranker v2 combining ICP Fit + decayed Signals +
 *  3-signal stack bonus. */
export function rankMerchantSignals(input: {
  merchantId: string;
  merchantAttrs: MerchantAttrs;
  signals: MerchantSignal[];
  config: RankingConfig;
  nowIso?: string;
}): MerchantRankBreakdown {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(nowIso);
  // PILE-663 — storefront with revenue proof: lift the POS-storefront
  // exclusion penalty and fire `icp-storefront-with-volume` instead.
  const storefrontRelief =
    isStorefrontVertical(input.merchantAttrs.vertical) &&
    hasStorefrontRevenueProof(
      input.merchantAttrs,
      input.signals,
      input.merchantId
    );
  const icpRules = storefrontRelief
    ? input.config.icpRules.filter((r) => r.id !== STOREFRONT_EXCLUSION_RULE_ID)
    : input.config.icpRules;
  const icpAttrs: MerchantAttrs = storefrontRelief
    ? { ...input.merchantAttrs, storefrontWithVolume: true }
    : input.merchantAttrs;
  const icp = evaluateIcpFit(icpAttrs, icpRules);

  const ruleByType = new Map(input.config.signalRules.map((r) => [r.type, r]));
  const contributions: SignalContribution[] = [];
  let timingRaw = 0;
  const positiveTypes = new Set<string>();

  for (const sig of input.signals) {
    if (sig.merchantId !== input.merchantId) continue;
    const rule = ruleByType.get(sig.type);
    if (!rule) continue;
    const obsMs = Date.parse(sig.observedAt);
    if (!Number.isFinite(obsMs)) continue;
    const ageDays = Math.max(0, (nowMs - obsMs) / 86_400_000);
    if (ageDays > rule.activeForDays) continue;
    if (sig.expiresAt && Date.parse(sig.expiresAt) <= nowMs) continue;

    const halfLife = rule.halfLifeDays ?? Math.max(1, rule.activeForDays / 2);
    const decay = Math.pow(0.5, ageDays / halfLife);
    const magnitude = rule.weight * (sig.strength / 100) * decay;
    const signedPoints =
      rule.polarity === "negative" ? -Math.abs(magnitude) : Math.abs(magnitude);
    timingRaw += signedPoints;
    if (rule.polarity === "positive") positiveTypes.add(sig.type);

    contributions.push({
      signalId: sig.id,
      type: sig.type,
      polarity: rule.polarity,
      points: Math.round(signedPoints * 10) / 10,
      evidenceUrl: sig.evidenceUrl,
      summary: sig.summary ?? rule.label ?? sig.type.replaceAll("_", " "),
    });
  }

  const stackThreshold = input.config.stackBonusThreshold ?? 3;
  const stackMultiplier = input.config.stackBonusMultiplier ?? 1.15;
  const stackBonusApplied =
    positiveTypes.size >= stackThreshold && timingRaw > 0;
  if (stackBonusApplied) {
    timingRaw *= stackMultiplier;
  }

  const timingScore = Math.max(0, Math.min(100, Math.round(timingRaw)));
  // Priority score blends Fit (40%) and Timing (60%), gated on having >=1 positive signal.
  const priorityScore =
    positiveTypes.size === 0
      ? 0
      : Math.max(
          0,
          Math.min(100, Math.round(icp.fitScore * 0.4 + timingScore * 0.6))
        );
  const { whyNow, signalIds } = generateWhyNow(contributions);

  return {
    merchantId: input.merchantId,
    motion: input.config.motion,
    priorityScore,
    fitScore: icp.fitScore,
    timingScore,
    fitRating: icp.rating,
    timingRating: scoreToRating(timingScore),
    stackBonusApplied,
    signalContributions: contributions,
    matchedIcpRules: icp.matchedRules,
    whyNow,
    whyNowSignalIds: signalIds,
    scoredAt: nowIso,
  };
}

// ---- U-034 & U-036 (PILE-511 & PILE-513): Consent-Based Identify & PostHog Events -> Signals ----

export interface ConsentedContactIdentity {
  contactId: string;
  merchantId: string;
  email: string;
  posthogDistinctId: string;
  consentAt: string;
  consentSource: "submitted_form" | "signup";
}

export function identifyContactWithConsent(input: {
  contactId: string;
  merchantId: string;
  email: string;
  posthogDistinctId: string;
  source: "submitted_form" | "signup" | "pre_submit_keystroke" | "ip_reveal";
  explicitConsent: boolean;
  nowIso?: string;
}): ConsentedContactIdentity | null {
  // U-036: never capture pre-submit partial input or IP-to-company reveal,
  // and require explicit consent.
  if (
    !input.explicitConsent ||
    (input.source !== "submitted_form" && input.source !== "signup")
  ) {
    return null;
  }
  return {
    contactId: input.contactId,
    merchantId: input.merchantId,
    email: input.email.trim().toLowerCase(),
    posthogDistinctId: input.posthogDistinctId.trim(),
    consentAt: input.nowIso ?? new Date().toISOString(),
    consentSource: input.source,
  };
}

export interface PostHogEventMapping {
  eventName: string;
  signalType: SignalType | string;
  strength: number;
  summaryTemplate?: string;
}

export function mapPostHogEventToSignal(input: {
  eventId: string;
  eventName: string;
  distinctId: string;
  timestamp: string;
  identity: ConsentedContactIdentity | null;
  mappings: PostHogEventMapping[];
}): MerchantSignal | null {
  if (
    !input.identity ||
    input.identity.posthogDistinctId !== input.distinctId
  ) {
    return null;
  }
  const mapping = input.mappings.find((m) => m.eventName === input.eventName);
  if (!mapping) return null;
  return {
    id: `sig_ph_${input.eventId}`,
    merchantId: input.identity.merchantId,
    type: mapping.signalType,
    observedAt: input.timestamp,
    source: "posthog",
    evidenceUrl: `https://us.posthog.com/events/${encodeURIComponent(input.eventId)}`,
    strength: mapping.strength,
    summary: mapping.summaryTemplate ?? `Product event: ${input.eventName}`,
  };
}

// ---- U-035 & U-054 (PILE-512 & PILE-529): Typed Research Questions & Cited Evidence ----

export type ResearchQuestionType =
  | "boolean"
  | "number"
  | "select"
  | "multi_select"
  | "text";

export interface ResearchQuestion {
  key: string;
  type: ResearchQuestionType;
  prompt: string;
  options?: string[];
}

export interface ResearchAnswer {
  merchantId: string;
  key: string;
  value: boolean | number | string | string[];
  evidenceUrl: string;
  confidence: number; // 0..1
  answeredAt: string;
}

export function validateResearchAnswer(
  question: ResearchQuestion,
  answer: ResearchAnswer
): { valid: boolean; reason?: string } {
  if (!/^https?:\/\/\S+/i.test(answer.evidenceUrl.trim())) {
    return {
      valid: false,
      reason: "Every research answer must cite an http(s) evidenceUrl (U-054).",
    };
  }
  if (answer.confidence < 0 || answer.confidence > 1) {
    return { valid: false, reason: "Confidence must be in [0, 1]." };
  }
  switch (question.type) {
    case "boolean":
      if (typeof answer.value !== "boolean") {
        return { valid: false, reason: "Expected boolean value." };
      }
      break;
    case "number":
      if (typeof answer.value !== "number" || !Number.isFinite(answer.value)) {
        return { valid: false, reason: "Expected finite number value." };
      }
      break;
    case "select":
      if (
        typeof answer.value !== "string" ||
        (question.options && !question.options.includes(answer.value))
      ) {
        return {
          valid: false,
          reason: `Value must be one of: ${(question.options ?? []).join(", ")}`,
        };
      }
      break;
    case "multi_select":
      if (
        !Array.isArray(answer.value) ||
        (question.options &&
          answer.value.some((v) => !question.options!.includes(v)))
      ) {
        return { valid: false, reason: "Invalid multi_select option." };
      }
      break;
    case "text":
      if (typeof answer.value !== "string" || !answer.value.trim()) {
        return { valid: false, reason: "Expected non-empty text value." };
      }
      break;
  }
  return { valid: true };
}

// ---- U-041 & U-044 (PILE-518 & PILE-520): SMB Dedup Match Keys & Field Provenance ----

export function normalizeSmbName(name: string): string {
  return name
    .toLowerCase()
    .replace(
      /\b(llc|inc|corp|co|ltd|restaurant|cafe|bar|grill|the|street|st|avenue|ave)\b/g,
      " "
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeStreetAddress(
  address: string | null | undefined
): string {
  if (!address) return "";
  return address
    .toLowerCase()
    .replace(
      /\b(street|st|avenue|ave|boulevard|blvd|road|rd|floor|fl|suite|ste)\b/g,
      " "
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizePhoneE164(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = phone.replace(/\D+/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : "";
}

export function computeSmbMatchKey(input: {
  name: string;
  address?: string | null;
  phone?: string | null;
  domain?: string | null;
}): {
  matchKey: string;
  normalizedName: string;
  normalizedAddress: string;
  phoneE164: string;
  normalizedDomain: string;
} {
  const normalizedName = normalizeSmbName(input.name);
  const normalizedAddress = normalizeStreetAddress(input.address);
  const phoneE164 = normalizePhoneE164(input.phone);
  const normalizedDomain = (input.domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]!;
  const matchKey = [
    normalizedName,
    normalizedAddress || normalizedDomain || phoneE164,
  ]
    .filter(Boolean)
    .join("|");
  return {
    matchKey,
    normalizedName,
    normalizedAddress,
    phoneE164,
    normalizedDomain,
  };
}

export type FieldWriterRole = "human" | "play_default" | "agent" | "system";

const WRITER_PRECEDENCE: Record<FieldWriterRole, number> = {
  system: 1,
  agent: 2,
  play_default: 3,
  human: 4,
};

export interface FieldProvenance {
  entityId: string;
  field: string;
  value: unknown;
  source: string;
  actorId: string;
  writerRole: FieldWriterRole;
  evidenceUrl?: string | null;
  writtenAt: string;
}

/** U-044 (PILE-520): record provenance and respect human > play_default >
 *  agent > system precedence + fill_if_empty vs overwrite. */
export function applyFieldWriteWithProvenance(
  record: Record<string, unknown>,
  provenanceByField: Record<string, FieldProvenance>,
  write: {
    entityId: string;
    field: string;
    value: unknown;
    source: string;
    actorId: string;
    writerRole: FieldWriterRole;
    mode: "fill_if_empty" | "overwrite";
    evidenceUrl?: string | null;
    nowIso?: string;
  }
): {
  applied: boolean;
  record: Record<string, unknown>;
  provenanceByField: Record<string, FieldProvenance>;
} {
  const existingVal = record[write.field];
  const isEmpty =
    existingVal === undefined || existingVal === null || existingVal === "";
  if (write.mode === "fill_if_empty" && !isEmpty) {
    return { applied: false, record, provenanceByField };
  }
  const priorProv = provenanceByField[write.field];
  if (
    priorProv &&
    WRITER_PRECEDENCE[write.writerRole] <
      WRITER_PRECEDENCE[priorProv.writerRole]
  ) {
    return { applied: false, record, provenanceByField };
  }
  const entry: FieldProvenance = {
    entityId: write.entityId,
    field: write.field,
    value: write.value,
    source: write.source,
    actorId: write.actorId,
    writerRole: write.writerRole,
    evidenceUrl: write.evidenceUrl ?? null,
    writtenAt: write.nowIso ?? new Date().toISOString(),
  };
  return {
    applied: true,
    record: { ...record, [write.field]: write.value },
    provenanceByField: { ...provenanceByField, [write.field]: entry },
  };
}

// ---- U-055, U-057, U-058 (PILE-530, PILE-532, PILE-533): Technographics, Registry Signals & Detective Waterfall ----

const POS_FINGERPRINTS: Array<{ pos: string; re: RegExp }> = [
  { pos: "toast", re: /toasttab\.com|toast-pos/i },
  { pos: "clover", re: /clover\.com\/online-ordering|clover-pos/i },
  { pos: "spoton", re: /spoton\.com|order\.spoton/i },
  { pos: "quickbooks", re: /intuit\.com|quickbooks/i },
  { pos: "jobber", re: /getjobber\.com|clienthub\.getjobber/i },
  { pos: "housecall_pro", re: /housecallpro\.com/i },
  { pos: "servicetitan", re: /servicetitan\.com/i },
  { pos: "lawpay", re: /lawpay\.com|affinipay\.com/i },
  { pos: "freshbooks", re: /freshbooks\.com/i },
  { pos: "bill_com", re: /(?:^|\/\/|\.)bill\.com\b/i },
  { pos: "authorize_net", re: /authorize\.net/i },
  { pos: "mindbody", re: /mindbodyonline\.com/i },
  { pos: "janeapp", re: /(?:^|\/\/|\.)jane\.app\b/i },
  { pos: "square", re: /squareup\.com|square\.site|sq-payment/i },
  {
    pos: "stripe",
    re: /js\.stripe\.com|checkout\.stripe\.com|invoice\.stripe\.com/i,
  },
];

/** U-057 (PILE-532): fingerprint POS / payment stack from merchant HTML. */
export function detectPosTechnographics(input: {
  merchantId: string;
  pageUrl: string;
  html: string;
  observedAt?: string;
}): { posGuess: string | null; signal: MerchantSignal | null } {
  const nowIso = input.observedAt ?? new Date().toISOString();
  for (const fp of POS_FINGERPRINTS) {
    if (fp.re.test(input.html)) {
      return {
        posGuess: fp.pos,
        signal: {
          id: `sig_pos_${input.merchantId}_${fp.pos}`,
          merchantId: input.merchantId,
          type: "pos_detected",
          observedAt: nowIso,
          source: "website_technographics",
          evidenceUrl: input.pageUrl,
          strength: 85,
          summary: `Detected ${fp.pos.toUpperCase()} payment/billing stack on website`,
        },
      };
    }
  }
  return { posGuess: null, signal: null };
}

/** U-055 (PILE-530): Detective waterfall — free sources always run first;
 *  paid lookups only run when `rankScore >= paidRankThreshold` and budget remains. */
export function planDetectiveWaterfall(input: {
  rankScore: number;
  paidRankThreshold: number;
  monthlyBudgetRemainingCents: number;
  estimatedPaidLookupCents: number;
  alreadyHasVerifiedEmailAndPhone?: boolean;
  paidVendorConfigured?: boolean;
}): Array<
  "pile_records" | "public_registries" | "website_crawl" | "paid_vendor"
> {
  if (input.alreadyHasVerifiedEmailAndPhone) {
    return ["pile_records"];
  }
  const steps: Array<
    "pile_records" | "public_registries" | "website_crawl" | "paid_vendor"
  > = ["pile_records", "public_registries", "website_crawl"];
  // PILE-610 — paid lookups additionally require an explicitly configured
  // vendor; rank+budget alone never plan a paid_vendor step.
  if (
    Boolean(input.paidVendorConfigured) &&
    input.rankScore >= input.paidRankThreshold &&
    input.monthlyBudgetRemainingCents >= input.estimatedPaidLookupCents
  ) {
    steps.push("paid_vendor");
  }
  return steps;
}

export const DEFAULT_SIGNAL_RULES: SignalRuleConfig[] = [
  { type: "new_license", polarity: "positive", weight: 40, activeForDays: 90 },
  {
    type: "license_pending",
    polarity: "positive",
    weight: 35,
    activeForDays: 90,
  },
  {
    type: "ownership_change",
    polarity: "positive",
    weight: 35,
    activeForDays: 90,
  },
  { type: "new_location", polarity: "positive", weight: 30, activeForDays: 90 },
  {
    type: "pos_detected",
    polarity: "positive",
    weight: 25,
    activeForDays: 120,
  },
  {
    type: "product_signup",
    polarity: "positive",
    weight: 45,
    activeForDays: 60,
  },
  { type: "pricing_view", polarity: "positive", weight: 25, activeForDays: 30 },
  {
    // PILE-654 — a rep-collected volume estimate from /intake is the only
    // source of true merchant numbers, so it decays slowly.
    type: "revenue_estimate",
    polarity: "positive",
    weight: 40,
    activeForDays: 180,
    halfLifeDays: 90,
    label: "Reported card volume",
  },
  {
    type: "stalled_onboarding",
    polarity: "positive",
    weight: 35,
    activeForDays: 45,
  },
  {
    type: "negative_closure",
    polarity: "negative",
    weight: 80,
    activeForDays: 365,
  },
];

export const DEFAULT_ICP_RULES: IcpRule[] = [
  {
    id: "icp-vertical-non-pos-smb",
    motion: "smb_default",
    field: "vertical",
    op: "in",
    value: [
      "home improvement contractor",
      "general contractor",
      "electrical firm",
      "master plumber",
      "filing representative",
      "special inspection agency",
      "fire suppression contractor",
      "rigger",
      "oil burner installer",
      "license",
      "gc",
      "mp",
      "contractor",
      "hvac",
      "plumbing",
      "electrical",
      "auto_repair",
      "garage & parking lot",
      "secondhand dealer - auto",
      "tow truck company",
      "car wash",
      "electronic & home appliance service dealer",
      "dealer in products for the disabled",
      "employment agency",
      "self-storage facility",
      "secondhand dealer - general",
      "wholesale",
      "printing",
      "professional_services",
      "legal",
      "accounting",
      "medical",
      "dental",
      "veterinary",
      "med_spa",
      "moving",
      "cleaning",
      "b2b_services",
      "retail",
      "general & home improvement contractor",
      "electrical contractor",
      "plumbing, heating & fire",
      "architecture, engineering & expediting",
      "commercial hauling & demolition",
      "auto, garage & towing (20% explore)",
      "medical, dental & dme (20% explore)",
      "b2b & specialty smb (20% explore)",
      "bookkeeper / cpa partner",
      "vc / fund partner",
      "tech / ai / saas startup",
    ],
    weight: 25,
  },
  {
    // PILE-663 — storefront verticals are excluded by default, but
    // rankMerchantSignals lifts this penalty (and fires
    // `icp-storefront-with-volume`) when the merchant has proven revenue.
    id: "icp-vertical-pos-bound-restaurant-penalty",
    motion: "smb_default",
    field: "vertical",
    op: "in",
    value: [
      "restaurant",
      "bar",
      "cafe",
      "nightclub",
      "retail",
      "grocery",
      "salon",
      "bakery",
      "pizzeria",
      "deli",
      "restaurant / pos (excluded)",
      "restaurant (pos excluded)",
    ],
    weight: -40,
  },
  {
    // PILE-663 — a storefront merchant with proven card volume is a
    // card-present rate-competition target. `rankMerchantSignals` sets
    // merchantAttrs.storefrontWithVolume when volume/pain proof exists.
    id: "icp-storefront-with-volume",
    motion: "smb_default",
    field: "storefrontWithVolume",
    op: "eq",
    value: true,
    weight: 20,
  },
  {
    id: "icp-has-address",
    motion: "smb_default",
    field: "hasAddress",
    op: "eq",
    value: true,
    weight: 10,
  },
  {
    id: "icp-has-phone",
    motion: "smb_default",
    field: "hasPhone",
    op: "eq",
    value: true,
    weight: 10,
  },
  {
    // PILE-654 — ≥ $10k/mo reported card volume is a real merchant, not a
    // hobby stand; the figure comes from the intake monthly_card_volume_cents
    // custom field (merchantAttrs.estMonthlyVolumeCents).
    id: "icp-est-monthly-card-volume",
    motion: "smb_default",
    field: "estMonthlyVolumeCents",
    op: "gte",
    value: 1_000_000,
    weight: 15,
  },
];

export function parseCustomerSignalFacts(
  facts: ReadonlyArray<{ kind: string; fact: string }>
): MerchantSignal[] {
  const out: MerchantSignal[] = [];
  for (const row of facts) {
    if (!row.kind.startsWith("signal:")) continue;
    try {
      const parsed = JSON.parse(row.fact) as MerchantSignal;
      if (
        parsed &&
        typeof parsed.id === "string" &&
        typeof parsed.type === "string"
      ) {
        out.push(parsed);
      }
    } catch {
      // Ignore non-JSON signal facts
    }
  }
  return out;
}
