import { Effect, Schedule, Schema } from "effect";

import {
  type EmailVerificationStatus,
  evaluateSendGate,
  type TouchChannel,
} from "../workspace/send-gate.js";
import { detectPosTechnographics } from "../workspace/signals-engine.js";
import {
  type MerchantCandidate,
  type MerchantSourceRow,
  pullSource,
} from "./collectors.js";

export class CollectorSourceError extends Schema.TaggedError<CollectorSourceError>()(
  "CollectorSourceError",
  {
    sourceId: Schema.String,
    kind: Schema.String,
    message: Schema.String,
  }
) {}

export class HtmlFetchError extends Schema.TaggedError<HtmlFetchError>()(
  "HtmlFetchError",
  {
    tier: Schema.String,
    url: Schema.String,
    message: Schema.String,
    retryable: Schema.optional(Schema.Boolean),
  }
) {}

export class VendorBudgetExceededError extends Schema.TaggedError<VendorBudgetExceededError>()(
  "VendorBudgetExceededError",
  {
    vendor: Schema.String,
    monthlyCapCents: Schema.Number,
    spentThisMonthCents: Schema.Number,
    requestedCents: Schema.Number,
  }
) {}

export class ComputeBackendError extends Schema.TaggedError<ComputeBackendError>()(
  "ComputeBackendError",
  {
    backend: Schema.String,
    operation: Schema.String,
    message: Schema.String,
  }
) {}

export class SendGateBlockedError extends Schema.TaggedError<SendGateBlockedError>()(
  "SendGateBlockedError",
  {
    customerId: Schema.String,
    name: Schema.String,
    reasons: Schema.Array(Schema.String),
  }
) {}

export interface EnrichedMerchantCandidate extends MerchantCandidate {
  posGuess?: string | null;
  posEvidenceUrl?: string | null;
  dosId?: string | null;
  dosFilingDate?: string | null;
  scrapeTier?: "direct" | "scrapling" | "firecrawl" | null;
}

const SAFE_PUBLIC_DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function isSafePublicDomain(
  domain: string | null | undefined
): domain is string {
  if (!domain) return false;
  const host = domain.trim().toLowerCase();
  if (!SAFE_PUBLIC_DOMAIN_RE.test(host)) return false;
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localhost")
  ) {
    return false;
  }
  return true;
}

const MAILTO_RE = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24})/i;
const CF_CHALLENGE_RE =
  /Just a moment\.\.\.|cf-browser-verification|Attention Required! \| Cloudflare/i;

export const withPaidVendorBudgetEffect = Effect.fn(
  "withPaidVendorBudgetEffect"
)(function* <A, E>(
  budget: {
    vendor: string;
    monthlyCapCents: number;
    spentThisMonthCents: number;
    requestedCents: number;
  },
  effect: Effect.Effect<A, E>
): Effect.fn.Return<A, E | VendorBudgetExceededError> {
  if (budget.requestedCents < 0) {
    return yield* new VendorBudgetExceededError(budget);
  }
  if (
    budget.spentThisMonthCents + budget.requestedCents >
    budget.monthlyCapCents
  ) {
    return yield* new VendorBudgetExceededError(budget);
  }
  return yield* effect;
});

export const pullSourceEffect = Effect.fn("pullSourceEffect")(function* (
  source: MerchantSourceRow,
  env?: Record<string, string | undefined>,
  options?: { limit?: number; offset?: number; extraWhere?: string }
): Effect.fn.Return<
  { candidates: MerchantCandidate[]; newCursor: string | null },
  CollectorSourceError
> {
  return yield* Effect.tryPromise({
    try: () => pullSource(source, env, options),
    catch: (err) =>
      new CollectorSourceError({
        sourceId: source.id,
        kind: source.kind,
        message: err instanceof Error ? err.message : String(err),
      }),
  }).pipe(
    Effect.retry(
      Schedule.max([
        Schedule.exponential("100 millis"),
        Schedule.recurs(1),
      ]).pipe(
        Schedule.setInputType<CollectorSourceError>(),
        Schedule.while(({ input }) => !input.message.includes("unsupported"))
      )
    )
  );
});

/**
 * 3-step HTML waterfall using Effect.firstSuccessOf:
 * 1) Direct Worker fetch (2.5s)
 * 2) Mac mini Scrapling stealth fetch (4s) when direct fetch is 403/429/Cloudflare-challenged
 * 3) Mac mini Firecrawl headless browser scrape (6s)
 */
