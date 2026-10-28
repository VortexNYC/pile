import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  findOrCreateCustomerByEmail,
  updateCustomer as updateSupportCustomer,
} from "../global/support-contacts.js";
import { runTriageRules } from "../global/triage-rules.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { normalizeDocumentSlug } from "../workspace/data/index.js";
import {
  DEFAULT_ICP_RULES,
  DEFAULT_SIGNAL_RULES,
  type MerchantAttrs,
  type MerchantRankBreakdown,
  type MerchantSignal,
  normalizePhoneE164,
  normalizeStreetAddress,
  parseCustomerSignalFacts,
  rankMerchantSignals,
} from "../workspace/signals-engine.js";
import { getWorkspaceStub } from "./stub.js";

// Field spec: the "Merchant Visit Intake Checklist" doc in the Sales space.
// Changes there change this app (PILE-326).

const contactSchema = z.object({
  name: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  bestTime: z.string().optional(),
});

const intakeBodySchema = z.object({
  intakeId: z.string().min(1).optional(),
  businessName: z.string().min(1),
  address: z.string().optional(),
  websiteUrl: z.string().url().optional(),
  visitedAt: z.string().optional(),
  spokeWith: z
    .object({
      name: z.string().optional(),
      role: z.string().optional(),
      isDecisionMaker: z.boolean().optional(),
    })
    .optional(),
  owner: contactSchema.optional(),
  meeting: z
    .object({
      booked: z.boolean(),
      at: z.string().optional(),
      returnAt: z.string().optional(),
      bookingUrl: z.string().url().optional(),
    })
    .optional(),
  discovery: z
    .object({
      businessType: z.string().optional(),
      billingSystems: z.array(z.string()).optional(),
      paymentMethods: z.array(z.string()).optional(),
      hardware: z.string().optional(),
      hardwareOwnership: z.string().optional(),
      signage: z.string().optional(),
      fitNotes: z.string().optional(),
    })
    .optional(),
  pricing: z
    .object({
      currentProcessor: z.string().optional(),
      posSystem: z.string().optional(),
      underContract: z.boolean().optional(),
      contractEnd: z.string().optional(),
      earlyTerminationFee: z.string().optional(),
      timeWithProvider: z.string().optional(),
      monthlyCardVolume: z.string().optional(),
      averageTicket: z.string().optional(),
      transactionsPerDay: z.string().optional(),
      cardMix: z.string().optional(),
      channelMix: z.string().optional(),
      seasonality: z.string().optional(),
      monthlySalesTotals: z.string().optional(),
    })
    .optional(),
  pain: z
    .object({
      biggestComplaint: z.string().optional(),
      switchedBefore: z.string().optional(),
      wishes: z.string().optional(),
    })
    .optional(),
  pipelineStatusId: z.string().optional(),
  nextStep: z.string().optional(),
  nextStepDate: z.string().optional(),
  repNotes: z.string().optional(),
  statementFiles: z
    .array(
      z.object({
        key: z.string().min(1),
        url: z.string().min(1),
        name: z.string().optional(),
      })
    )
    .optional(),
});

type IntakeBody = z.infer<typeof intakeBodySchema>;

const intakeResultSchema = z.object({
  customerId: z.string(),
  contactId: z.string().nullable(),
  documentId: z.string().nullable(),
  statusId: z.string().nullable(),
  bookingLinkId: z.string().nullable(),
  deduped: z.boolean(),
});

// PILE-655 — Vortex `/v1/operator/quote-requests`: merchants who ran the
// public pricing calculator leave self-reported volume figures plus
// contact info. Each quote request is an inbound lead.

const quoteRequestItemSchema = z.object({
  id: z.string().min(1),
  // Vortex has shipped all three spellings across versions of the
  // calculator payload — accept each and pick the first non-empty.
  businessName: z.string().nullable().optional(),
  merchantName: z.string().nullable().optional(),
  companyName: z.string().nullable().optional(),
  contactEmail: z.string().nullable().optional(),
  contactName: z.string().nullable().optional(),
  contactPhone: z.string().nullable().optional(),
  monthlyVolumeCents: z.number().nullable().optional(),
  avgTicketCents: z.number().nullable().optional(),
  currentProcessor: z.string().nullable().optional(),
  effectiveRateBps: z.number().nullable().optional(),
  estimatedAnnualSavingsCents: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
});

type QuoteRequestItem = z.infer<typeof quoteRequestItemSchema>;

const quoteRequestSyncBodySchema = z.object({
  quoteRequests: z.array(quoteRequestItemSchema).optional(),
  vortexOperatorKey: z.string().optional(),
});

const quoteRequestSyncResultSchema = z.object({
  synced: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  customers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      externalId: z.string().nullable(),
      estMonthlyVolumeCents: z.number().nullable(),
      score: z.number().nullable(),
    })
  ),
});

const VORTEX_QUOTE_SOURCE = "vortex_quote_calculator";

function line(label: string, value: string | undefined | null): string | null {
  return value ? `- **${label}:** ${value}` : null;
}

function list(label: string, values: string[] | undefined): string | null {
  return values && values.length
    ? `- **${label}:** ${values.join(", ")}`
    : null;
}

function bool(label: string, value: boolean | undefined): string | null {
  return value === undefined ? null : `- **${label}:** ${value ? "yes" : "no"}`;
}

/** PILE-654 — parse a freeform money answer ("$40k", "42,000", "3500.50")
 *  to integer cents. Returns null when the string isn't one clean amount
 *  ("40-50k seasonal", "depends") so the raw text is kept under the
 *  non-cents key instead of being silently dropped. */
export function parseMoneyToCents(raw: string | undefined): number | null {
  if (!raw) return null;
  const match = /^\$?\s*([\d,]+(?:\.\d{1,2})?)\s*k?$/i.exec(raw.trim());
  if (!match?.[1]) return null;
  const amount = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount < 0) return null;
  const dollars = /k$/i.test(raw.trim()) ? amount * 1000 : amount;
  return Math.round(dollars * 100);
}

/** PILE-654 — parse a clean transactions-per-day figure to a monthly
 *  count (per-day × 30, rounded). Anything messier stays raw. */
export function parseMonthlyTxCount(raw: string | undefined): number | null {
  if (!raw) return null;
  const match = /^([\d,]+(?:\.\d+)?)$/.exec(raw.trim());
  if (!match?.[1]) return null;
  const perDay = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(perDay) && perDay >= 0
    ? Math.round(perDay * 30)
    : null;
}

/** PILE-654 — freeform pricing answers → name-keyed customer custom
 *  fields. Parseable money lands as `*_cents`; a value that won't parse
 *  cleanly stays under its raw text key so nothing is lost. */
export function intakePricingCustomFields(
  input: IntakeBody
): Record<string, string> {
  const pricing = input.pricing;
  if (!pricing) return {};
  const fields: Record<string, string> = {};
  const putMoney = (keyCents: string, keyRaw: string, raw?: string) => {
    const cents = parseMoneyToCents(raw);
    if (cents !== null) fields[keyCents] = String(cents);
    else if (raw?.trim()) fields[keyRaw] = raw.trim();
  };
  putMoney(
    "monthly_card_volume_cents",
    "monthly_card_volume",
    pricing.monthlyCardVolume
  );
  putMoney("avg_ticket_cents", "average_ticket", pricing.averageTicket);
  putMoney("etf_cents", "etf", pricing.earlyTerminationFee);
  const monthlyTx = parseMonthlyTxCount(pricing.transactionsPerDay);
  if (monthlyTx !== null) fields.monthly_tx_count = String(monthlyTx);
  else if (pricing.transactionsPerDay?.trim()) {
    fields.transactions_per_day = pricing.transactionsPerDay.trim();
  }
  if (pricing.currentProcessor?.trim()) {
    fields.current_processor = pricing.currentProcessor.trim();
  }
  if (pricing.cardMix?.trim()) fields.card_mix = pricing.cardMix.trim();
  if (pricing.channelMix?.trim()) {
    fields.channel_mix = pricing.channelMix.trim();
  }
  if (pricing.contractEnd?.trim()) {
    fields.contract_end = pricing.contractEnd.trim();
  }
  if (pricing.monthlySalesTotals?.trim()) {
    fields.monthly_sales_totals = pricing.monthlySalesTotals.trim();
  }
  return fields;
}

/** PILE-655 — display name for a quote-request merchant: the business
 *  name under any of its payload spellings, then the contact person,
 *  then the email local part. */
export function quoteRequestName(item: QuoteRequestItem): string {
  const emailLocal = item.contactEmail?.trim().split("@")[0];
  const name =
    item.businessName?.trim() ||
    item.merchantName?.trim() ||
    item.companyName?.trim() ||
    item.contactName?.trim() ||
    emailLocal;
  return name || `Quote request ${item.id}`;
}

/** PILE-655 — quote-request pricing figures → name-keyed customer custom
 *  fields (camelCase keys, matching the Vortex payload spelling). The
 *  monthly volume also lands under the canonical `monthly_card_volume_cents`
 *  key from PILE-654 so re-ranks that read volume back off the field map
 *  (`estMonthlyVolumeCentsFromFields`) still fire the ICP volume rule.
 *  Numeric fields only land when finite so a garbage upstream value can't
 *  poison the field map. */
export function quoteRequestCustomFields(
  item: QuoteRequestItem
): Record<string, string> {
  const fields: Record<string, string> = {
    vortexQuoteRequestId: item.id,
    inboundSource: VORTEX_QUOTE_SOURCE,
  };
  const put = (key: string, value: number | null | undefined) => {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      fields[key] = String(Math.round(value));
    }
  };
  put("estMonthlyVolumeCents", item.monthlyVolumeCents);
  put("monthly_card_volume_cents", item.monthlyVolumeCents);
  put("averageTicketCents", item.avgTicketCents);
  put("effectiveRateBps", item.effectiveRateBps);
  put("estimatedAnnualSavingsCents", item.estimatedAnnualSavingsCents);
  if (item.currentProcessor?.trim()) {
    fields.currentProcessor = item.currentProcessor.trim();
  }
  return fields;
}

/** PILE-655 — the quote-request volume figure as a rankable cents value,
 *  or null when the calculator row didn't report one. */
function quoteRequestVolumeCents(item: QuoteRequestItem): number | null {
  const raw = item.monthlyVolumeCents;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? Math.round(raw)
    : null;
}

// ---- PILE-656: Vortex merchant-statement join + statement OCR ----
//
// Vortex's merchant_statements + analyzeStatement produce *measured*
// card volume, fees, and effective rate for merchants already processing
// through Vortex. The sync joins those first-party TPV figures back onto
// the matching Pile customer so ranking reads real numbers, not
// rep-reported estimates. The matching ladder mirrors the quote-request
// sync (PILE-655): explicit id → durable join key → contact email → name.

const vortexMerchantItemSchema = z.object({
  externalMerchantRef: z.string().min(1),
  customerId: z.string().nullable().optional(),
  businessName: z.string().nullable().optional(),
  contactEmail: z.string().nullable().optional(),
  monthlyVolumeCents: z.number(),
  totalFeesCents: z.number().nullable().optional(),
  effectiveRateBps: z.number().nullable().optional(),
  transactionCount: z.number().nullable().optional(),
  avgTicketCents: z.number().nullable().optional(),
  statementPeriod: z.string().nullable().optional(),
  processor: z.string().nullable().optional(),
});

