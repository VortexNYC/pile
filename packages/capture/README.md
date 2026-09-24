# @vortex-api/capture

Pile support-capture SDK. Follows the Jam/crikket model: instrumentation installs at `init()` and continuously buffers console output, errors, network activity, user actions, and navigation — so a report submitted _after_ a bug still includes what happened. Uploads go through Pile's `/support/capture/*` protocol and finalize into a support ticket.

## One-tag embed

The fastest install — one script tag, no bundler:

```html
<script
  src="https://pile.nyc/capture.js"
  data-pile-key="pil_…"
  data-pile-widget="true"
  data-pile-replay="true"
></script>
```

That's it: capture is live with a floating "Report a bug" button. Attributes: `data-pile-key` (public key) or `data-pile-link` (recording-link token), `data-pile-widget`, `data-pile-replay`, `data-pile-endpoint`, `data-pile-lookback`. The instance is exposed as `window.pileCapture` — e.g. `pileCapture.report({email, title})` from the console or your own UI.

Recording links need no embed at all: `POST /workspaces/{org}/support/capture-links` → hand out `https://pile.nyc/cap/{token}` — or drive the same protocol headlessly with `initCapture({linkToken})`.

## Programmatic install

```ts
import { initCapture } from "@vortex-api/capture";

const capture = initCapture({ publicKey: "pil_…" });
// … the user does things; the buffer records the last 60s …

// One-shot report (primary flow — bug already happened):
const { ticketId, shareUrl } = await capture.report({
  email: "reporter@example.com",
  title: "Checkout is broken",
  screenshot: "auto", // or pass a Blob, or omit
});

// Explicit session with screen recording:
await capture.start({ video: true }); // prompts for the tab
await capture.stop({ email: "reporter@example.com", title: "…" });
```

## What it captures

- Console (`log`/`info`/`warn`/`error`/`debug`) with deep serialization
- Uncaught errors and unhandled rejections
- `fetch` and `XMLHttpRequest` — method, URL, status, duration, sanitized headers, text bodies, per-request timing phases (`dns`, `connect`, `tls`, `ttfb`, `download` via `PerformanceResourceTiming`), and GraphQL annotations (`operationName`, `operationType`, `hasErrors` — including `errors[]` in HTTP 200 responses)
- `WebSocket` — open/close/send/message with text previews and binary lengths
- User actions — click, input (value _length_ only), change, submit, Enter/Escape
- Navigation breadcrumbs — initial load, pushState/replaceState, popstate, hashchange
- DOM session replay via rrweb — deterministic, no permission prompt; produces a self-contained `replay.html` artifact that plays back when the artifact URL is opened
- Device/browser metadata, viewport, connection info

All network capture is sanitized: sensitive headers (`authorization`, `cookie`, tokens…) are dropped, sensitive query params and body fields become `[REDACTED]`, and binary payloads are recorded as compact placeholders (`[binary: N bytes]`) rather than contents. The debugger payload is gzipped via `CompressionStream` when available.

## Options

| Option             | Default            | Notes                                                                               |
| ------------------ | ------------------ | ----------------------------------------------------------------------------------- |
| `publicKey`        | —                  | Required. Issued via `POST /workspaces/{org}/support/capture/public-keys`.          |
| `endpoint`         | `https://pile.nyc` | API origin.                                                                         |
| `reference`        | —                  | Caller-side reference echoed on the session.                                        |
| `lookbackMs`       | `60000`            | How much buffered history a report/session includes.                                |
| `video`            | `false`            | Screen recording for `start()`/`stop()` sessions.                                   |
| `replay`           | `false`            | DOM session replay via rrweb (lazy-loaded; no prompt).                              |
| `replayMaskInputs` | `true`             | Mask input values in the DOM replay.                                                |
| `blurSelectors`    | —                  | Extra selectors blocked from replay — string, array, or `() => string \| string[]`. |
| `networkBodies`    | `true`             | Capture sanitized text request/response bodies.                                     |

Replay always honors the standard privacy markup — `[data-pile-blur]`, `[data-jam-blur]`, FullStory `.fs-exclude`/`.fs-block`/`.fs-mask`, Hotjar `[data-hj-suppress]`/`[data-hj-masked]`, LogRocket `[data-private]`, Sentry `.sentry-block`/`.sentry-mask`, Clarity `[data-clarity-mask]`, Highlight `.highlight-*`, OpenReplay `[data-openreplay-*]`, Heap `[data-heap-redact]`, ContentSquare `[data-cs-*]`, Matomo `[data-matomo-mask]` — plus card/identity autocomplete attributes (`cc-number`, `cc-csc`, `tel`, `email`) and SSN/card/routing/passport name patterns. A replay event-rate circuit breaker stops recording if the page floods the recorder (live dashboards, tickers) so the host app is never degraded.

`capture.metadata(fn)` registers a callback evaluated at submission time — Jam-style live app state:

```ts
capture.metadata(() => ({
  userId: currentUser.id,
  featureFlags: flags.snapshot(),
}));
```

Callbacks merge into report metadata; a throwing callback never loses a report, and explicit `report({ metadata })` wins on conflicts.

`capture.attach(blob, "name.json")` queues an extra artifact for the next submission. `capture.destroy()` removes all instrumentation.

The SDK also runs in non-DOM environments (Node, workers): DOM-dependent capture degrades gracefully and the same protocol calls work.

## Headless / automation environments

Agents running in sandboxes (Daytona, Cloudflare Containers, CI) have no display surface, so `getDisplayMedia`-backed features — `screenshot: "auto"`, `capture.screenshot()`, `video: true` — are unavailable there. Everything else works: console/network/action capture, error tracking, and **DOM replay** (rrweb needs a DOM, not a display — it is the right "video" for automation).

For stills and video, the contract is: **whoever runs the browser provides the media** — attach it as an artifact:

```ts
// Playwright / Puppeteer / CDP harness
const capture = initCapture({ publicKey, replay: true });
// ... run the flow ...
const png = await page.screenshot({ type: "png" });
capture.attach(
  new Blob([png], { type: "image/png" }),
  "harness-screenshot.png"
);
await capture.report({ email: "agent@team.com", title: "agent hit a bug" });
```

`context.recordVideo()` output can be attached the same way (`video/*.webm` → `video` artifact). Verified end-to-end in `pnpm test:e2e`, which drives a real headless Chromium page and asserts the harness screenshot arrives as a `screenshot` artifact.