export const fetchHtmlWaterfallEffect = Effect.fnUntraced(function* (
  pageUrl: string,
  options?: {
    timeoutMs?: number;
    scraplingBaseUrl?: string;
    firecrawlBaseUrl?: string;
  }
): Effect.fn.Return<
  { html: string; tier: "direct" | "scrapling" | "firecrawl" },
  HtmlFetchError
> {
  const timeoutMs = options?.timeoutMs ?? 2500;

  const directStep = Effect.tryPromise({
    try: async () => {
      const res = await fetch(pageUrl, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; PileLeadBot/1.0)",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const text = (await res.text()).slice(0, 65_536);
      if (!text.trim() || CF_CHALLENGE_RE.test(text)) {
        throw new Error("empty or cloudflare-challenged html");
      }
      return { html: text, tier: "direct" as const };
    },
    catch: (err) =>
      new HtmlFetchError({
        tier: "direct",
        url: pageUrl,
        message: err instanceof Error ? err.message : String(err),
      }),
  });

  const steps: Array<
    Effect.Effect<
      { html: string; tier: "direct" | "scrapling" | "firecrawl" },
      HtmlFetchError
    >
  > = [directStep];

  if (options?.scraplingBaseUrl) {
    const base = options.scraplingBaseUrl.replace(/\/$/, "");
    steps.push(
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(`${base}/fetch`, {
            method: "POST",
            signal: AbortSignal.timeout(Math.max(timeoutMs, 4000)),
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: pageUrl }),
          });
          if (!res.ok) throw new Error(`scrapling ${res.status}`);
          const body = (await res.json()) as {
            html?: string;
            content?: string;
          };
          const text = (body.html ?? body.content ?? "").slice(0, 65_536);
          if (!text.trim()) throw new Error("scrapling empty body");
          return { html: text, tier: "scrapling" as const };
        },
        catch: (err) =>
          new HtmlFetchError({
            tier: "scrapling",
            url: pageUrl,
            message: err instanceof Error ? err.message : String(err),
          }),
      })
    );
  }

  if (options?.firecrawlBaseUrl) {
    const base = options.firecrawlBaseUrl.replace(/\/$/, "");
    steps.push(
      Effect.tryPromise({
        try: async () => {
          const res = await fetch(`${base}/v1/scrape`, {
            method: "POST",
            signal: AbortSignal.timeout(Math.max(timeoutMs, 5000)),
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: pageUrl, formats: ["html"] }),
          });
          if (!res.ok) throw new Error(`firecrawl ${res.status}`);
          const body = (await res.json()) as {
            data?: { html?: string; markdown?: string };
          };
          const text = (body.data?.html ?? body.data?.markdown ?? "").slice(
            0,
            65_536
          );
          if (!text.trim()) throw new Error("firecrawl empty body");
          return { html: text, tier: "firecrawl" as const };
        },
        catch: (err) =>
          new HtmlFetchError({
            tier: "firecrawl",
            url: pageUrl,
            message: err instanceof Error ? err.message : String(err),
          }),
      })
    );
  }

  return yield* Effect.firstSuccessOf(steps);
});

/**
 * Promoted from VTX-692 Detective discovery:
 * In NYC DOB (t8hj-ruu2), an ELECTRICAL FIRM at `license_sl_no = N` has `first_name = null`,
 * while its paired qualifying Master Electrician (`ELECTRICAL CONTRACTOR`) is at `license_sl_no = N + 1` (or `N - 1`).
 * Resolves all missing ELECTRICAL FIRM owners in ONE batched Socrata query.
 */