type VortexMerchantItem = z.infer<typeof vortexMerchantItemSchema>;

const vortexMerchantSyncBodySchema = z.object({
  merchants: z.array(vortexMerchantItemSchema).optional(),
  vortexOperatorKey: z.string().optional(),
});

const vortexMerchantSyncResultSchema = z.object({
  synced: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  customers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      externalMerchantRef: z.string(),
      measuredMonthlyVolumeCents: z.number().nullable(),
      effectiveRateBps: z.number().nullable(),
      score: z.number().nullable(),
    })
  ),
});

const VORTEX_MERCHANT_SOURCE = "vortex_merchant_statement";
const FIRST_PARTY_TPV_SOURCE = "vortex_first_party_tpv";
const STATEMENT_OCR_SOURCE = "statement_ocr";
const SBA_LOAN_SOURCE = "sba_ppp";

const STATEMENT_VISION_MODEL =
  "@cf/meta/llama-3.2-11b-vision-instruct" as const;
const STATEMENT_VISION_PROMPT = [
  "You are reading a merchant card-processing statement.",
  "Extract the statement's processing figures and reply with ONLY a JSON",
  "object, no prose:",
  '{"monthly_volume_cents": <int>, "total_fees_cents": <int>,',
  '"effective_rate_bps": <int>, "processor": "<name>"}.',
  "Use null for any figure you cannot read. The month's total/gross card",
  "volume is the monthly volume.",
].join(" ");

// ---- PILE-659: SBA PPP/7(a) loan import ----
//
// Free payroll-derived revenue proxy. PPP loans were sized at 2.5x
// monthly payroll, so the public loan file leaks a payroll figure; a
// payroll→revenue ratio turns that into a monthly-volume estimate for
// storefronts that never ran the calculator. 7(a) loans aren't
// payroll-sized, so they carry the amount but no derived volume.

const PPP_LOAN_TO_PAYROLL_MONTHS = 2.5;
const DEFAULT_PAYROLL_TO_REVENUE_RATIO = 0.3;

const pppLoanItemSchema = z.object({
  loanId: z.string().nullable().optional(),
  businessName: z.string().min(1),
  address: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  zip: z.string().nullable().optional(),
  loanAmountDollars: z.number().nullable().optional(),
  loanAmountCents: z.number().nullable().optional(),
  jobsReported: z.number().nullable().optional(),
  naicsCode: z.string().nullable().optional(),
  approvalDate: z.string().nullable().optional(),
  loanType: z.enum(["ppp", "7a"]).optional(),
});

type PppLoanItem = z.infer<typeof pppLoanItemSchema>;

const pppLoanImportBodySchema = z.object({
  loans: z.array(pppLoanItemSchema),
  payrollToRevenueRatio: z.number().positive().max(1).optional(),
});

const pppLoanImportResultSchema = z.object({
  imported: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  customers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      loanAmountCents: z.number().nullable(),
      estMonthlyPayrollCents: z.number().nullable(),
      estMonthlyVolumeCents: z.number().nullable(),
      jobsReported: z.number().nullable(),
      score: z.number().nullable(),
    })
  ),
});

const statementTranscribeBodySchema = z.object({
  attachmentKey: z.string().optional(),
  imageBase64: z.string().optional(),
  extractedText: z.string().optional(),
  monthlyVolumeCents: z.number().optional(),
  totalFeesCents: z.number().optional(),
  effectiveRateBps: z.number().optional(),
  avgTicketCents: z.number().optional(),
  processor: z.string().optional(),
  statementPeriod: z.string().optional(),
});

const statementTranscribeResultSchema = z.object({
  customerId: z.string(),
  metrics: z.object({
    monthlyVolumeCents: z.number().nullable(),
    totalFeesCents: z.number().nullable(),
    effectiveRateBps: z.number().nullable(),
    processor: z.string().nullable(),
  }),
  score: z.number().nullable(),
});

type WorkspaceStub = ReturnType<typeof getWorkspaceStub>;

/** The customer attributes the ranker reads — every stub customer
 *  variant satisfies this shape. */
interface RankableCustomer {
  id: string;
  vertical?: string | null;
  address?: string | null;
  phone?: string | null;
}

/** Finite non-negative number → rounded integer, else null — the shared
 *  cents guard for upstream-supplied figures. */
