import { z } from "zod";

// PILE-425 — per-agent spend/token caps + run receipts (generalizes VOR-712).
// Caps live on `agent_spend_caps` rows keyed (org, agentId); receipts on
// `agent_run_receipts` keyed by session. This module is the pure logic:
// schemas, window math, cost estimation, and cap evaluation. Enforcement
// lives in dispatch (agents/index.ts — parks new lanes when a window cap is
// breached) and the sweep (agents/sweep.ts — pauses the agent type + alerts
// the CoS on a window breach, cancels a lane that blows its per-run cap).

/** Caps row key for the workspace-wide default — applies to every agent
 *  type without its own row. */
export const WORKSPACE_SPEND_CAP_AGENT = "*";

/** Actor id stamped on pause rows written by cap enforcement — separates
 *  operator pauses (manual resume intent) from cap holds. */
export const SPEND_CAP_ACTOR = "spend-cap";

/** Usage a lane reports — via POST .../sessions/:id/report `usage`, or the
 *  optional `usage` field on a provider's poll/dispatch result. Values are
 *  cumulative-for-the-run snapshots, not deltas: each report replaces the
 *  receipt's usage fields so mid-run reports can't double-count. Costs are
 *  integer USD micros; `costMicros` is LLM spend (provider-computed),
 *  `externalSpendMicros` is non-LLM spend the lane chose to report. */
export const runUsageSchema = z
  .object({
    model: z.string().min(1).optional(),
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    totalTokens: z.number().int().min(0).optional(),
    toolCalls: z.number().int().min(0).optional(),
    costMicros: z.number().int().min(0).optional(),
    externalSpendMicros: z.number().int().min(0).optional(),
  })
  .strict();
export type AgentRunUsage = z.infer<typeof runUsageSchema>;

/** The cap fields a row may carry; null/undefined = uncapped. */
export interface SpendCapLimits {
  maxRunsPerDay?: number | null;
  maxRunsPerMonth?: number | null;
  maxTokensPerDay?: number | null;
  maxTokensPerMonth?: number | null;
  maxCostMicrosPerDay?: number | null;
  maxCostMicrosPerMonth?: number | null;
  maxTokensPerRun?: number | null;
  maxCostMicrosPerRun?: number | null;
}

/** Zod shape for the caps upsert body — every field explicitly nullable so
 *  a PUT can clear a limit. */
export const spendCapBodySchema = z
  .object({
    maxRunsPerDay: z.number().int().min(1).nullable().optional(),
    maxRunsPerMonth: z.number().int().min(1).nullable().optional(),
    maxTokensPerDay: z.number().int().min(0).nullable().optional(),
    maxTokensPerMonth: z.number().int().min(0).nullable().optional(),
    maxCostMicrosPerDay: z.number().int().min(0).nullable().optional(),
    maxCostMicrosPerMonth: z.number().int().min(0).nullable().optional(),
    maxTokensPerRun: z.number().int().min(0).nullable().optional(),
    maxCostMicrosPerRun: z.number().int().min(0).nullable().optional(),
  })
  .strict();

/** Observed usage the caps are checked against. Runs count sessions created
 *  in the window; tokens/cost sum `agent_run_receipts` rows created in the
 *  window (live mid-run receipts count toward the cap as they're reported). */
export interface SpendWindowUsage {
  runsPerDay: number;
  runsPerMonth: number;
  tokensPerDay: number;
  tokensPerMonth: number;
  costMicrosPerDay: number;
  costMicrosPerMonth: number;
  /** Live per-run usage — only populated when evaluating a specific lane. */
  runTokens?: number;
  runCostMicros?: number;
}

export interface CapBreach {
  scope: "run" | "day" | "month";
  dimension: "runs" | "tokens" | "cost";
  limit: number;
  observed: number;
}

/** All breached limits, stable-ordered run → day → month, runs → tokens →
 *  cost. Callers act on `breaches[0]` for messaging; the full list rides
 *  along for the receipt/event payload. Window caps breach on `>=` —
 *  hitting the budget means it's spent (the next run would exceed); per-run
 *  caps breach on strict `>` — a run at its cap is allowed to finish. */