export const resolveDobPairedElectriciansEffect = Effect.fn(
  "resolveDobPairedElectriciansEffect"
)(function* (
  candidates: ReadonlyArray<MerchantCandidate>,
  timeoutMs = 2500
): Effect.fn.Return<Map<string, string>> {
  const slToExternalId = new Map<string, string>();
  const querySlNos: string[] = [];

  for (const cand of candidates) {
    if (cand.ownerName) continue;
    const m = /^socrata:t8hj-ruu2:(\d+)$/.exec(cand.externalId);
    if (!m) continue;
    const sl = Number(m[1]);
    if (!Number.isFinite(sl)) continue;
    const nextSl = String(sl + 1);
    slToExternalId.set(nextSl, cand.externalId);
    querySlNos.push(`'${nextSl}'`);
  }

  if (querySlNos.length === 0) {
    return new Map<string, string>();
  }

  return yield* Effect.tryPromise({
    try: async () => {
      const params = new URLSearchParams({
        $where: `license_sl_no IN (${querySlNos.join(",")}) AND license_type='ELECTRICAL CONTRACTOR' AND first_name IS NOT NULL`,
        $limit: String(querySlNos.length),
      });
      const res = await fetch(
        `https://data.cityofnewyork.us/resource/t8hj-ruu2.json?${params}`,
        { signal: AbortSignal.timeout(timeoutMs) }
      );
      if (!res.ok) return new Map<string, string>();
      const rows = (await res.json()) as Array<{
        license_sl_no?: string;
        first_name?: string;
        last_name?: string;
      }>;
      const out = new Map<string, string>();
      for (const r of rows) {
        const sl = r.license_sl_no;
        const extId = sl ? slToExternalId.get(sl) : undefined;
        const fullName = [r.first_name, r.last_name]
          .filter(Boolean)
          .join(" ")
          .trim();
        if (extId && fullName && !out.has(extId)) {
          out.set(extId, fullName);
        }
      }
      return out;
    },
    catch: () => new Map<string, string>(),
  }).pipe(Effect.catch(() => Effect.succeed(new Map<string, string>())));
});

/**
 * Promoted from VTX-692 Detective discovery:
 * Queries NY Department of State Active Corporations (`data.ny.gov/resource/n9v6-gdp6.json`)
 * to resolve `dosId` and `dosFilingDate`.
 */
export const lookupNyDosEntityEffect = Effect.fnUntraced(function* (
  businessName: string,
  timeoutMs = 2000
): Effect.fn.Return<{
  dosId: string | null;
  dosFilingDate: string | null;
  dosProcessName: string | null;
}> {
  const cleaned = businessName
    .toUpperCase()
    .replace(/[^A-Z0-9 &]/g, " ")
    .replace(/\b(INC|LLC|CORP|CORPORATION|LTD|CO)\b/g, "")
    .trim()
    .slice(0, 32);
  if (cleaned.length < 4) {
    return { dosId: null, dosFilingDate: null, dosProcessName: null };
  }
  return yield* Effect.tryPromise({
    try: async () => {
      const params = new URLSearchParams({
        $where: `upper(current_entity_name) like '${cleaned}%'`,
        $limit: "1",
      });
      const res = await fetch(
        `https://data.ny.gov/resource/n9v6-gdp6.json?${params}`,
        { signal: AbortSignal.timeout(timeoutMs) }
      );
      if (!res.ok) {
        return { dosId: null, dosFilingDate: null, dosProcessName: null };
      }
      const rows = (await res.json()) as Array<{
        dos_id?: string;
        initial_dos_filing_date?: string;
        dos_process_name?: string;
      }>;
      const top = rows[0];
      return {
        dosId: top?.dos_id ?? null,
        dosFilingDate: top?.initial_dos_filing_date ?? null,
        dosProcessName: top?.dos_process_name ?? null,
      };
    },
    catch: () => ({ dosId: null, dosFilingDate: null, dosProcessName: null }),
  }).pipe(
    Effect.catch(() =>
      Effect.succeed({ dosId: null, dosFilingDate: null, dosProcessName: null })
    )
  );
});

