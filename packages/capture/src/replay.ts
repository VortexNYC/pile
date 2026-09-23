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
    sampling?: Record<string, unknown>;
  }) => (() => void) | undefined;
}

const MAX_REPLAY_EVENTS = 10_000;
const REPLAYER_CDN =
  "https://cdn.jsdelivr.net/npm/rrweb@2.1.4/dist/rrweb.min.js";
const REPLAYER_CSS_CDN =
  "https://cdn.jsdelivr.net/npm/rrweb@2.1.4/dist/rrweb.min.css";

export interface ReplayRecorder {
  stop(): void;
  /** Snapshot of buffered rrweb events within `lookbackMs`. */
  snapshot(lookbackMs: number): RrwebEvent[];
  readonly active: boolean;
}

/**
 * Starts an always-on rrweb recorder. Events land in a bounded ring buffer
 * so a report submitted later includes the DOM session leading up to it.
 * Inputs are masked by default — privacy on by default like Jam.
 */
export async function startDomRecording(options?: {
  maskAllInputs?: boolean;
}): Promise<ReplayRecorder> {
  const events: RrwebEvent[] = [];
  let stopped = false;

  const rrweb = (await import("rrweb")) as unknown as RrwebModule;
  const stop = rrweb.record({
    emit(event) {
      if (stopped) {
        return;
      }
      events.push(event);
      const cutoff = Date.now() - MAX_RECENT_EVENT_AGE_MS * 5;
      while (events.length > 0 && events[0]!.timestamp < cutoff) {
        events.shift();
      }
      if (events.length > MAX_REPLAY_EVENTS) {
        events.splice(0, events.length - MAX_REPLAY_EVENTS);
      }
    },
    maskAllInputs: options?.maskAllInputs !== false,
    blockClass: "pile-capture-block",
  });

  return {
    get active() {
      return !stopped;
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