function finiteMetric(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function envString(env: unknown, key: string): string | undefined {
  const value = (env as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Cents → "$48,231" display text for signal summaries. */
function centsToDollarText(cents: number): string {
  const dollars = cents / 100;
  return dollars >= 1000
    ? `$${Math.round(dollars).toLocaleString("en-US")}`
    : `$${dollars.toFixed(2)}`;
}

/** Basis points → a compact percent label ("2.91%"). */
function bpsToPercentText(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** Deterministic, id-safe fragment for signal ids. */
function signalIdPart(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** Shared signal-persist + re-rank tail used by every intake surface that
 *  lands a revenue figure (visit intake, quote requests, merchant
 *  statements, statement OCR, SBA loans). memoryRemember upserts on the
 *  deterministic signal id — a re-run supersedes instead of stacking —
 *  then the ranker recomputes from the merchant's whole signal set and
 *  the scores land back on the customer row for the list sort. */
async function persistSignalAndRank(opts: {
  stub: WorkspaceStub;
  customer: RankableCustomer;
  signal: MerchantSignal;
  estMonthlyVolumeCents?: number | null;
  actorId: string;
  extraAttrs?: MerchantAttrs;
}): Promise<MerchantRankBreakdown> {
  const { stub, customer, signal, actorId } = opts;
  await stub.memoryRemember({
    entityType: "customer",
    entityId: customer.id,
    kind: `signal:${signal.type}:${signal.id}`,
    fact: JSON.stringify(signal),
  });
  const signals = parseCustomerSignalFacts(
    await stub.memoryRecall({
      entityType: "customer",
      entityId: customer.id,
      limit: 100,
    })
  );
  const breakdown = rankMerchantSignals({
    merchantId: customer.id,
    merchantAttrs: {
      vertical: (customer.vertical ?? "").toLowerCase(),
      hasAddress: Boolean(customer.address),
      hasPhone: Boolean(customer.phone),
      ...(opts.estMonthlyVolumeCents != null
        ? { estMonthlyVolumeCents: opts.estMonthlyVolumeCents }
        : {}),
      ...opts.extraAttrs,
    },
    signals,
    config: {
      motion: "smb_default",
      icpRules: DEFAULT_ICP_RULES,
      signalRules: DEFAULT_SIGNAL_RULES,
    },
  });
  await stub.updateCustomer(
    customer.id,
    {
      priorityScore: breakdown.priorityScore,
      fitScore: breakdown.fitScore,
      fitStatus: breakdown.fitRating,
      customFields: {
        whyNow: breakdown.whyNow,
        whyNowSignalIds: breakdown.whyNowSignalIds.join(","),
      },
    },
    actorId
  );
  return breakdown;
}

/** PILE-656 — measured statement figures → name-keyed customer custom
 *  fields. The measured volume also lands under the canonical
 *  `monthly_card_volume_cents` key (PILE-654) so re-ranks that read
 *  volume back off the field map fire the ICP volume rule, and under
 *  `estMonthlyVolumeCents` matching the quote-request spelling. */
export function vortexMerchantCustomFields(
  item: VortexMerchantItem
): Record<string, string> {
  const fields: Record<string, string> = {
    externalMerchantRef: item.externalMerchantRef,
    volumeSource: FIRST_PARTY_TPV_SOURCE,
  };
  const put = (key: string, value: number | null | undefined) => {
    const metric = finiteMetric(value);
    if (metric !== null) fields[key] = String(metric);
  };
  const volumeCents = finiteMetric(item.monthlyVolumeCents);
  if (volumeCents !== null) {
    fields.measuredMonthlyVolumeCents = String(volumeCents);
    fields.estMonthlyVolumeCents = String(volumeCents);
    fields.monthly_card_volume_cents = String(volumeCents);
  }
  put("totalFeesCents", item.totalFeesCents);
  put("effectiveRateBps", item.effectiveRateBps);
  put("averageTicketCents", item.avgTicketCents);
  put("transactionCount", item.transactionCount);
  if (item.statementPeriod?.trim()) {
    fields.statementPeriod = item.statementPeriod.trim();
  }
  return fields;
}

export interface StatementMetrics {
  monthlyVolumeCents: number | null;
  totalFeesCents: number | null;
  effectiveRateBps: number | null;
  processor: string | null;
}

// Volume labels in priority order — "Total Volume" is the headline
// figure on processor statements; gross/total sales are the fallbacks.
const STATEMENT_VOLUME_RES = [
  /total\s+(?:card\s+)?volume\b[^\d\n]{0,30}([\d,]+(?:\.\d{1,2})?)/i,
  /monthly\s+(?:card\s+)?volume\b[^\d\n]{0,30}([\d,]+(?:\.\d{1,2})?)/i,
  /gross\s+(?:card\s+)?(?:sales|volume)\b[^\d\n]{0,30}([\d,]+(?:\.\d{1,2})?)/i,
  /total\s+(?:card\s+)?sales\b[^\d\n]{0,30}([\d,]+(?:\.\d{1,2})?)/i,
];
const STATEMENT_FEES_RE = /total\s+fees\b[^\d\n]{0,30}([\d,]+(?:\.\d{1,2})?)/i;
const STATEMENT_RATE_RE =
  /effective\s+rate\b[^\d\n]{0,30}([\d]+(?:\.\d+)?)\s*%?/i;

const STATEMENT_PROCESSORS: Array<{ re: RegExp; name: string }> = [
  { re: /\bsquare\b/i, name: "Square" },
  { re: /\bclover\b/i, name: "Clover" },
  { re: /\btoast\b/i, name: "Toast" },
  { re: /\bstripe\b/i, name: "Stripe" },
  { re: /\bfiserv\b|\bfirst\s*data\b/i, name: "Fiserv" },
  { re: /\bworldpay\b/i, name: "Worldpay" },
  { re: /\bglobal\s*payments\b/i, name: "Global Payments" },
  { re: /\btsys\b/i, name: "TSYS" },
  { re: /\bshift4\b/i, name: "Shift4" },
  { re: /\bheartland\b/i, name: "Heartland" },
  { re: /\blightspeed\b/i, name: "Lightspeed" },
  { re: /\badyen\b/i, name: "Adyen" },
  { re: /\bpaypal\b|\bbraintree\b/i, name: "PayPal" },
  { re: /\belavon\b/i, name: "Elavon" },
  {
    re: /\bchase\s*(?:paymentech|merchant\s*services)\b/i,
    name: "Chase Paymentech",
  },
  { re: /\bhelcim\b/i, name: "Helcim" },
  { re: /\bstax\b/i, name: "Stax" },
  { re: /\bauthorize\.?net\b/i, name: "Authorize.net" },
];

/** PILE-656 — pull the labelled processing figures out of statement text
 *  (OCR output, pasted statements, or a vision model's prose reply).
 *  Returns nulls per-field so a partial read still lands. */
export function parseStatementMetricsFromText(text: string): StatementMetrics {
  const money = (re: RegExp): number | null => {
    const match = re.exec(text);
    if (!match?.[1]) return null;
    const amount = Number(match[1].replace(/,/g, ""));
    return Number.isFinite(amount) && amount >= 0
      ? Math.round(amount * 100)
      : null;
  };
  let monthlyVolumeCents: number | null = null;
  for (const re of STATEMENT_VOLUME_RES) {
    monthlyVolumeCents = money(re);
    if (monthlyVolumeCents !== null) break;
  }
  const rateMatch = STATEMENT_RATE_RE.exec(text);
  const rateValue = rateMatch?.[1] ? Number(rateMatch[1]) : Number.NaN;
  const processor =
    STATEMENT_PROCESSORS.find((p) => p.re.test(text))?.name ?? null;
  return {
    monthlyVolumeCents,
    totalFeesCents: money(STATEMENT_FEES_RE),
    effectiveRateBps:
      Number.isFinite(rateValue) && rateValue >= 0
        ? Math.round(rateValue * 100)
        : null,
    processor,
  };
}

/** PILE-656 — the vision model is prompted for JSON but may wrap it in
 *  prose; pull the first {...} block and normalize the loose key
 *  spellings (snake/camel, cents vs dollars, bps vs percent). Returns
 *  null when no JSON object or no usable figure is present so the caller
 *  can fall back to the regex text parse. */
function parseStatementMetricsFromJson(text: string): StatementMetrics | null {
  const block = /\{[\s\S]*\}/.exec(text);
  if (!block) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  const num = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = rec[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return value;
      }
      if (typeof value === "string") {
        const n = Number(value.replace(/[$,\s]/g, ""));
        if (Number.isFinite(n) && n >= 0) return n;
      }
    }
    return null;
  };
  const whole = (...keys: string[]) => {
    const n = num(...keys);
    return n === null ? null : Math.round(n);
  };
  const dollars = (...keys: string[]) => {
    const n = num(...keys);
    return n === null ? null : Math.round(n * 100);
  };
  const ratePct = num(
    "effectiveRatePercent",
    "effective_rate_percent",
    "effective_rate_pct",
    "effectiveRate"
  );
  const processorRaw = rec.processor ?? rec.processor_name ?? rec.processorName;
  const metrics: StatementMetrics = {
    monthlyVolumeCents:
      whole(
        "monthlyVolumeCents",
        "monthly_volume_cents",
        "volumeCents",
        "volume_cents"
      ) ??
      dollars(
        "monthlyVolumeDollars",
        "monthly_volume_dollars",
        "totalVolumeDollars",
        "total_volume_dollars"
      ),
    totalFeesCents:
      whole("totalFeesCents", "total_fees_cents", "feesCents", "fees_cents") ??
      dollars(
        "totalFeesDollars",
        "total_fees_dollars",
        "feesDollars",
        "fees_dollars"
      ),
    effectiveRateBps:
      whole("effectiveRateBps", "effective_rate_bps") ??
      (ratePct === null ? null : Math.round(ratePct * 100)),
    processor:
      typeof processorRaw === "string" && processorRaw.trim()
        ? processorRaw.trim()
        : null,
  };
  return Object.values(metrics).some((v) => v !== null) ? metrics : null;
}

/** Fill only the still-empty slots — explicitly supplied figures always
 *  beat extracted ones. */
function mergeStatementMetrics(
  target: StatementMetrics,
  parsed: StatementMetrics
) {
  if (target.monthlyVolumeCents === null) {
    target.monthlyVolumeCents = parsed.monthlyVolumeCents;
  }
  if (target.totalFeesCents === null) {
    target.totalFeesCents = parsed.totalFeesCents;
  }
  if (target.effectiveRateBps === null) {
    target.effectiveRateBps = parsed.effectiveRateBps;
  }
  if (target.processor === null) target.processor = parsed.processor;
}

/** PILE-659 — the loan amount in integer cents, from whichever spelling
 *  the import row carried. */
function pppLoanAmountCents(item: PppLoanItem): number | null {
  const cents = finiteMetric(item.loanAmountCents);
  if (cents !== null) return cents;
  const dollars = item.loanAmountDollars;
  return typeof dollars === "number" && Number.isFinite(dollars) && dollars >= 0
    ? Math.round(dollars * 100)
    : null;
}

/** PILE-659 — PPP loan → monthly payroll (÷2.5) → monthly revenue
 *  (÷payroll share of revenue). 7(a) loans aren't payroll-sized so they
 *  return nulls — the loan amount itself still lands on the record. */
export function pppLoanEstimates(input: {
  loanAmountCents: number | null;
  loanType?: "ppp" | "7a" | null;
  payrollToRevenueRatio?: number;
}): {
  estMonthlyPayrollCents: number | null;
  estMonthlyVolumeCents: number | null;
} {
  const loanAmountCents = finiteMetric(input.loanAmountCents);
  if (loanAmountCents === null || input.loanType === "7a") {
    return { estMonthlyPayrollCents: null, estMonthlyVolumeCents: null };
  }
  const ratio = input.payrollToRevenueRatio ?? DEFAULT_PAYROLL_TO_REVENUE_RATIO;
  const estMonthlyPayrollCents = Math.round(
    loanAmountCents / PPP_LOAN_TO_PAYROLL_MONTHS
  );
  return {
    estMonthlyPayrollCents,
    estMonthlyVolumeCents: Math.round(estMonthlyPayrollCents / ratio),
  };
}

/** PILE-659 — loan facts → name-keyed customer custom fields. The
 *  derived monthly volume lands under the canonical
 *  `monthly_card_volume_cents` key so the ICP volume rule fires. */
export function pppLoanCustomFields(
  item: PppLoanItem,
  payrollToRevenueRatio: number
): Record<string, string> {
  const fields: Record<string, string> = { inboundSource: SBA_LOAN_SOURCE };
  const loanAmountCents = pppLoanAmountCents(item);
  if (loanAmountCents !== null) {
    fields.pppLoanAmountCents = String(loanAmountCents);
  }
  const { estMonthlyPayrollCents, estMonthlyVolumeCents } = pppLoanEstimates({
    loanAmountCents,
    loanType: item.loanType,
    payrollToRevenueRatio,
  });
  if (estMonthlyPayrollCents !== null) {
    fields.estMonthlyPayrollCents = String(estMonthlyPayrollCents);
  }
  if (estMonthlyVolumeCents !== null) {
    fields.estMonthlyVolumeCents = String(estMonthlyVolumeCents);
    fields.monthly_card_volume_cents = String(estMonthlyVolumeCents);
  }
  const jobs = finiteMetric(item.jobsReported);
  if (jobs !== null) fields.jobsReported = String(jobs);
  if (item.naicsCode?.trim()) fields.naicsCode = item.naicsCode.trim();
  if (item.loanId?.trim()) fields.sbaLoanId = item.loanId.trim();
  if (item.loanType) fields.sbaLoanType = item.loanType;
  if (item.approvalDate?.trim()) {
    fields.loanApprovalDate = item.approvalDate.trim();
  }
  return fields;
}

export function buildIntakeMarkdown(input: IntakeBody): string {
  const lines: (string | null)[] = [
    `# ${input.businessName} — visit intake`,
    "",
    "## Visit",
    line("Visited at", input.visitedAt),
    line("Address", input.address),
    line("Website", input.websiteUrl),
    line(
      "Spoke with",
      input.spokeWith?.name
        ? `${input.spokeWith.name}${input.spokeWith.role ? ` (${input.spokeWith.role})` : ""}${
            input.spokeWith.isDecisionMaker ? " — decision maker" : ""
          }`
        : undefined
    ),
    "",
    "## Owner contact",
    line("Name", input.owner?.name),
    line("Phone", input.owner?.phone),
    line("Email", input.owner?.email),
    line("Best time to reach", input.owner?.bestTime),
    "",
    "## Meeting",
    bool("Booked", input.meeting?.booked),
    line("When", input.meeting?.at),
    line("Return by", input.meeting?.returnAt),
    line("Booking link", input.meeting?.bookingUrl),
    "",
    "## Discovery",
    line("Business type", input.discovery?.businessType),
    list("Billing systems", input.discovery?.billingSystems),
    list("Payment methods", input.discovery?.paymentMethods),
    line(
      "Hardware",
      input.discovery?.hardware
        ? `${input.discovery.hardware}${
            input.discovery.hardwareOwnership
              ? ` (${input.discovery.hardwareOwnership})`
              : ""
          }`
        : input.discovery?.hardwareOwnership
    ),
    line("Fee signage", input.discovery?.signage),
    line("Fit notes", input.discovery?.fitNotes),
    "",
    "## Pricing",
    line("Current processor", input.pricing?.currentProcessor),
    line("POS / terminal", input.pricing?.posSystem),
    bool("Under contract", input.pricing?.underContract),
    line("Contract end", input.pricing?.contractEnd),
    line("Early termination fee", input.pricing?.earlyTerminationFee),
    line("Time with provider", input.pricing?.timeWithProvider),
    line("Monthly card volume", input.pricing?.monthlyCardVolume),
    line("Average ticket", input.pricing?.averageTicket),
    line("Transactions per day", input.pricing?.transactionsPerDay),
    line("Card mix", input.pricing?.cardMix),
    line("Channel mix", input.pricing?.channelMix),
    line("Seasonality", input.pricing?.seasonality),
    line(
      "Monthly sales totals (no statement)",
      input.pricing?.monthlySalesTotals
    ),
    "",
    "## Statements",
    ...(input.statementFiles?.length
      ? input.statementFiles.map(
          (f) =>
            `- [${f.name ?? f.key.split("/").pop() ?? "statement"}](${f.url})`
        )
      : ["- none captured"]),
    "",
    "## Pain",
    line("Biggest complaint", input.pain?.biggestComplaint),
    line("Switched before", input.pain?.switchedBefore),
    line("Wishes", input.pain?.wishes),
    "",
    "## Wrap",
    line(
      "Next step",
      input.nextStep
        ? `${input.nextStep}${input.nextStepDate ? ` — ${input.nextStepDate}` : ""}`
        : input.nextStepDate
    ),
    line("Rep notes", input.repNotes),
    line("Intake ref", input.intakeId),
    "",
  ];
  return lines.filter((l): l is string => l !== null).join("\n");
}

const intakeRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/intake",
  tags: ["customers"],
  middleware: [rls("settings:create")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: { "application/json": { schema: intakeBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Intake already recorded (idempotent retry)",
      content: { "application/json": { schema: intakeResultSchema } },
    },
    201: {
      description: "Intake recorded",
      content: { "application/json": { schema: intakeResultSchema } },
    },
    400: { description: "Invalid request" },
  },
});

const quoteRequestSyncRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/intake/quote-requests/sync",
  tags: ["customers"],
  middleware: [rls("settings:create")],
  description:
    'Import Vortex pricing-calculator quote requests (/v1/operator/quote-requests) as inbound leads. Each row upserts a customer keyed on externalId "vortex-quote:<id>", writes the self-reported volume figures to customFields, upserts the contact, opens a lead-stage deal unless the merchant is already in the pipeline, and records a revenue_estimate signal. Pass quoteRequests inline or an operator key to pull from the Vortex API.',
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: { "application/json": { schema: quoteRequestSyncBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Quote requests synced",
      content: {
        "application/json": { schema: quoteRequestSyncResultSchema },
      },
    },
    400: { description: "Invalid request" },
    502: { description: "Vortex API fetch failed" },
  },
});

const vortexMerchantSyncRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/intake/vortex-merchants/sync",
  tags: ["customers"],
  middleware: [rls("settings:create")],
  description:
    'Join Vortex merchant-statement analysis (measured card volume, fees, effective rate — first-party TPV) onto Pile customers. Matches on explicit customerId, customFields.externalMerchantRef, externalId "vortex-merchant:<ref>", contact email, or case-insensitive business name; creates a customer when nothing matches. Writes the measured figures to customFields (incl. the canonical monthly_card_volume_cents), stamps the join key on the merchant\'s intake document when one exists, records a high-confidence revenue_estimate signal, and re-ranks. Pass merchants inline or an operator key to pull /v1/operator/merchant-statements.',
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: vortexMerchantSyncBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Vortex merchants synced",
      content: {
        "application/json": { schema: vortexMerchantSyncResultSchema },
      },
    },
    400: { description: "Invalid request" },
    502: { description: "Vortex API fetch failed" },
  },
});

const statementTranscribeRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/intake/{customerId}/transcribe-statement",
  tags: ["customers"],
  middleware: [rls("settings:create")],
  description:
    "Read processing figures off a merchant statement. Explicit figures win; otherwise extractedText is regex-parsed, or imageBase64/an R2 attachmentKey goes through Workers AI vision (when bound). Writes estMonthlyVolumeCents/monthly_card_volume_cents/totalFeesCents/effectiveRateBps to customFields, records a statement_ocr revenue_estimate signal, and re-ranks the merchant.",
  request: {
    params: z.object({
      organizationId: z.string(),
      customerId: z.string(),
    }),
    body: {
      content: {
        "application/json": { schema: statementTranscribeBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Statement transcribed",
      content: {
        "application/json": { schema: statementTranscribeResultSchema },
      },
    },
    400: { description: "Invalid request" },
    404: { description: "Customer not found" },
  },
});

const pppLoanImportRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/intake/ppp-loans/import",
  tags: ["customers"],
  middleware: [rls("settings:create")],
  description:
    'Import SBA PPP/7(a) loan rows as a free payroll-derived revenue proxy: PPP loans were sized at 2.5x monthly payroll, and payrollToRevenueRatio (default 0.30) turns that into an estimated monthly volume. Matches existing customers on externalId "sba-ppp:<loanId>" or case-insensitive business name + street address; writes loan facts and the derived figures to customFields, records a sba_ppp revenue_estimate signal, and re-ranks.',
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: pppLoanImportBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "SBA loans imported",
      content: {
        "application/json": { schema: pppLoanImportResultSchema },
      },
    },
    400: { description: "Invalid request" },
  },
});

