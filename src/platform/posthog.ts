// PostHog telemetry for the Pile Worker — $exception capture on 5xx route
// faults plus structured fleet events (sweep heartbeat, lane settlement).
// Modeled after Veil's worker reporter: a single non-blocking POST via
// waitUntil, no secrets/PII on the wire, gated to production (or explicit
// test override) so unit tests and local dev never pollute PostHog.

const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/capture/";
export const PILE_POSTHOG_PROJECT_KEY =
  "phc_ts2JiKlSqvEC0Cjt68HFUkg3mZnY6CG57QkguxWmn5Y";

export interface WaitUntilContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface PosthogEnvLike {
  BETTER_AUTH_URL?: string;
  PUBLIC_API_URL?: string;
  POSTHOG_PROJECT_KEY?: string;
}

export function isProductionTelemetryEnabled(env?: PosthogEnvLike): boolean {
  if (!env) return false;
  if (env.POSTHOG_PROJECT_KEY) return true;
  const host = env.PUBLIC_API_URL ?? env.BETTER_AUTH_URL ?? "";
  return host === "https://pile.nyc" || host === "https://app.pile.nyc";
}

export function scrubRoutePath(path: string): string {
  return path
    .replace(/(\/shared-documents\/[^/]+\/)[^/]+/g, "$1[redacted-token]")
    .replace(/\/cap\/[^/]+/g, "/cap/[redacted-token]");
}

export function capturePosthogEvent(
  event: string,
  properties: Record<string, unknown>,
  ctx?: WaitUntilContext,
  options?: {
    env?: PosthogEnvLike;
    apiKey?: string;
    fetchImpl?: typeof fetch;
  }
): void {
  try {
    const enabled =
      options?.apiKey !== undefined ||
      options?.fetchImpl !== undefined ||
      isProductionTelemetryEnabled(options?.env);
    if (!enabled) return;
    const apiKey =
      options?.apiKey ??
      options?.env?.POSTHOG_PROJECT_KEY ??
      PILE_POSTHOG_PROJECT_KEY;
    if (!apiKey) return;
    const doFetch = options?.fetchImpl ?? fetch;
    const body = JSON.stringify({
      api_key: apiKey,
      event,
      properties: {
        distinct_id:
          typeof properties.distinct_id === "string"
            ? properties.distinct_id
            : "pile-worker",
        $lib: "pile-worker",
        product: "pile",
        ...properties,
      },
    });
    const send = doFetch(POSTHOG_CAPTURE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }).catch(() => {});
    if (ctx) {
      ctx.waitUntil(send);
    }
  } catch {
    // Telemetry is strictly best-effort.
  }
}

export function reportWorkerException(
  surface: string,
  err: unknown,
  ctx?: WaitUntilContext,
  extra?: Record<string, unknown>,
  options?: {
    env?: PosthogEnvLike;
    apiKey?: string;
    fetchImpl?: typeof fetch;
  }
): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? (err.stack ?? "") : "";
  const type = err instanceof Error && err.name ? err.name : "worker_error";
  const sanitizedExtra = { ...extra };
  if (typeof sanitizedExtra.path === "string") {
    sanitizedExtra.path = scrubRoutePath(sanitizedExtra.path);
  }
  capturePosthogEvent(
    "$exception",
    {
      distinct_id: `worker-${surface}`,
      $exception_type: type,
      $exception_message: message.slice(0, 500),
      $exception_stack_trace_raw: stack.slice(0, 1200),
      $exception_list: [
        {
          type,
          value: message.slice(0, 500),
        },
      ],
      surface,
      ...sanitizedExtra,
    },
    ctx,
    options
  );
}