export function evaluateSpendCaps(
  caps: SpendCapLimits,
  usage: SpendWindowUsage
): CapBreach[] {
  const breaches: CapBreach[] = [];
  if (
    caps.maxTokensPerRun != null &&
    usage.runTokens != null &&
    usage.runTokens > caps.maxTokensPerRun
  ) {
    breaches.push({
      scope: "run",
      dimension: "tokens",
      limit: caps.maxTokensPerRun,
      observed: usage.runTokens,
    });
  }
  if (
    caps.maxCostMicrosPerRun != null &&
    usage.runCostMicros != null &&
    usage.runCostMicros > caps.maxCostMicrosPerRun
  ) {
    breaches.push({
      scope: "run",
      dimension: "cost",
      limit: caps.maxCostMicrosPerRun,
      observed: usage.runCostMicros,
    });
  }
  if (caps.maxRunsPerDay != null && usage.runsPerDay >= caps.maxRunsPerDay) {
    breaches.push({
      scope: "day",
      dimension: "runs",
      limit: caps.maxRunsPerDay,
      observed: usage.runsPerDay,
    });
  }
  if (
    caps.maxTokensPerDay != null &&
    usage.tokensPerDay >= caps.maxTokensPerDay
  ) {
    breaches.push({
      scope: "day",
      dimension: "tokens",
      limit: caps.maxTokensPerDay,
      observed: usage.tokensPerDay,
    });
  }
  if (
    caps.maxCostMicrosPerDay != null &&
    usage.costMicrosPerDay >= caps.maxCostMicrosPerDay
  ) {
    breaches.push({
      scope: "day",
      dimension: "cost",
      limit: caps.maxCostMicrosPerDay,
      observed: usage.costMicrosPerDay,
    });
  }
  if (
    caps.maxRunsPerMonth != null &&
    usage.runsPerMonth >= caps.maxRunsPerMonth
  ) {
    breaches.push({
      scope: "month",
      dimension: "runs",
      limit: caps.maxRunsPerMonth,
      observed: usage.runsPerMonth,
    });
  }
  if (
    caps.maxTokensPerMonth != null &&
    usage.tokensPerMonth >= caps.maxTokensPerMonth
  ) {
    breaches.push({
      scope: "month",
      dimension: "tokens",
      limit: caps.maxTokensPerMonth,
      observed: usage.tokensPerMonth,
    });
  }
  if (
    caps.maxCostMicrosPerMonth != null &&
    usage.costMicrosPerMonth >= caps.maxCostMicrosPerMonth
  ) {
    breaches.push({
      scope: "month",
      dimension: "cost",
      limit: caps.maxCostMicrosPerMonth,
      observed: usage.costMicrosPerMonth,
    });
  }
  return breaches;
}

/** Per-run caps only — the sweep's mid-flight check against a lane's live
 *  receipt. Token total compares to `maxTokensPerRun`; spend compares to
 *  `maxCostMicrosPerRun` (cost + external spend). */
export function evaluateRunCaps(
  caps: SpendCapLimits,
  run: { totalTokens?: number | null; costMicros?: number | null }
): CapBreach[] {
  return evaluateSpendCaps(caps, {
    runsPerDay: 0,
    runsPerMonth: 0,
    tokensPerDay: 0,
    tokensPerMonth: 0,
    costMicrosPerDay: 0,
    costMicrosPerMonth: 0,
    runTokens: run.totalTokens ?? undefined,
    runCostMicros: run.costMicros ?? undefined,
  }).filter((breach) => breach.scope === "run");
}

const DIMENSION_LABEL: Record<CapBreach["dimension"], string> = {
  runs: "runs",
  tokens: "tokens",
  cost: "cost",
};

const SCOPE_LABEL: Record<CapBreach["scope"], string> = {
  run: "per-run",
  day: "daily",
  month: "monthly",
};

function formatObserved(breach: CapBreach): string {
  if (breach.dimension === "cost") {
    return `$${(breach.observed / 1_000_000).toFixed(2)}/$${(breach.limit / 1_000_000).toFixed(2)}`;
  }
  return `${breach.observed}/${breach.limit}`;
}

/** Human-readable breach for pause reasons, escalation comments, and the
 *  receipt's stopReason — "daily tokens cap exceeded (120500/100000)". */
export function describeCapBreach(breach: CapBreach): string {
  return `${SCOPE_LABEL[breach.scope]} ${DIMENSION_LABEL[breach.dimension]} cap exceeded (${formatObserved(breach)})`;
}

/** UTC day boundary as an ISO string — receipt/session `createdAt` values
 *  compare lexicographically, so window filters are string >= bounds. */
export function dayWindowStart(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** UTC month boundary as an ISO string. */
export function monthWindowStart(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01T00:00:00.000Z`;
}

/** Approximate USD-per-1M-token list prices for the models Pile lanes run.
 *  Provider-reported `costMicros` always wins over this map — it exists so
 *  receipts carry a cost figure even when the runner only reports tokens.
 *  Matching is substring (a dated model id like `claude-sonnet-4-5-20250929`
 *  matches `claude-sonnet-4-5`); longest key wins, so keep keys specific. */
const MODEL_USD_PER_MTOKEN: ReadonlyArray<{
  match: string;
  input: number;
  output: number;
}> = [
  { match: "claude-opus-4", input: 15, output: 75 },
  { match: "claude-sonnet-4", input: 3, output: 15 },
  { match: "claude-haiku-4", input: 1, output: 5 },
  { match: "gpt-5-mini", input: 0.25, output: 2 },
  { match: "gpt-5-nano", input: 0.05, output: 0.4 },
  { match: "gpt-5", input: 1.25, output: 10 },
];

/** Cost in USD micros for a reported model + token counts, or null when the
 *  model isn't in the rate map (or neither token count is known). */
export function computeCostMicros(
  model: string | null | undefined,
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined
): number | null {
  if (!model) return null;
  const lowered = model.toLowerCase();
  // Longest match wins — `gpt-5-mini` must beat `gpt-5`.
  const rate = MODEL_USD_PER_MTOKEN.toSorted(
    (a, b) => b.match.length - a.match.length
  ).find((r) => lowered.includes(r.match));
  if (!rate) return null;
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  if (inputTokens == null && outputTokens == null) return null;
  // $/MTok == micros/token — the 1e6 factors cancel.
  return Math.round(input * rate.input + output * rate.output);
}
