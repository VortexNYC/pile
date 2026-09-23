# @vortex-api/capture

Pile support-capture SDK. Records console output, errors, network activity, click breadcrumbs, device metadata, an optional screenshot, and optional screen video — then files a support ticket in a Pile workspace through the public `/support/capture/*` protocol.

```ts
import { initCapture } from "@vortex-api/capture";

const capture = initCapture({ publicKey: "pk_…" });

await capture.start();          // begin recording
// … user reproduces the bug …
const { ticketId, shareUrl } = await capture.stop({
  email: "reporter@example.com", // required — identifies the reporter
  title: "Checkout is broken",
  priority: "high",
});
```

## Options

| Option | Default | Notes |
| --- | --- | --- |
| `publicKey` | — | Required. Issued per workspace via `POST /workspaces/{org}/support/capture/public-keys`. |
| `endpoint` | `https://pile.nyc` | API origin. |
| `reference` | — | Caller-side reference echoed on the session. |
| `video` | `false` | Screen recording via `getDisplayMedia` + `MediaRecorder` (user consent prompt). |
| `networkBodies` | `false` | Include truncated request bodies in the network log. |
| `maxEntries` | `500` | Ring-buffer size for console/network/breadcrumb entries. |

## Extra artifacts

```ts
capture.screenshot(blob);          // → screenshot artifact
capture.attach(blob, "name.json"); // → debugger_json artifact (or pass a type)
```

Artifacts map to the server's `attachmentType` enum: `screenshot`, `video`, `debugger_json`, `log`, `network`.
