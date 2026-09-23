# @vortex-api/capture

Pile support-capture SDK. Follows the Jam/crikket model: instrumentation installs at `init()` and continuously buffers console output, errors, network activity, user actions, and navigation — so a report submitted _after_ a bug still includes what happened. Uploads go through Pile's `/support/capture/*` protocol and finalize into a support ticket.

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
- `fetch` and `XMLHttpRequest` — method, URL, status, duration, sanitized headers, text bodies
- User actions — click, input (value _length_ only), change, submit, Enter/Escape
- Navigation breadcrumbs — initial load, pushState/replaceState, popstate, hashchange
- Device/browser metadata, viewport, connection info

All network capture is sanitized: sensitive headers (`authorization`, `cookie`, tokens…) are dropped, sensitive query params and body fields become `[REDACTED]`. The debugger payload is gzipped via `CompressionStream` when available.

## Options

| Option          | Default            | Notes                                                                      |
| --------------- | ------------------ | -------------------------------------------------------------------------- |
| `publicKey`     | —                  | Required. Issued via `POST /workspaces/{org}/support/capture/public-keys`. |
| `endpoint`      | `https://pile.nyc` | API origin.                                                                |
| `reference`     | —                  | Caller-side reference echoed on the session.                               |
| `lookbackMs`    | `60000`            | How much buffered history a report/session includes.                       |
| `video`         | `false`            | Screen recording for `start()`/`stop()` sessions.                          |
| `networkBodies` | `true`             | Capture sanitized text request/response bodies.                            |

`capture.attach(blob, "name.json")` queues an extra artifact for the next submission. `capture.destroy()` removes all instrumentation.

The SDK also runs in non-DOM environments (Node, workers): DOM-dependent capture degrades gracefully and the same protocol calls work.