export const probeCandidateWebsiteEffect = Effect.fnUntraced(function* (
  cand: MerchantCandidate,
  options?: {
    timeoutMs?: number;
    scraplingBaseUrl?: string;
    firecrawlBaseUrl?: string;
    lookupDos?: boolean;
  }
): Effect.fn.Return<EnrichedMerchantCandidate> {
  const timeoutMs = options?.timeoutMs ?? 2500;

  const websiteTask = isSafePublicDomain(cand.domain)
    ? fetchHtmlWaterfallEffect(
        `https://${cand.domain.trim().toLowerCase()}`,
        options
      ).pipe(Effect.catch(() => Effect.succeed(null)))
    : Effect.succeed(null);

  const dosTask = options?.lookupDos
    ? lookupNyDosEntityEffect(cand.name, timeoutMs)
    : Effect.succeed({
        dosId: null,
        dosFilingDate: null,
        dosProcessName: null,
      });

  const [fetched, dos] = yield* Effect.all([websiteTask, dosTask], {
    concurrency: 2,
  });

  if (!fetched || !fetched.html) {
    return {
      ...cand,
      posGuess: null,
      posEvidenceUrl: null,
      dosId: dos.dosId,
      dosFilingDate: dos.dosFilingDate,
      scrapeTier: null,
    };
  }

  const pageUrl = `https://${cand.domain!.trim().toLowerCase()}`;
  const tech = detectPosTechnographics({
    merchantId: cand.externalId,
    pageUrl,
    html: fetched.html,
  });
  const mailtoMatch = !cand.email ? MAILTO_RE.exec(fetched.html) : null;
  const discoveredEmail = mailtoMatch?.[1]?.toLowerCase() ?? null;
  return {
    ...cand,
    email: cand.email ?? discoveredEmail,
    posGuess: tech.posGuess,
    posEvidenceUrl: tech.posGuess ? pageUrl : null,
    dosId: dos.dosId,
    dosFilingDate: dos.dosFilingDate,
    scrapeTier: fetched.tier,
  };
});

export const enrichCandidatesWithEffect = Effect.fn(
  "enrichCandidatesWithEffect"
)(function* (
  candidates: ReadonlyArray<MerchantCandidate>,
  options?: {
    concurrency?: number;
    timeoutMs?: number;
    scraplingBaseUrl?: string;
    firecrawlBaseUrl?: string;
    lookupDos?: boolean;
  }
): Effect.fn.Return<EnrichedMerchantCandidate[]> {
  const concurrency = Math.max(1, Math.min(10, options?.concurrency ?? 6));
  const pairedOwners = yield* resolveDobPairedElectriciansEffect(
    candidates,
    options?.timeoutMs ?? 2500
  );
  const withPairedOwners = candidates.map((cand) => ({
    ...cand,
    ownerName: cand.ownerName ?? pairedOwners.get(cand.externalId) ?? null,
  }));
  return yield* Effect.forEach(
    withPairedOwners,
    (cand) => probeCandidateWebsiteEffect(cand, options),
    { concurrency }
  );
});

/**
 * #1: Mac mini scraper HTTP wrapper with exponential backoff retry on transient
 * 502/503/504 Cloudflare Tunnel blips, failing fast on 4xx client errors.
 */
export const runMacMiniFetchWithRetryEffect = Effect.fn(
  "runMacMiniFetchWithRetryEffect"
)(function* (input: {
  tier: string;
  url: string;
  init: RequestInit;
  timeoutMs?: number;
}): Effect.fn.Return<Response, HtmlFetchError> {
  return yield* Effect.tryPromise({
    try: async () => {
      const res = await fetch(input.url, {
        ...input.init,
        signal: AbortSignal.timeout(input.timeoutMs ?? 8000),
      });
      if (!res.ok) {
        const retryable =
          res.status === 429 ||
          res.status === 502 ||
          res.status === 503 ||
          res.status === 504;
        const err = new Error(
          `${input.tier} failed: ${res.status}`
        ) as Error & {
          retryable?: boolean;
        };
        err.retryable = retryable;
        throw err;
      }
      return res;
    },
    catch: (err) => {
      const retryable =
        typeof (err as { retryable?: boolean })?.retryable === "boolean"
          ? Boolean((err as { retryable?: boolean }).retryable)
          : true;
      return new HtmlFetchError({
        tier: input.tier,
        url: input.url,
        message: err instanceof Error ? err.message : String(err),
        retryable,
      });
    },
  }).pipe(
    Effect.retry(
      Schedule.max([
        Schedule.exponential("150 millis"),
        Schedule.recurs(2),
      ]).pipe(
        Schedule.setInputType<HtmlFetchError>(),
        Schedule.while(({ input: err }) => Boolean(err.retryable))
      )
    )
  );
});

/**
 * #2: Compute backend failover via Effect.catch (`primary -> fallback`).
 */