export function registerIntakeRoutes(app: OpenAPIHono<AppContext>) {
  app.get("/intake", (c) => c.html(INTAKE_PAGE));

  app.openapi(intakeRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const db = createD1(c.env.D1);
    const intakeId = input.intakeId ?? crypto.randomUUID();

    if (input.pipelineStatusId) {
      const status = await stub.getCustomerStatus(input.pipelineStatusId);
      if (!status) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "Unknown pipeline status",
        });
      }
    }

    // Statement files must point at this workspace's uploads — the /files read
    // route enforces the same prefix, so anything else is a dead link anyway.
    for (const file of input.statementFiles ?? []) {
      if (!file.key.startsWith(`${organizationId}/files/`)) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "Statement file does not belong to this workspace",
        });
      }
    }

    // Customer — idempotent on intakeId so a retried submit after a mid-flow
    // failure (flaky cell connection) does not create a second merchant.
    let deduped = false;
    let customer = input.intakeId
      ? await stub.getCustomerByExternalId(input.intakeId)
      : undefined;
    if (customer) {
      deduped = true;
      if (
        input.pipelineStatusId &&
        customer.statusId !== input.pipelineStatusId
      ) {
        customer =
          (await stub.updateCustomer(
            customer.id,
            { statusId: input.pipelineStatusId },
            identity.id
          )) ?? customer;
      }
    } else {
      customer = await stub.createCustomer({
        name: input.businessName,
        url: input.websiteUrl ?? null,
        externalId: intakeId,
        statusId: input.pipelineStatusId ?? null,
      });
      // PILE-427 — a newly created customer record is inbound to the
      // pipeline: triage rules may delegate it (Scout/Profiler) or move
      // its status. Deduped retries skip evaluation. Re-read the customer
      // after a match so the reported statusId reflects the rule.
      const triage = await runTriageRules(c.env, db, organizationId, {
        recordType: "customer",
        recordId: customer.id,
        title: `Customer: ${customer.name}`,
        text: [
          input.businessName,
          input.address,
          input.websiteUrl,
          input.discovery?.fitNotes,
          input.repNotes,
        ]
          .filter((part): part is string => Boolean(part))
          .join("\n"),
        source: "intake",
        customerId: customer.id,
        fields: {
          name: customer.name,
          url: customer.url ?? null,
          externalId: intakeId,
          statusId: customer.statusId ?? null,
          domain: customer.domain ?? null,
        },
      });
      if (triage?.outcome === "matched") {
        customer = (await stub.getCustomer(customer.id)) ?? customer;
      }
    }

    // PILE-654 — promote the pricing answers to structured custom fields
    // on the customer row so ranking and agent queries can read the
    // merchant's real numbers, not just the markdown doc. Best-effort:
    // the intake document below is the durable record, so a colliding
    // typed field definition must never block a rep mid-submit.
    const pricingFields = intakePricingCustomFields(input);
    if (Object.keys(pricingFields).length > 0) {
      try {
        customer =
          (await stub.updateCustomer(
            customer.id,
            { customFields: pricingFields },
            identity.id
          )) ?? customer;
      } catch {
        // Field write refused (e.g. a workspace-typed definition
        // collision) — the raw answers remain in the intake document.
      }
    }

    // Owner contact — support contacts key on email, so a phone-only owner is
    // recorded in the intake document instead of minting a fake address.
    let contactId: string | null = null;
    if (input.owner?.email) {
      const contact = await findOrCreateCustomerByEmail(
        db,
        organizationId,
        input.owner.email,
        input.owner.name ?? null,
        "intake"
      );
      if (
        (input.owner.phone && !contact.phone) ||
        (input.owner.name && !contact.fullName)
      ) {
        await updateSupportCustomer(db, organizationId, contact.id, {
          phone: input.owner.phone,
          fullName: input.owner.name,
        });
      }
      contactId = contact.id;
    }

    // Cal.com booking link on the customer record — dedupe by URL so retries
    // don't stack identical links.
    let bookingLinkId: string | null = null;
    if (input.meeting?.bookingUrl) {
      const existing = await stub.listExternalLinks({
        entityType: "customer",
        entityId: customer.id,
      });
      const found = existing.find(
        (link) => link.url === input.meeting?.bookingUrl
      );
      bookingLinkId = found
        ? found.id
        : ((
            await stub.createExternalLink(
              {
                entityType: "customer",
                entityId: customer.id,
                url: input.meeting.bookingUrl,
                label: "Cal.com booking",
              },
              identity.id
            )
          )?.id ?? null);
    }

    // Intake document — slug makes the retry dedupe check cheap.
    const slug = `intake-${intakeId}`;
    let documentId: string | null = null;
    const existingDoc = (await stub.listDocuments({ slug }))[0];
    if (existingDoc) {
      documentId = existingDoc.id;
    } else {
      const doc = await stub.createDocument({
        title: `${input.businessName} — visit intake`,
        icon: "📋",
        content: buildIntakeMarkdown(input),
        contentFormat: "markdown",
        slug,
        createdById: identity.id,
      });
      documentId = doc.id;
    }

    // PILE-654 — a reported monthly card volume is a rankable revenue
    // signal, not just a field. Deterministic signal id keyed on intakeId
    // keeps a retried submit an upsert (same memory kind supersedes, no
    // stacked duplicate signals). Rank right away and persist the scores
    // so the customer list's priorityScore sort reflects the figure.
    const estVolumeCents = parseMoneyToCents(input.pricing?.monthlyCardVolume);
    if (estVolumeCents !== null) {
      try {
        const signal: MerchantSignal = {
          id: `sig_intake_${intakeId}`,
          merchantId: customer.id,
          type: "revenue_estimate",
          observedAt: new Date().toISOString(),
          source: "intake",
          evidenceUrl:
            input.statementFiles?.[0]?.url ??
            (documentId
              ? `/workspaces/${organizationId}/documents/${documentId}`
              : `intake:${intakeId}`),
          strength: 90,
          summary: `Reported monthly card volume ≈ ${centsToDollarText(estVolumeCents)}/mo (intake)`,
        };
        await persistSignalAndRank({
          stub,
          customer,
          signal,
          estMonthlyVolumeCents: estVolumeCents,
          actorId: identity.id,
        });
      } catch {
        // Signal + rank persistence is best-effort — a door-knock submit
        // still lands customer, fields, and the intake document.
      }
    }

    const result = {
      customerId: customer.id,
      contactId,
      documentId,
      statusId: input.pipelineStatusId ?? customer.statusId ?? null,
      bookingLinkId,
      deduped,
    };
    return deduped ? c.json(result, 200) : c.json(result, 201);
  });

  // PILE-655 — Vortex quote-request sync. Items arrive inline or are
  // pulled from the operator API; each is an inbound lead carrying the
  // merchant's own volume figures.
  app.openapi(quoteRequestSyncRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const base = (
      envString(c.env, "VORTEX_API_URL") ?? "https://api.vortex.nyc"
    ).replace(/\/+$/, "");

    let items: QuoteRequestItem[] | undefined = body.quoteRequests;
    if (items === undefined) {
      const operatorKey =
        body.vortexOperatorKey ?? envString(c.env, "VORTEX_OPERATOR_API_KEY");
      if (!operatorKey) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message:
            "Provide quoteRequests inline or a Vortex operator API key (vortexOperatorKey / VORTEX_OPERATOR_API_KEY)",
        });
      }
      const res = await fetch(`${base}/v1/operator/quote-requests`, {
        headers: { Authorization: `Bearer ${operatorKey}` },
      });
      if (!res.ok) {
        throw new VortexError({
          code: "AGENT_ERROR",
          status: 502,
          message: `Vortex quote-requests fetch failed (HTTP ${res.status})`,
        });
      }
      const payload = (await res.json()) as unknown;
      const rawItems: unknown[] = Array.isArray(payload)
        ? payload
        : Array.isArray((payload as { quoteRequests?: unknown })?.quoteRequests)
          ? ((payload as { quoteRequests: unknown[] }).quoteRequests ?? [])
          : Array.isArray((payload as { items?: unknown })?.items)
            ? ((payload as { items: unknown[] }).items ?? [])
            : [];
      // Rows that fail the item shape (e.g. no id) are skipped rather than
      // sinking the whole batch — the upstream payload is not ours to fix.
      items = rawItems
        .map((row) => quoteRequestItemSchema.safeParse(row))
        .filter((r) => r.success)
        .map((r) => r.data);
    }

    // Match indexes over the existing customer book — externalId is the
    // hard key; normalized email/business-name catch merchants who came
    // in through another import before their first quote request.
    const existing = await stub.listCustomers();
    type CustomerRow = (typeof existing)[number];
    const byExternalId = new Map<string, CustomerRow>();
    const byName = new Map<string, CustomerRow>();
    for (const row of existing) {
      if (row.externalId) byExternalId.set(row.externalId, row);
      const nameKey = row.name.trim().toLowerCase();
      if (nameKey && !byName.has(nameKey)) byName.set(nameKey, row);
    }
    // Email match needs each merchant's contacts — built lazily on the
    // first email-only lookup so a fully keyed batch never pays for it.
    const byEmail = new Map<string, CustomerRow>();
    let emailIndexBuilt = false;
    const emailIndex = async () => {
      if (emailIndexBuilt) return byEmail;
      emailIndexBuilt = true;
      await Promise.all(
        existing.map(async (cust) => {
          for (const contact of await stub.listContacts(cust.id)) {
            if (contact.channel !== "email") continue;
            const key = contact.value.trim().toLowerCase();
            if (key && !byEmail.has(key)) byEmail.set(key, cust);
          }
        })
      );
      return byEmail;
    };

    const deals = await stub.listDeals();
    let created = 0;
    let updated = 0;
    const synced: z.infer<typeof quoteRequestSyncResultSchema>["customers"] =
      [];

    for (const item of items) {
      const externalId = `vortex-quote:${item.id}`;
      const name = quoteRequestName(item);
      const email = item.contactEmail?.trim().toLowerCase() || null;
      const phone = normalizePhoneE164(item.contactPhone) || null;
      const evidenceUrl = `${base}/v1/operator/quote-requests`;
      const fields = quoteRequestCustomFields(item);

      let customer: CustomerRow | undefined = byExternalId.get(externalId);
      if (!customer && email) {
        customer = (await emailIndex()).get(email);
      }
      if (!customer) {
        const nameKey = name.trim().toLowerCase();
        if (nameKey) customer = byName.get(nameKey);
      }
      if (!customer) {
        try {
          customer = await stub.createCustomer({
            name,
            externalId,
            phone,
            processor: item.currentProcessor?.trim() || null,
            notes: item.notes ?? null,
            source: VORTEX_QUOTE_SOURCE,
            customFields: fields,
          });
          created += 1;
        } catch {
          continue;
        }
      } else {
        updated += 1;
        // Enrich, never clobber: scalars only fill empty slots while the
        // quote-request custom fields always reflect the latest figures.
        const patch: Parameters<typeof stub.updateCustomer>[1] = {
          customFields: fields,
        };
        if (!customer.externalId) patch.externalId = externalId;
        if (!customer.processor && item.currentProcessor?.trim()) {
          patch.processor = item.currentProcessor.trim();
        }
        if (!customer.phone && phone) patch.phone = phone;
        if (!customer.notes && item.notes) patch.notes = item.notes;
        try {
          customer =
            (await stub.updateCustomer(customer.id, patch, identity.id)) ??
            customer;
        } catch {
          // Field-write refused — keep the matched row; the signal below
          // still carries the revenue data.
        }
      }
      byExternalId.set(externalId, customer);
      const nameKey = customer.name.trim().toLowerCase();
      if (nameKey && !byName.has(nameKey)) byName.set(nameKey, customer);
      if (email && !byEmail.has(email)) {
        byEmail.set(email, customer);
      }
      const customerId = customer.id;

      // Contact — email and phone upsert independently so either alone
      // still lands.
      if (email) {
        await stub.upsertContact({
          customerId: customer.id,
          type: item.contactName?.trim() ? "named_person" : "business_channel",
          role: item.contactName?.trim() ? "owner" : null,
          channel: "email",
          value: email,
          label: item.contactName?.trim() || name,
          status: "verified",
          confidence: "high",
          source: VORTEX_QUOTE_SOURCE,
          evidenceUri: evidenceUrl,
        });
      }
      if (phone) {
        await stub.upsertContact({
          customerId: customer.id,
          type: item.contactName?.trim() ? "named_person" : "business_channel",
          role: item.contactName?.trim() ? "owner" : null,
          channel: "phone",
          value: phone,
          label: item.contactName?.trim() || name,
          status: "verified",
          confidence: "high",
          source: VORTEX_QUOTE_SOURCE,
          evidenceUri: evidenceUrl,
        });
      }

      // Inbound lead: open a lead-stage deal unless the merchant is
      // already in the pipeline (the quote-request deal itself dedupes on
      // externalId, so a re-sync never re-enters at lead).
      const openDeal = deals.find(
        (deal) =>
          deal.customerId === customerId &&
          deal.stage !== "won" &&
          deal.stage !== "lost"
      );
      if (!openDeal) {
        const deal = await stub.createDeal({
          customerId,
          name,
          externalId,
          stage: "lead",
          amountCents: item.estimatedAnnualSavingsCents ?? null,
          description:
            item.notes ?? "Inbound lead from the Vortex pricing calculator",
        });
        deals.push(deal);
      }

      // Self-reported monthly volume is a rankable revenue signal — same
      // persist-then-rank shape as the rep-collected intake figures
      // (PILE-654). Deterministic signal id keeps a re-sync an upsert.
      let score: number | null = customer.priorityScore ?? null;
      const estVolumeCents = quoteRequestVolumeCents(item);
      if (estVolumeCents !== null) {
        try {
          const createdMs = item.createdAt
            ? Date.parse(item.createdAt)
            : Number.NaN;
          const observedAt = Number.isFinite(createdMs)
            ? new Date(createdMs).toISOString()
            : new Date().toISOString();
          const signal: MerchantSignal = {
            id: `sig_vortex_quote_${signalIdPart(item.id)}`,
            merchantId: customer.id,
            type: "revenue_estimate",
            observedAt,
            source: VORTEX_QUOTE_SOURCE,
            evidenceUrl,
            strength: 90,
            summary: `Self-reported monthly card volume ≈ ${centsToDollarText(estVolumeCents)}/mo (pricing calculator)`,
          };
          const breakdown = await persistSignalAndRank({
            stub,
            customer,
            signal,
            estMonthlyVolumeCents: estVolumeCents,
            actorId: identity.id,
            extraAttrs: { hasPhone: Boolean(customer.phone ?? phone) },
          });
          score = breakdown.priorityScore;
        } catch {
          // Signal + rank persistence is best-effort — the customer,
          // contact, and deal records above are the durable outcome.
        }
      }

      synced.push({
        id: customer.id,
        name: customer.name,
        externalId: customer.externalId ?? externalId,
        estMonthlyVolumeCents: estVolumeCents,
        score,
      });
    }

    return c.json(
      {
        synced: synced.length,
        created,
        updated,
        customers: synced,
      },
      200
    );
  });

  // PILE-656 — Vortex merchant-statement join. Items arrive inline or are
  // pulled from the operator API; each carries *measured* first-party
  // TPV, the strongest revenue figure in the system.
  app.openapi(vortexMerchantSyncRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const base = (
      envString(c.env, "VORTEX_API_URL") ?? "https://api.vortex.nyc"
    ).replace(/\/+$/, "");
    const statementsUrl = `${base}/v1/operator/merchant-statements`;

    let items: VortexMerchantItem[] | undefined = body.merchants;
    if (items === undefined) {
      const operatorKey =
        body.vortexOperatorKey ?? envString(c.env, "VORTEX_OPERATOR_API_KEY");
      if (!operatorKey) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message:
            "Provide merchants inline or a Vortex operator API key (vortexOperatorKey / VORTEX_OPERATOR_API_KEY)",
        });
      }
      const res = await fetch(statementsUrl, {
        headers: { Authorization: `Bearer ${operatorKey}` },
      });
      if (!res.ok) {
        throw new VortexError({
          code: "AGENT_ERROR",
          status: 502,
          message: `Vortex merchant-statements fetch failed (HTTP ${res.status})`,
        });
      }
      const payload = (await res.json()) as unknown;
      const rec = (payload ?? {}) as Record<string, unknown>;
      const rawItems: unknown[] =
        [payload, rec.merchants, rec.merchantStatements, rec.items].find(
          (v): v is unknown[] => Array.isArray(v)
        ) ?? [];
      // Rows that fail the item shape (e.g. no externalMerchantRef) are
      // skipped rather than sinking the whole batch — the upstream
      // payload is not ours to fix.
      items = rawItems
        .map((row) => vortexMerchantItemSchema.safeParse(row))
        .filter((r) => r.success)
        .map((r) => r.data);
    }

    // Match indexes over the existing customer book — explicit id and
    // the merchant-ref join key are hard keys; the email index is built
    // lazily on the first email-only lookup, and the name match is the
    // last resort for merchants that predate the join key.
    const existing = await stub.listCustomers();
    type CustomerRow = (typeof existing)[number];
    const byId = new Map<string, CustomerRow>();
    const byExternalId = new Map<string, CustomerRow>();
    const byMerchantRef = new Map<string, CustomerRow>();
    const byName = new Map<string, CustomerRow>();
    for (const row of existing) {
      byId.set(row.id, row);
      if (row.externalId) byExternalId.set(row.externalId, row);
      const ref = row.customFields.externalMerchantRef;
      if (ref) byMerchantRef.set(ref, row);
      const nameKey = row.name.trim().toLowerCase();
      if (nameKey && !byName.has(nameKey)) byName.set(nameKey, row);
    }
    const byEmail = new Map<string, CustomerRow>();
    let emailIndexBuilt = false;
    const emailIndex = async () => {
      if (emailIndexBuilt) return byEmail;
      emailIndexBuilt = true;
      await Promise.all(
        existing.map(async (cust) => {
          for (const contact of await stub.listContacts(cust.id)) {
            if (contact.channel !== "email") continue;
            const key = contact.value.trim().toLowerCase();
            if (key && !byEmail.has(key)) byEmail.set(key, cust);
          }
        })
      );
      return byEmail;
    };

    let created = 0;
    let updated = 0;
    const synced: z.infer<typeof vortexMerchantSyncResultSchema>["customers"] =
      [];

    for (const item of items) {
      const ref = item.externalMerchantRef.trim();
      const externalId = `vortex-merchant:${ref}`;
      const email = item.contactEmail?.trim().toLowerCase() || null;
      const name =
        item.businessName?.trim() ||
        email?.split("@")[0] ||
        `Vortex merchant ${ref}`;
      const fields = vortexMerchantCustomFields(item);
      const measuredCents = finiteMetric(item.monthlyVolumeCents);
      const rateBps = finiteMetric(item.effectiveRateBps);

      let customer = item.customerId ? byId.get(item.customerId) : undefined;
      if (!customer) {
        customer = byMerchantRef.get(ref) ?? byExternalId.get(externalId);
      }
      if (!customer && email) {
        customer = (await emailIndex()).get(email);
      }
      if (!customer) {
        const nameKey = name.trim().toLowerCase();
        if (nameKey) customer = byName.get(nameKey);
      }
      if (!customer) {
        try {
          customer = await stub.createCustomer({
            name,
            externalId,
            processor: item.processor?.trim() || null,
            source: VORTEX_MERCHANT_SOURCE,
            customFields: fields,
          });
          created += 1;
        } catch {
          continue;
        }
      } else {
        updated += 1;
        // Enrich, never clobber: scalars only fill empty slots while the
        // statement custom fields always reflect the latest analysis.
        const patch: Parameters<typeof stub.updateCustomer>[1] = {
          customFields: fields,
        };
        if (!customer.externalId) patch.externalId = externalId;
        if (!customer.processor && item.processor?.trim()) {
          patch.processor = item.processor.trim();
        }
        try {
          customer =
            (await stub.updateCustomer(customer.id, patch, identity.id)) ??
            customer;
        } catch {
          // Field write refused — keep the matched row; the signal below
          // still carries the revenue data.
        }
      }
      byId.set(customer.id, customer);
      byExternalId.set(externalId, customer);
      byMerchantRef.set(ref, customer);
      const nameKey = customer.name.trim().toLowerCase();
      if (nameKey && !byName.has(nameKey)) byName.set(nameKey, customer);
      if (email && !byEmail.has(email)) byEmail.set(email, customer);
      const customerId = customer.id;

      if (email) {
        await stub.upsertContact({
          customerId,
          type: "business_channel",
          role: null,
          channel: "email",
          value: email,
          label: name,
          status: "verified",
          confidence: "high",
          source: VORTEX_MERCHANT_SOURCE,
          evidenceUri: statementsUrl,
        });
      }

      // The rep-facing intake document (`intake-<externalId>` slug) gets
      // the join key too, so the visit record cites the Vortex merchant.
      if (customer.externalId) {
        try {
          const slug = normalizeDocumentSlug(`intake-${customer.externalId}`);
          const doc = slug
            ? (await stub.listDocuments({ slug }))[0]
            : undefined;
          if (doc && doc.contentFormat === "markdown") {
            const refLine = `- **Vortex merchant ref:** ${ref}`;
            const content = doc.content.includes("**Vortex merchant ref:**")
              ? doc.content.replace(
                  /- \*\*Vortex merchant ref:\*\*[^\n]*/m,
                  refLine
                )
              : `${doc.content.trimEnd()}\n\n${refLine}\n`;
            if (content !== doc.content) {
              await stub.updateDocument(doc.id, { content }, identity.id);
            }
          }
        } catch {
          // Document update is best-effort — the customer join stands.
        }
      }

      // Measured TPV is the strongest revenue_estimate the system emits
      // (strength 100). Deterministic signal id keeps a re-sync an
      // upsert, then the ranker recomputes from the real figure.
      let score: number | null = customer.priorityScore ?? null;
      if (measuredCents !== null) {
        try {
          const signal: MerchantSignal = {
            id: `sig_vortex_tpv_${signalIdPart(ref)}`,
            merchantId: customer.id,
            type: "revenue_estimate",
            observedAt: new Date().toISOString(),
            source: VORTEX_MERCHANT_SOURCE,
            evidenceUrl: statementsUrl,
            strength: 100,
            summary: `Measured card volume ${centsToDollarText(measuredCents)}/mo${
              rateBps !== null
                ? ` (effective rate ${bpsToPercentText(rateBps)})`
                : ""
            }`,
          };
          const breakdown = await persistSignalAndRank({
            stub,
            customer,
            signal,
            estMonthlyVolumeCents: measuredCents,
            actorId: identity.id,
          });
          score = breakdown.priorityScore;
        } catch {
          // Signal + rank persistence is best-effort — the customer join
          // and field writes above are the durable outcome.
        }
      }

      synced.push({
        id: customer.id,
        name: customer.name,
        externalMerchantRef: ref,
        measuredMonthlyVolumeCents: measuredCents,
        effectiveRateBps: rateBps,
        score,
      });
    }

    return c.json(
      {
        synced: synced.length,
        created,
        updated,
        customers: synced,
      },
      200
    );
  });

  // PILE-656 — statement-photo transcription. Rep-snapped statements sit
  // in R2 as JPEGs/PNGs; explicit figures win, pasted/OCR'd text is
  // regex-parsed, and images go through Workers AI vision when bound.
  app.openapi(statementTranscribeRoute, async (c) => {
    const { organizationId, customerId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    let customer = await stub.getCustomer(customerId);
    if (!customer) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Customer not found",
      });
    }

    const metrics = {
      monthlyVolumeCents: finiteMetric(body.monthlyVolumeCents),
      totalFeesCents: finiteMetric(body.totalFeesCents),
      effectiveRateBps: finiteMetric(body.effectiveRateBps),
      avgTicketCents: finiteMetric(body.avgTicketCents),
      processor: body.processor?.trim() || null,
      statementPeriod: body.statementPeriod?.trim() || null,
    };

    // Extraction only runs when the caller didn't already know the
    // volume — explicit figures always win.
    if (metrics.monthlyVolumeCents === null) {
      if (body.extractedText?.trim()) {
        mergeStatementMetrics(
          metrics,
          parseStatementMetricsFromText(body.extractedText)
        );
      } else {
        let imageBytes: Uint8Array | null = null;
        if (body.imageBase64?.trim()) {
          imageBytes = base64ToBytes(body.imageBase64.trim());
        } else if (body.attachmentKey) {
          // The key must point at this workspace's uploads — same
          // prefix the /files read route enforces.
          if (!body.attachmentKey.startsWith(`${organizationId}/`)) {
            throw new VortexError({
              code: "BAD_REQUEST",
              status: 400,
              message: "Statement attachment does not belong to this workspace",
            });
          }
          const object = await c.env.ATTACHMENTS_BUCKET.get(body.attachmentKey);
          if (!object) {
            throw new VortexError({
              code: "BAD_REQUEST",
              status: 400,
              message: "Statement attachment not found",
            });
          }
          imageBytes = new Uint8Array(await object.arrayBuffer());
        }
        const ai = c.env.AI;
        if (imageBytes && imageBytes.length > 0 && ai) {
          try {
            // The vision binding takes an int[] byte array (or a data: URL)
            // — a bare base64 string is not a valid image payload.
            const out = await ai.run(STATEMENT_VISION_MODEL, {
              image: [...imageBytes],
              prompt: STATEMENT_VISION_PROMPT,
              max_tokens: 400,
            });
            const text = typeof out.response === "string" ? out.response : "";
            if (text.trim()) {
              mergeStatementMetrics(
                metrics,
                parseStatementMetricsFromJson(text) ??
                  parseStatementMetricsFromText(text)
              );
            }
          } catch {
            // Vision is best-effort — whatever was supplied still lands.
          }
        }
      }
    }

    const hasAnyMetric =
      metrics.monthlyVolumeCents !== null ||
      metrics.totalFeesCents !== null ||
      metrics.effectiveRateBps !== null ||
      metrics.avgTicketCents !== null ||
      metrics.processor !== null ||
      metrics.statementPeriod !== null;
    if (!hasAnyMetric) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message:
          "No statement metrics could be extracted — pass extractedText, imageBase64/attachmentKey with Workers AI bound, or explicit figures",
      });
    }

    const fields: Record<string, string> = {
      statementSource: STATEMENT_OCR_SOURCE,
    };
    if (metrics.monthlyVolumeCents !== null) {
      fields.estMonthlyVolumeCents = String(metrics.monthlyVolumeCents);
      fields.monthly_card_volume_cents = String(metrics.monthlyVolumeCents);
    }
    if (metrics.totalFeesCents !== null) {
      fields.totalFeesCents = String(metrics.totalFeesCents);
    }
    if (metrics.effectiveRateBps !== null) {
      fields.effectiveRateBps = String(metrics.effectiveRateBps);
    }
    if (metrics.avgTicketCents !== null) {
      fields.averageTicketCents = String(metrics.avgTicketCents);
    }
    if (metrics.statementPeriod) {
      fields.statementPeriod = metrics.statementPeriod;
    }
    const patch: Parameters<typeof stub.updateCustomer>[1] = {
      customFields: fields,
    };
    if (!customer.processor && metrics.processor) {
      patch.processor = metrics.processor;
    }
    try {
      customer =
        (await stub.updateCustomer(customer.id, patch, identity.id)) ??
        customer;
    } catch {
      // Field write refused — the signal below still carries the figure.
    }

    // An OCR'd statement figure sits between rep-reported (90) and
    // first-party TPV (100) — it is measured, not self-reported.
    let score: number | null = customer.priorityScore ?? null;
    if (metrics.monthlyVolumeCents !== null) {
      try {
        const signal: MerchantSignal = {
          id: `sig_statement_ocr_${customer.id}`,
          merchantId: customer.id,
          type: "revenue_estimate",
          observedAt: new Date().toISOString(),
          source: STATEMENT_OCR_SOURCE,
          evidenceUrl: body.attachmentKey
            ? `/workspaces/${organizationId}/files?key=${encodeURIComponent(body.attachmentKey)}`
            : `statement-ocr:${customer.id}`,
          strength: 95,
          summary: `Measured card volume ${centsToDollarText(metrics.monthlyVolumeCents)}/mo from a photographed statement${
            metrics.effectiveRateBps !== null
              ? ` (effective rate ${bpsToPercentText(metrics.effectiveRateBps)})`
              : ""
          }`,
        };
        const breakdown = await persistSignalAndRank({
          stub,
          customer,
          signal,
          estMonthlyVolumeCents: metrics.monthlyVolumeCents,
          actorId: identity.id,
        });
        score = breakdown.priorityScore;
      } catch {
        // Signal + rank persistence is best-effort — the field write is
        // the durable outcome.
      }
    }

    return c.json(
      {
        customerId: customer.id,
        metrics: {
          monthlyVolumeCents: metrics.monthlyVolumeCents,
          totalFeesCents: metrics.totalFeesCents,
          effectiveRateBps: metrics.effectiveRateBps,
          processor: metrics.processor,
        },
        score,
      },
      200
    );
  });

  // PILE-659 — SBA PPP/7(a) loan import. The public loan file is the
  // strongest free revenue proxy for storefronts: PPP loan amount ÷ 2.5
  // is monthly payroll, and a payroll→revenue ratio turns that into a
  // monthly-volume estimate.
  app.openapi(pppLoanImportRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const ratio =
      body.payrollToRevenueRatio ?? DEFAULT_PAYROLL_TO_REVENUE_RATIO;

    // Match indexes — `sba-ppp:<loanId>` is the hard key; name+street is
    // the fallback for rows that predate the import (or loans whose id
    // the extract lost).
    const existing = await stub.listCustomers();
    type CustomerRow = (typeof existing)[number];
    const byExternalId = new Map<string, CustomerRow>();
    const byName = new Map<string, CustomerRow[]>();
    for (const row of existing) {
      if (row.externalId) byExternalId.set(row.externalId, row);
      const nameKey = row.name.trim().toLowerCase();
      if (nameKey) {
        const rows = byName.get(nameKey) ?? [];
        rows.push(row);
        byName.set(nameKey, rows);
      }
    }

    let created = 0;
    let updated = 0;
    const imported: z.infer<typeof pppLoanImportResultSchema>["customers"] = [];

    for (const loan of body.loans) {
      const name = loan.businessName.trim();
      const loanId = loan.loanId?.trim() || null;
      const externalId = loanId ? `sba-ppp:${loanId}` : null;
      const loanAmountCents = pppLoanAmountCents(loan);
      const jobs = finiteMetric(loan.jobsReported);
      const { estMonthlyPayrollCents, estMonthlyVolumeCents } =
        pppLoanEstimates({
          loanAmountCents,
          loanType: loan.loanType,
          payrollToRevenueRatio: ratio,
        });
      const fields = pppLoanCustomFields(loan, ratio);
      const address =
        [loan.address, loan.city, loan.state, loan.zip]
          .map((part) => part?.trim())
          .filter((part): part is string => Boolean(part))
          .join(", ") || null;

      let customer = externalId ? byExternalId.get(externalId) : undefined;
      if (!customer) {
        const candidates = byName.get(name.toLowerCase()) ?? [];
        const loanAddr = normalizeStreetAddress(loan.address);
        if (loanAddr) {
          // The stored address is the fuller string ("123 Main St,
          // Brooklyn, NY") — match when either normalized form is a
          // prefix of the other.
          customer = candidates.find((row) => {
            const stored = normalizeStreetAddress(row.address);
            return (
              stored === loanAddr ||
              (stored.length > 0 &&
                (stored.startsWith(loanAddr) || loanAddr.startsWith(stored)))
            );
          });
        } else {
          customer = candidates[0];
        }
      }
      if (!customer) {
        try {
          customer = await stub.createCustomer({
            name,
            externalId,
            address,
            source: SBA_LOAN_SOURCE,
            customFields: fields,
          });
          created += 1;
        } catch {
          continue;
        }
      } else {
        updated += 1;
        const patch: Parameters<typeof stub.updateCustomer>[1] = {
          customFields: fields,
        };
        if (!customer.externalId && externalId) {
          patch.externalId = externalId;
        }
        if (!customer.address && address) patch.address = address;
        try {
          customer =
            (await stub.updateCustomer(customer.id, patch, identity.id)) ??
            customer;
        } catch {
          // Field write refused — keep the matched row; the signal below
          // still carries the estimate.
        }
      }
      const customerId = customer.id;
      if (externalId) byExternalId.set(externalId, customer);
      const nameKey = customer.name.trim().toLowerCase();
      if (nameKey) {
        const rows = byName.get(nameKey) ?? [];
        if (!rows.some((row) => row.id === customerId)) {
          rows.push(customer);
        }
        byName.set(nameKey, rows);
      }

      // The payroll-derived estimate is a proxy, not a measurement —
      // strength 75 vs the 90+ of reported/measured figures.
      // Deterministic signal id keeps a re-import an upsert.
      let score: number | null = customer.priorityScore ?? null;
      if (loanAmountCents !== null || estMonthlyVolumeCents !== null) {
        try {
          const loanLabel =
            loan.loanType === "7a" ? "SBA 7(a) loan" : "SBA PPP loan";
          const signal: MerchantSignal = {
            id: `sig_sba_ppp_${signalIdPart(loanId ?? `${name}-${loan.zip ?? ""}`)}`,
            merchantId: customerId,
            type: "revenue_estimate",
            observedAt: new Date().toISOString(),
            source: SBA_LOAN_SOURCE,
            evidenceUrl: "https://data.sba.gov/dataset/ppp-foia",
            strength: 75,
            summary: `${loanLabel} ${
              loanAmountCents !== null
                ? centsToDollarText(loanAmountCents)
                : "unknown amount"
            }${jobs !== null ? ` (${jobs} jobs)` : ""}${
              estMonthlyVolumeCents !== null
                ? ` → est. revenue ≈ ${centsToDollarText(estMonthlyVolumeCents)}/mo`
                : ""
            }`,
          };
          const breakdown = await persistSignalAndRank({
            stub,
            customer,
            signal,
            estMonthlyVolumeCents,
            actorId: identity.id,
          });
          score = breakdown.priorityScore;
        } catch {
          // Signal + rank persistence is best-effort — the customer and
          // field writes are the durable outcome.
        }
      }

      imported.push({
        id: customerId,
        name: customer.name,
        loanAmountCents,
        estMonthlyPayrollCents,
        estMonthlyVolumeCents,
        jobsReported: jobs,
        score,
      });
    }

    return c.json(
      {
        imported: imported.length,
        created,
        updated,
        customers: imported,
      },
      200
    );
  });
}

