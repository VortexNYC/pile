import { MAX_RECENT_EVENT_AGE_MS } from "./constants.js";

interface RrwebEvent {
  type: number;
  data: unknown;
  timestamp: number;
}

interface RrwebModule {
  record: (options: {
    emit: (event: RrwebEvent) => void;
    maskAllInputs?: boolean;
    blockClass?: string;
    blockSelector?: string | null;
    maskTextSelector?: string | null;
    sampling?: Record<string, unknown>;
  }) => (() => void) | undefined;
}

const MAX_REPLAY_EVENTS = 10_000;
// Jam-style heavy-site guard: sustained event floods mean the page is too
// dynamic for replay to stay cheap — trip the breaker instead of
// degrading the host app.
const REPLAY_RATE_WINDOW_MS = 5_000;
const REPLAY_RATE_LIMIT = 1_500;

/**
 * Industry-standard privacy selectors (Jam auto-blur parity): elements
 * fully blocked from replay. rrweb's own `.rr-block`/`.rr-ignore` are
 * built in via blockClass/ignoreClass.
 */
const DEFAULT_BLOCK_SELECTOR = [
  "[data-pile-blur]",
  "[data-jam-blur]",
  ".fs-exclude",
  ".fs-block",
  "[data-hj-suppress]",
  "[data-private]",
  ".sentry-block",
  "[data-sentry-block]",
  ".highlight-block",
  ".highlight-ignore",
  "[data-openreplay-hidden]",
  "[data-heap-redact]",
].join(", ");

/**
 * Industry-standard text-masking selectors plus sensitive-input patterns
 * (autocomplete hints, SSN/card/license naming).
 */
const DEFAULT_MASK_SELECTOR = [
  ".fs-mask",
  "[data-hj-masked]",
  ".sentry-mask",
  "[data-sentry-mask]",
  "[data-clarity-mask]",
  ".highlight-mask",
  "[data-openreplay-obscured]",
  "[data-cs-mask]",
  "[data-cs-encrypt]",
  "[data-matomo-mask]",
  'input[autocomplete="cc-number"]',
  'input[autocomplete="cc-exp"]',
  'input[autocomplete="cc-csc"]',
  'input[autocomplete="cc-month"]',
  'input[autocomplete="cc-year"]',
  'input[autocomplete="tel"]',
  'input[autocomplete="email"]',
  'input[name*="ssn" i]',
  'input[id*="ssn" i]',
  'input[name*="social" i]',
  'input[name*="creditcard" i]',
  'input[name*="credit-card" i]',
  'input[name*="cardnumber" i]',
  'input[name*="card-number" i]',
  'input[name*="routing" i]',
  'input[name*="bankaccount" i]',
  'input[name*="license" i]',
  'input[name*="passport" i]',
].join(", ");
const REPLAYER_CDN =
  "https://cdn.jsdelivr.net/npm/rrweb@2.1.4/dist/rrweb.min.js";
const REPLAYER_CSS_CDN =
  "https://cdn.jsdelivr.net/npm/rrweb@2.1.4/dist/rrweb.min.css";

export interface ReplayRecorder {
  stop(): void;
  /** Snapshot of buffered rrweb events within `lookbackMs`. */
  snapshot(lookbackMs: number): RrwebEvent[];
  readonly active: boolean;
  /** True when the perf circuit breaker disabled recording mid-session. */
  readonly degraded: boolean;
}

const resolveCustomSelectors = (
  blurSelectors?: string | string[] | (() => string | string[])
): string[] => {
  const value =
    typeof blurSelectors === "function" ? blurSelectors() : blurSelectors;
  if (!value) {
    return [];
  }
  return (Array.isArray(value) ? value : [value]).filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0
  );
};

/**
 * Starts an always-on rrweb recorder. Events land in a bounded ring buffer
 * so a report submitted later includes the DOM session leading up to it.
 * Inputs are masked by default and industry-standard privacy selectors are
 * honored — privacy on by default like Jam. A rate-limit circuit breaker
 * disables recording on heavy pages rather than degrading the host app.
 */
export async function startDomRecording(options?: {
  maskAllInputs?: boolean;
  blurSelectors?: string | string[] | (() => string | string[]);
}): Promise<ReplayRecorder> {
  const events: RrwebEvent[] = [];
  const emitTimes: number[] = [];
  let stopped = false;
  let degraded = false;
  let stop: (() => void) | undefined;

  const customSelectors = resolveCustomSelectors(options?.blurSelectors);
  const blockSelector =
    customSelectors.length > 0
      ? `${DEFAULT_BLOCK_SELECTOR}, ${customSelectors.join(", ")}`
      : DEFAULT_BLOCK_SELECTOR;

  const rrweb = (await import("rrweb")) as unknown as RrwebModule;
  stop = rrweb.record({
    emit(event) {
      if (stopped) {
        return;
      }
      const now = Date.now();
      emitTimes.push(now);
      while (
        emitTimes.length > 0 &&
        now - emitTimes[0]! > REPLAY_RATE_WINDOW_MS
      ) {
        emitTimes.shift();
      }
      if (emitTimes.length > REPLAY_RATE_LIMIT) {
        degraded = true;
        stopped = true;
        events.length = 0;
        stop?.();
        return;
      }
      events.push(event);
      const cutoff = now - MAX_RECENT_EVENT_AGE_MS * 5;
      while (events.length > 0 && events[0]!.timestamp < cutoff) {
        events.shift();
      }
      if (events.length > MAX_REPLAY_EVENTS) {
        events.splice(0, events.length - MAX_REPLAY_EVENTS);
      }
    },
    maskAllInputs: options?.maskAllInputs !== false,
    blockClass: "pile-capture-block",
    blockSelector,
    maskTextSelector: DEFAULT_MASK_SELECTOR,
  });

  return {
    get active() {
      return !stopped;
    },
    get degraded() {
      return degraded;
    },
    stop() {
      stopped = true;
      stop?.();
    },
    snapshot(lookbackMs) {
      const cutoff = Date.now() - lookbackMs;
      return events.filter((event) => event.timestamp >= cutoff);
    },
  };
}

/**
 * Builds a self-contained HTML player embedding the recorded rrweb events.
 * The player loads rrweb's Replayer from a pinned CDN, so opening the
 * artifact URL replays the session with zero Pile frontend required.
 */
export function buildReplayHtml(events: RrwebEvent[], title: string): Blob {
  const serialized = JSON.stringify(events).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — session replay</title>
<link rel="stylesheet" href="${REPLAYER_CSS_CDN}" />
<style>
  html, body { margin: 0; height: 100%; background: #0a0a0a; }
  #player { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .replayer-wrapper { border: 1px solid #333; }
</style>
</head>
<body>
<div id="player"></div>
<script src="${REPLAYER_CDN}"></script>
<script>
  const events = ${serialized};
  new rrweb.Replayer(events, {
    root: document.getElementById("player"),
    speed: 1,
    skipInactive: true,
    showWarning: false,
  }).play();
</script>
</body>
</html>`;
  return new Blob([html], { type: "text/html" });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