export const withFailoverEffect = Effect.fn("withFailoverEffect")(function* <
  A,
>(input: {
  operation: string;
  primaryName: string;
  fallbackName: string;
  primary: () => Promise<A>;
  fallback: () => Promise<A>;
  onSwitch?: (error: ComputeBackendError) => void;
}): Effect.fn.Return<A, ComputeBackendError> {
  return yield* Effect.tryPromise({
    try: () => input.primary(),
    catch: (err) =>
      new ComputeBackendError({
        backend: input.primaryName,
        operation: input.operation,
        message: err instanceof Error ? err.message : String(err),
      }),
  }).pipe(
    Effect.catch((primaryErr) => {
      input.onSwitch?.(primaryErr);
      return Effect.tryPromise({
        try: () => input.fallback(),
        catch: (fallbackErr) =>
          new ComputeBackendError({
            backend: input.fallbackName,
            operation: input.operation,
            message:
              fallbackErr instanceof Error
                ? fallbackErr.message
                : String(fallbackErr),
          }),
      });
    })
  );
});

/**
 * #3: Outbox / sweep batch runner using Effect.partition with bounded concurrency.
 */
export const partitionTasksWithEffect = Effect.fn("partitionTasksWithEffect")(
  function* <Item, Out>(
    items: ReadonlyArray<Item>,
    runItem: (item: Item) => Promise<Out>,
    options?: { concurrency?: number }
  ): Effect.fn.Return<{
    failures: Array<{ message: string }>;
    successes: Out[];
  }> {
    const concurrency = Math.max(1, Math.min(10, options?.concurrency ?? 4));
    const [successes, failures] = yield* Effect.partition(
      items,
      (item) =>
        Effect.tryPromise({
          try: () => runItem(item),
          catch: (err) => ({
            message: err instanceof Error ? err.message : String(err),
          }),
        }),
      { concurrency }
    );
    return { failures, successes };
  }
);

/**
 * #4: Batch Approval & Send-Gate Partition Runner (`Effect.partition`).
 * Separates a batch of leads awaiting approval into `{ approved, blocked }`.
 */
export interface BatchApproveCandidate {
  customerId: string;
  name: string;
  channel: TouchChannel;
  contactEmail?: string | null;
  phone?: string | null;
  address?: string | null;
  emailStatus?: EmailVerificationStatus;
  allowUnverified?: boolean;
  suppressedCustomer?: boolean;
  suppressedDomain?: boolean;
  suppressedEmail?: boolean;
}

export const evaluateApprovedBatchWithEffect = Effect.fn(
  "evaluateApprovedBatchWithEffect"
)(function* (
  candidates: ReadonlyArray<BatchApproveCandidate>,
  options?: { concurrency?: number }
): Effect.fn.Return<{
  approved: Array<{
    customerId: string;
    name: string;
    channel: TouchChannel;
    recipient: string | null;
  }>;
  blocked: Array<{
    customerId: string;
    name: string;
    reasons: ReadonlyArray<string>;
  }>;
}> {
  const concurrency = Math.max(1, Math.min(10, options?.concurrency ?? 5));
  const [approved, blockedErrors] = yield* Effect.partition(
    candidates,
    (cand) =>
      Effect.gen(function* () {
        const nowIso = new Date().toISOString();
        const gate = evaluateSendGate({
          touchId: `approve_${cand.customerId}`,
          channel: cand.channel,
          action: "engage",
          now: nowIso,
          merchant: {
            id: cand.customerId,
            permissions: {
              doNotContact:
                Boolean(cand.suppressedCustomer) ||
                Boolean(cand.suppressedDomain),
            },
          },
          contact: {
            id: cand.contactEmail ?? `contact_${cand.customerId}`,
            email: cand.contactEmail ?? null,
            permissions: {
              doNotEmail: Boolean(cand.suppressedEmail),
              emailStatus:
                cand.emailStatus ?? (cand.contactEmail ? "valid" : "unknown"),
            },
          },
          cadence: {
            allowUnverified: cand.allowUnverified ?? true,
            concurrency: "allowed",
          },
        });
        if (gate.result !== "pass") {
          return yield* new SendGateBlockedError({
            customerId: cand.customerId,
            name: cand.name,
            reasons: [...gate.reasons],
          });
        }
        return {
          customerId: cand.customerId,
          name: cand.name,
          channel: cand.channel,
          recipient: cand.contactEmail ?? cand.phone ?? cand.address ?? null,
        };
      }),
    { concurrency }
  );

  return {
    approved,
    blocked: blockedErrors.map((b) => ({
      customerId: b.customerId,
      name: b.name,
      reasons: b.reasons,
    })),
  };
});
