import { Effect, Schedule, Schema } from "effect";

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

export interface EnrichedMerchantCandidate extends MerchantCandidate {
  posGuess?: string | null;
  posEvidenceUrl?: string | null;
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

export const probeCandidateWebsiteEffect = Effect.fnUntraced(function* (
  cand: MerchantCandidate,
  timeoutMs = 2500
): Effect.fn.Return<EnrichedMerchantCandidate> {
  if (!isSafePublicDomain(cand.domain)) {
    return { ...cand, posGuess: null, posEvidenceUrl: null };
  }
  const pageUrl = `https://${cand.domain.trim().toLowerCase()}`;
  const html = yield* Effect.tryPromise({
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
      if (!res.ok) return "";
      const text = await res.text();
      return text.slice(0, 65_536);
    },
    catch: () => "",
  }).pipe(Effect.catch(() => Effect.succeed("")));

  if (!html) {
    return { ...cand, posGuess: null, posEvidenceUrl: null };
  }
  const tech = detectPosTechnographics({
    merchantId: cand.externalId,
    pageUrl,
    html,
  });
  const mailtoMatch = !cand.email ? MAILTO_RE.exec(html) : null;
  const discoveredEmail = mailtoMatch?.[1]?.toLowerCase() ?? null;
  return {
    ...cand,
    email: cand.email ?? discoveredEmail,
    posGuess: tech.posGuess,
    posEvidenceUrl: tech.posGuess ? pageUrl : null,
  };
});

export const enrichCandidatesWithEffect = Effect.fn(
  "enrichCandidatesWithEffect"
)(function* (
  candidates: ReadonlyArray<MerchantCandidate>,
  options?: { concurrency?: number; timeoutMs?: number }
): Effect.fn.Return<EnrichedMerchantCandidate[]> {
  const concurrency = Math.max(1, Math.min(10, options?.concurrency ?? 6));
  const timeoutMs = options?.timeoutMs ?? 2500;
  return yield* Effect.forEach(
    candidates,
    (cand) => probeCandidateWebsiteEffect(cand, timeoutMs),
    { concurrency }
  );
});