const INTAKE_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Pile — Merchant intake</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: #0a0a0b; color: #e4e4e7; font: 15px/1.5 system-ui, sans-serif; }
  main { max-width: 560px; margin: 0 auto; padding: 1rem 1rem 6rem; }
  h1 { font-size: 1.1rem; font-weight: 600; }
  header { display: flex; align-items: baseline; gap: .75rem; padding: .75rem 0 1rem; }
  header select { margin-left: auto; max-width: 50%; }
  .muted { color: #71717a; font-size: .8rem; }
  a { color: #93c5fd; }
  fieldset { border: 1px solid #1f1f23; border-radius: 10px; padding: .9rem; margin-bottom: 1rem; background: #111113; }
  legend { font-size: .72rem; color: #a1a1aa; text-transform: uppercase; letter-spacing: .08em; padding: 0 .4rem; }
  label { display: block; font-size: .8rem; color: #a1a1aa; margin: .7rem 0 .25rem; }
  label:first-of-type { margin-top: 0; }
  input, select, textarea {
    font: inherit; width: 100%; padding: .65rem .75rem; background: #18181b;
    color: #e4e4e7; border: 1px solid #27272a; border-radius: 8px;
  }
  input[type="checkbox"] { width: auto; margin-right: .5rem; }
  textarea { min-height: 4.5rem; resize: vertical; }
  .checks { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .3rem; }
  .chip { display: inline-flex; align-items: center; gap: .35rem; padding: .45rem .7rem; border: 1px solid #27272a; border-radius: 999px; font-size: .8rem; cursor: pointer; user-select: none; }
  .chip.on { background: #1e3a5f; border-color: #3b82f6; color: #bfdbfe; }
  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
  button { font: inherit; padding: .65rem .9rem; border-radius: 8px; border: 1px solid #27272a; background: #18181b; color: #e4e4e7; cursor: pointer; }
  #submit { position: fixed; left: 0; right: 0; bottom: 0; padding: .8rem 1rem calc(.8rem + env(safe-area-inset-bottom)); background: #0a0a0bd9; backdrop-filter: blur(8px); border-top: 1px solid #1f1f23; }
  #submit button { width: 100%; max-width: 560px; margin: 0 auto; display: block; background: #2563eb; border: 0; font-weight: 600; font-size: 1rem; }
  #submit button:disabled { opacity: .5; }
  #status { font-size: .8rem; margin-top: .5rem; white-space: pre-wrap; }
  #status .err { color: #f87171; }
  #status .ok { color: #4ade80; }
  #done { margin-top: 1rem; }
  #done .card { border: 1px solid #14532d; background: #052e16; border-radius: 10px; padding: 1rem; }
  #auth { max-width: 340px; margin: 6rem auto 0; padding: 0 1rem; }
  #auth button { width: 100%; margin-top: .5rem; }
  .thumbs { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: .5rem; }
  .thumbs img { width: 64px; height: 64px; object-fit: cover; border-radius: 6px; border: 1px solid #27272a; }
  #stageSetup { margin-top: .4rem; font-size: .8rem; }
</style>
</head>
<body>
<div id="auth" hidden>
  <h1>Merchant intake</h1>
  <p class="muted" style="margin:.5rem 0 1rem">Sign in to log a visit.</p>
  <input id="email" type="email" placeholder="email" autocomplete="email" />
  <input id="pass" type="password" placeholder="password" autocomplete="current-password" style="margin-top:.5rem" />
  <button id="signin">Sign in</button>
  <p id="autherr" class="muted" style="color:#f87171;margin-top:.6rem"></p>
</div>
<main id="app" hidden>
  <header>
    <h1>Merchant intake</h1>
    <select id="ws" aria-label="Workspace"></select>
  </header>
  <form id="form" onsubmit="return false">
    <fieldset>
      <legend>Visit</legend>
      <label for="businessName">Business name *</label>
      <input id="businessName" required autocomplete="organization" />
      <label for="address">Address</label>
      <input id="address" autocomplete="street-address" />
      <div class="row2">
        <div><label for="spokeName">Spoke with</label><input id="spokeName" /></div>
        <div><label for="spokeRole">Their role</label><input id="spokeRole" placeholder="cashier, manager…" /></div>
      </div>
      <label class="chip" style="margin-top:.6rem"><input type="checkbox" id="isDm" /> Owner / decision maker</label>
    </fieldset>
    <fieldset>
      <legend>Owner contact</legend>
      <label for="ownerName">Owner name</label>
      <input id="ownerName" autocomplete="name" />
      <div class="row2">
        <div><label for="ownerPhone">Phone</label><input id="ownerPhone" type="tel" inputmode="tel" autocomplete="tel" /></div>
        <div><label for="ownerEmail">Email</label><input id="ownerEmail" type="email" inputmode="email" autocomplete="email" /></div>
      </div>
      <label for="bestTime">Best time to reach</label>
      <input id="bestTime" placeholder="mornings, after 3pm…" />
    </fieldset>
    <fieldset>
      <legend>Meeting</legend>
      <label class="chip"><input type="checkbox" id="booked" /> Meeting booked</label>
      <div id="meetWhen" style="display:none">
        <label for="meetAt">Date &amp; time</label>
        <input id="meetAt" type="datetime-local" />
      </div>
      <div id="retWhen">
        <label for="returnAt">If not booked — when to return</label>
        <input id="returnAt" placeholder="Tue morning, owner in after 5…" />
      </div>
      <label for="bookingUrl">Cal.com booking link</label>
      <input id="bookingUrl" type="url" inputmode="url" placeholder="https://cal.com/…" />
    </fieldset>
    <fieldset>
      <legend>Discovery</legend>
      <label for="bizType">What do they do to make money?</label>
      <select id="bizType">
        <option value="">—</option>
        <option>counter service</option><option>retail</option>
        <option>walk-in service</option><option>field service</option>
        <option>appointment</option><option>wholesale</option>
        <option>online-only</option><option>cash-only</option>
      </select>
      <label>How does money come in?</label>
      <div class="checks" id="billing"></div>
      <label>Payment methods</label>
      <div class="checks" id="payments"></div>
      <div class="row2">
        <div><label for="hardware">Hardware on the counter</label><input id="hardware" placeholder="Square terminal, Clover Duo…" /></div>
        <div><label for="hwOwn">Owned / leased / bundled</label>
          <select id="hwOwn"><option value="">—</option><option>owned</option><option>leased</option><option>bundled</option></select>
        </div>
      </div>
      <label for="signage">Surcharge / cash-discount signage</label>
      <input id="signage" placeholder="3% card fee sign at register…" />
      <label for="fit">Fit notes (flag regulated or unusual categories)</label>
      <textarea id="fit"></textarea>
    </fieldset>
    <fieldset>
      <legend>Pricing data</legend>
      <div class="row2">
        <div><label for="processor">Current processor</label><input id="processor" placeholder="Square, Clover, Worldpay…" /></div>
        <div><label for="pos">POS / terminal</label><input id="pos" /></div>
      </div>
      <label class="chip" style="margin-top:.6rem"><input type="checkbox" id="contract" /> Under contract</label>
      <div id="contractFields" style="display:none">
        <div class="row2">
          <div><label for="contractEnd">Contract end</label><input id="contractEnd" type="date" /></div>
          <div><label for="etf">Early termination fee</label><input id="etf" inputmode="decimal" placeholder="$" /></div>
        </div>
      </div>
      <label for="tenure">Time with current provider</label>
      <input id="tenure" placeholder="2 years…" />
      <label for="photos">Processing statement — photo every page (ask permission first)</label>
      <input id="photos" type="file" accept="image/*" capture="environment" multiple />
      <div class="thumbs" id="thumbs"></div>
      <div class="row2">
        <div><label for="volume">Monthly card volume</label><input id="volume" inputmode="decimal" placeholder="$" /></div>
        <div><label for="ticket">Average ticket</label><input id="ticket" inputmode="decimal" placeholder="$" /></div>
      </div>
      <div class="row2">
        <div><label for="tpd">Transactions / day</label><input id="tpd" inputmode="numeric" /></div>
        <div><label for="cardMix">Card mix</label>
          <select id="cardMix"><option value="">—</option>
            <option>mostly debit</option><option>mostly credit</option>
            <option>lots of rewards</option><option>business cards</option><option>mixed</option>
          </select>
        </div>
      </div>
      <label for="channelMix">In person vs keyed / online / invoiced</label>
      <select id="channelMix"><option value="">—</option>
        <option>mostly in-person tap/insert</option><option>meaningful keyed share</option>
        <option>meaningful online share</option><option>meaningful invoiced share</option><option>mixed</option>
      </select>
      <label for="season">Peak seasons / slow months</label>
      <input id="season" />
      <label for="salesTotals">No statement? Monthly card sales totals</label>
      <input id="salesTotals" placeholder="from their dashboard reports" />
    </fieldset>
    <fieldset>
      <legend>Pain &amp; motivation</legend>
      <label for="complaint">Biggest complaint, in their words</label>
      <textarea id="complaint" placeholder="fees, slow deposits, chargebacks, hardware, support…"></textarea>
      <label for="switched">Switched processors before? Why they left</label>
      <input id="switched" />
      <label for="wishes">Anything they wish the setup did</label>
      <input id="wishes" placeholder="faster funding, invoicing…" />
    </fieldset>
    <fieldset>
      <legend>Wrap</legend>
      <label for="stage">Pipeline stage</label>
      <select id="stage"></select>
      <div id="stageSetup" class="muted" hidden>No pipeline stages yet — <a href="#" id="mkStages">create the standard six</a>.</div>
      <div class="row2">
        <div><label for="nextStep">Next step</label><input id="nextStep" placeholder="the meeting, statement handoff…" /></div>
        <div><label for="nextDate">By when</label><input id="nextDate" type="date" /></div>
      </div>
      <label for="notes">Your notes — vibe, honesty check, real prospect?</label>
      <textarea id="notes"></textarea>
    </fieldset>
    <div id="status"></div>
    <div id="done"></div>
  </form>
</main>
<div id="submit" hidden><button id="go">Save intake</button></div>
<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var api = function(p, o){ return fetch(p, { credentials: "same-origin", ...o }).then(function(r){
    if (!r.ok) return r.text().then(function(t){ throw new Error(r.status + " " + t); });
    return r.json();
  }); };
  var esc = function(s){ return String(s == null ? "" : s).replace(/[&<>"]/g, function(c){ return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var val = function(id){ var v = $(id).value.trim(); return v || undefined; };
  var ws = localStorage.getItem("pile_ws") || "";
  var intakeId = crypto.randomUUID();

  var BILLING = ["point-of-sale","standalone terminal","invoicing software","online checkout","keyed phone orders","recurring billing","none"];
  var PAYMENTS = ["card-present","keyed","online","invoice links","recurring","bank transfer"];
  var STAGES = ["New","Meeting booked","Statement received","Proposal sent","Onboarding in flight","Onboarded","Passed","Lost"];
  var TERMINAL = { "Passed": 1, "Lost": 1 };

  function chips(el, names){
    $(el).innerHTML = names.map(function(n){
      return '<label class="chip"><input type="checkbox" value="' + esc(n) + '" hidden />' + esc(n) + '</label>';
    }).join("");
    $(el).querySelectorAll(".chip").forEach(function(chip){
      chip.addEventListener("click", function(){ chip.classList.toggle("on"); });
    });
  }
  function chipValues(el){
    return Array.prototype.map.call($(el).querySelectorAll(".chip.on input"), function(i){ return i.value; });
  }
  chips("billing", BILLING);
  chips("payments", PAYMENTS);

  $("booked").addEventListener("change", function(e){
    $("meetWhen").style.display = e.target.checked ? "" : "none";
    $("retWhen").style.display = e.target.checked ? "none" : "";
  });
  $("contract").addEventListener("change", function(e){
    $("contractFields").style.display = e.target.checked ? "" : "none";
  });
  $("photos").addEventListener("change", function(e){
    $("thumbs").innerHTML = "";
    Array.prototype.forEach.call(e.target.files, function(f){
      var img = document.createElement("img");
      img.src = URL.createObjectURL(f);
      $("thumbs").appendChild(img);
    });
  });

  async function boot(){
    var session = null;
    try { session = await api("/api/auth/get-session"); } catch (e) {}
    if (!session || !session.user) { $("auth").hidden = false; return; }
    var data = await api("/workspaces");
    if (!data.workspaces.length) { $("auth").hidden = false; $("autherr").textContent = "No workspace — sign in on a laptop first."; return; }
    $("app").hidden = false;
    $("submit").hidden = false;
    $("ws").innerHTML = data.workspaces.map(function(w){ return '<option value="' + esc(w.id) + '">' + esc(w.name) + "</option>"; }).join("");
    if (!data.workspaces.find(function(w){ return w.id === ws; })) ws = data.workspaces[0].id;
    $("ws").value = ws;
    await loadStages();
  }

  async function loadStages(){
    var res = await api("/workspaces/" + ws + "/customer-statuses");
    var list = res.statuses.slice().sort(function(a, b){ return a.position - b.position; });
    $("stage").innerHTML = '<option value="">—</option>' + list.map(function(s){
      return '<option value="' + esc(s.id) + '">' + esc(s.name) + "</option>";
    }).join("");
    $("stageSetup").hidden = list.length > 0;
    var def = list.find(function(s){ return s.name === "New"; });
    if (def) $("stage").value = def.id;
  }

  $("mkStages").addEventListener("click", async function(e){
    e.preventDefault();
    for (var i = 0; i < STAGES.length; i++) {
      await api("/workspaces/" + ws + "/customer-statuses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: STAGES[i], position: i, type: TERMINAL[STAGES[i]] ? "terminal" : "active" })
      });
    }
    await loadStages();
  });

  $("ws").addEventListener("change", function(e){
    ws = e.target.value;
    localStorage.setItem("pile_ws", ws);
    loadStages();
  });

  function say(msg, cls){ $("status").innerHTML = '<span class="' + (cls || "") + '">' + esc(msg) + "</span>"; }

  function fileToBase64(file){
    return new Promise(function(resolve, reject){
      var r = new FileReader();
      r.onload = function(){ resolve(String(r.result).split(",")[1]); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function payload(statementFiles){
    var p = { intakeId: intakeId, businessName: val("businessName") };
    p.address = val("address");
    p.spokeWith = (val("spokeName") || val("spokeRole") || $("isDm").checked)
      ? { name: val("spokeName"), role: val("spokeRole"), isDecisionMaker: $("isDm").checked || undefined }
      : undefined;
    p.owner = (val("ownerName") || val("ownerPhone") || val("ownerEmail") || val("bestTime"))
      ? { name: val("ownerName"), phone: val("ownerPhone"), email: val("ownerEmail"), bestTime: val("bestTime") }
      : undefined;
    p.meeting = ($("booked").checked || val("returnAt") || val("bookingUrl"))
      ? { booked: $("booked").checked, at: val("meetAt"), returnAt: $("booked").checked ? undefined : val("returnAt"), bookingUrl: val("bookingUrl") }
      : undefined;
    p.discovery = {
      businessType: val("bizType"),
      billingSystems: chipValues("billing"),
      paymentMethods: chipValues("payments"),
      hardware: val("hardware"),
      hardwareOwnership: val("hwOwn"),
      signage: val("signage"),
      fitNotes: val("fit")
    };
    if (!Object.values(p.discovery).some(function(v){ return v && (Array.isArray(v) ? v.length : true); })) p.discovery = undefined;
    p.pricing = {
      currentProcessor: val("processor"), posSystem: val("pos"),
      underContract: $("contract").checked,
      contractEnd: $("contract").checked ? val("contractEnd") : undefined,
      earlyTerminationFee: $("contract").checked ? val("etf") : undefined,
      timeWithProvider: val("tenure"), monthlyCardVolume: val("volume"),
      averageTicket: val("ticket"), transactionsPerDay: val("tpd"),
      cardMix: val("cardMix"), channelMix: val("channelMix"),
      seasonality: val("season"), monthlySalesTotals: val("salesTotals")
    };
    p.pain = (val("complaint") || val("switched") || val("wishes"))
      ? { biggestComplaint: val("complaint"), switchedBefore: val("switched"), wishes: val("wishes") }
      : undefined;
    p.pipelineStatusId = val("stage");
    p.nextStep = val("nextStep");
    p.nextStepDate = val("nextDate");
    p.repNotes = val("notes");
    p.statementFiles = statementFiles;
    return p;
  }

  $("go").addEventListener("click", async function(){
    if (!val("businessName")) { say("Business name is required.", "err"); $("businessName").focus(); return; }
    var go = $("go");
    go.disabled = true;
    try {
      var files = Array.prototype.slice.call($("photos").files || []);
      var uploaded = [];
      for (var i = 0; i < files.length; i++) {
        say("Uploading statement photo " + (i + 1) + " of " + files.length + "…");
        var f = files[i];
        var up = await api("/workspaces/" + ws + "/files", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ filename: f.name || ("statement-" + (i + 1) + ".jpg"), contentType: f.type || undefined, contentBase64: await fileToBase64(f) })
        });
        uploaded.push({ key: up.key, url: up.url, name: f.name });
      }
      say("Saving intake…");
      var result = await api("/workspaces/" + ws + "/intake", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload(uploaded))
      });
      say("", "");
      $("done").innerHTML = '<div class="card"><b>' + esc(val("businessName")) + " logged</b>" +
        '<p class="muted" style="margin-top:.4rem">customer ' + esc(result.customerId.slice(0, 8)) +
        (result.documentId ? " · intake doc saved" : "") +
        (result.contactId ? " · owner contact saved" : "") +
        (result.bookingLinkId ? " · booking link attached" : "") +
        (result.deduped ? " · (already recorded)" : "") + "</p>" +
        '<button id="again" style="margin-top:.8rem;width:100%">New intake</button></div>';
      $("again").addEventListener("click", function(){
        $("form").reset();
        $("thumbs").innerHTML = "";
        document.querySelectorAll(".chip.on").forEach(function(c){ c.classList.remove("on"); });
        $("done").innerHTML = "";
        intakeId = crypto.randomUUID();
        scrollTo(0, 0);
      });
      $("done").scrollIntoView();
    } catch (e) {
      say("Save failed — your form is intact, tap Save again. (" + (e && e.message ? e.message : "network") + ")", "err");
    } finally {
      go.disabled = false;
    }
  });

  $("signin").addEventListener("click", async function(){
    $("autherr").textContent = "";
    try {
      await api("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: $("email").value, password: $("pass").value }) });
      location.reload();
    } catch (e) { $("autherr").textContent = "Sign in failed."; }
  });

  boot().catch(function(){ $("auth").hidden = false; });
})();
</script>
</body>
</html>`;
