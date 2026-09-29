/**
 * Pile support-capture SDK — browser recorder posting to the existing
 * `/support/capture/*` protocol.
 *
 * Architecture follows the crikket/Jam model: instrumentation installs at
 * `init()` and continuously feeds a rolling recent-events buffer, so a bug
 * report includes what already happened — the bug comes first, the report
 * after. `start()`/`stop()` add screen recording on top for video sessions.
 */
import { DEFAULT_ENDPOINT, DEFAULT_LOOKBACK_MS } from "./constants.js";
import {
  installInstrumentation,
  type Instrumentation,
} from "./engine/instrument.js";
import {
  buildDebuggerSubmissionPayload,
  EventRecorder,
  hasDebuggerPayloadData,
} from "./engine/recorder.js";
import {
  captureScreenshot,
  startDisplayRecording,
  type RecordingController,
} from "./media.js";
import {
  buildReplayHtml,
  startDomRecording,
  type ReplayRecorder,
} from "./replay.js";
import {
  clearCaptureSession,
  loadCaptureSession,
  saveCaptureSession,
} from "./session-store.js";
import { gzipBlob, submitCaptureReport } from "./transport.js";
import type {
  CaptureArtifact,
  CaptureInitOptions,
  CaptureReportOptions,
  CaptureResult,
  CaptureStartOptions,
  CaptureStopOptions,
} from "./types.js";
import {
  type CaptureMountOptions,
  type CaptureWidgetHandle,
  mountCaptureWidget,
} from "./widget.js";

export type {
  CaptureArtifact,
  CaptureInitOptions,
  CapturePriority,
  CaptureReportOptions,
  CaptureResult,
  CaptureStartOptions,
  CaptureStopOptions,
  CaptureVisibility,
  DebuggerEvent,
} from "./types.js";
export { captureScreenshot } from "./media.js";
export type { CaptureMountOptions, CaptureWidgetHandle } from "./widget.js";

interface ActiveSession {
  recording: RecordingController | null;
  artifacts: CaptureArtifact[];
}

export interface Capture {
  /**
   * Begin an explicit session. Without options this just marks a session
   * boundary on the always-on buffer; pass `{ video: true }` to also record
   * the screen (prompts the user for the tab).
   */
  start(options?: CaptureStartOptions): Promise<void>;
  /**
   * End the session: collect artifacts, upload them in parallel, and
   * finalize into a support ticket.
   */
  stop(options: CaptureStopOptions): Promise<CaptureResult>;
  /**
   * One-shot report with no explicit session — snapshots the lookback
   * buffer, optionally takes a screenshot itself, uploads, and finalizes.
   * This is the primary Jam-style flow: bug happened, user clicks report.
   */
  report(options: CaptureReportOptions): Promise<CaptureResult>;
  /**
   * Register a live-metadata callback (Jam-style `jam.metadata()`). The
   * function is invoked at submit time, so the values are always live —
   * user IDs, feature flags, app state. Multiple registrations merge.
   * Throwing callbacks are skipped, never fatal.
   */
  metadata(fn: () => Record<string, unknown>): void;
  /** Attach an arbitrary artifact to the next submission. */
  attach(
    blob: Blob,
    fileName: string,
    attachmentType?: CaptureArtifact["attachmentType"]
  ): void;
  /** Take a screenshot of the current tab (prompts for the tab). */
  screenshot(): Promise<Blob>;
  /**
   * Mount a floating "Report a bug" launcher. The button opens a small
   * email/description form and submits via `report({screenshot: "auto"})`.
   * Returns a handle with `unmount()`.
   */
  mount(options?: CaptureMountOptions): CaptureWidgetHandle;
  /** Stop all instrumentation and discard buffered events. */
  destroy(): void;
}

const guessAttachmentType = (
  fileName: string
): CaptureArtifact["attachmentType"] => {
  if (
    fileName.endsWith(".png") ||
    fileName.endsWith(".jpg") ||
    fileName.endsWith(".webp")
  ) {
    return "screenshot";
  }
  if (fileName.endsWith(".webm") || fileName.endsWith(".mp4")) {
    return "video";
  }
  if (
    fileName.endsWith(".jsonl") ||
    fileName.endsWith(".log") ||
    fileName.endsWith(".txt")
  ) {
    return "log";
  }
  if (fileName.endsWith(".json") || fileName.endsWith(".har")) {
    return "debugger_json";
  }
  return "debugger_json";
};

const collectDeviceInfo = (): Record<string, unknown> => {
  const info: Record<string, unknown> = {};
  if (typeof navigator !== "undefined") {
    info.userAgent = navigator.userAgent;
    info.language = navigator.language;
    info.platform = navigator.platform;
    info.hardwareConcurrency = navigator.hardwareConcurrency;
    info.deviceMemory = (
      navigator as Navigator & { deviceMemory?: number }
    ).deviceMemory;
    info.maxTouchPoints = navigator.maxTouchPoints;
    info.cookiesEnabled = navigator.cookieEnabled;
    info.onLine = navigator.onLine;
    const connection = (
      navigator as Navigator & {
        connection?: {
          effectiveType?: string;
          downlink?: number;
          rtt?: number;
        };
      }
    ).connection;
    if (connection) {
      info.connection = {
        effectiveType: connection.effectiveType,
        downlink: connection.downlink,
        rtt: connection.rtt,
      };
    }
  }
  if (typeof window !== "undefined") {
    info.viewport = { width: window.innerWidth, height: window.innerHeight };
    info.screen =
      typeof screen !== "undefined"
        ? {
            width: screen.width,
            height: screen.height,
            pixelRatio: window.devicePixelRatio,
          }
        : undefined;
    info.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  if (typeof document !== "undefined") {
    info.pageTitle = document.title;
    info.pageUrl = typeof location !== "undefined" ? location.href : undefined;
  }
  return info;
};

export function initCapture(options: CaptureInitOptions): Capture {
  if (!options.publicKey && !options.linkToken) {
    throw new Error("initCapture requires publicKey or linkToken");
  }
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const recorder = new EventRecorder();
  // Instrumentation is always-on from init — this is what lets a later
  // report include the bug that already happened.
  const instrumentation: Instrumentation = installInstrumentation(recorder, {
    networkBodies: options.networkBodies !== false,
    excludeUrlPrefixes: [`${endpoint}/support/capture`],
  });
  const pendingArtifacts: CaptureArtifact[] = [];
  const metadataCallbacks: Array<() => Record<string, unknown>> = [];
  let active: ActiveSession | null = null;
  // An explicit session survives a page refresh: it is persisted on
  // pagehide and resumed here. Screen video cannot outlive the page.
  const resumed = loadCaptureSession();
  if (resumed) {
    recorder.resumeSession(resumed);
    active = { recording: null, artifacts: [] };
  }
  const persistActiveSession = () => {
    const session = recorder.getSessionSnapshot();
    if (active && session) {
      saveCaptureSession(session);
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", persistActiveSession);
  }
  // DOM replay is always-on like the event buffer: rrweb buffers events so
  // a report includes the session leading up to the bug, not after it.
  let replayRecorder: ReplayRecorder | null = null;
  let replayStarting: Promise<ReplayRecorder> | null = null;
  const ensureReplay = (): Promise<ReplayRecorder> => {
    if (replayRecorder?.active) {
      return Promise.resolve(replayRecorder);
    }
    replayStarting ??= startDomRecording({
      maskAllInputs: options.replayMaskInputs,
      blurSelectors: options.blurSelectors,
    }).then((domRecorder) => {
      replayRecorder = domRecorder;
      return domRecorder;
    });
    return replayStarting;
  };
  if (options.replay) {
    // Fire and forget — replay is best-effort and must never block init.
    void ensureReplay().catch(() => {});
  }

  const buildArtifacts = async (
    events: ReturnType<EventRecorder["getRecentSnapshot"]>,
    extras: CaptureArtifact[]
  ): Promise<CaptureArtifact[]> => {
    const artifacts: CaptureArtifact[] = [];
    const payload = buildDebuggerSubmissionPayload(events);
    if (hasDebuggerPayloadData(payload)) {
      const raw = new Blob([JSON.stringify(payload)], {
        type: "application/json",
      });
      const compressed = await gzipBlob(raw);
      artifacts.push({
        attachmentType: "debugger_json",
        fileName: compressed === raw ? "debugger.json" : "debugger.json.gz",
        blob: compressed,
        contentEncoding: compressed === raw ? undefined : "gzip",
      });
    }
    artifacts.push(...extras, ...pendingArtifacts.splice(0));

    if (replayRecorder?.active) {
      const replayEvents = replayRecorder.snapshot(lookbackMs);
      if (replayEvents.length > 0) {
        artifacts.push({
          attachmentType: "replay",
          fileName: "replay.html",
          blob: buildReplayHtml(replayEvents, "Pile session replay"),
        });
      }
    }
    return artifacts;
  };

  const submit = async (
    stopOptions: CaptureReportOptions,
    snapshot: ReturnType<EventRecorder["getRecentSnapshot"]>,
    extras: CaptureArtifact[]
  ): Promise<CaptureResult> => {
    const artifacts = await buildArtifacts(snapshot, extras);
    const metadata: Record<string, unknown> = {
      email: stopOptions.email,
      ...(stopOptions.fullName ? { fullName: stopOptions.fullName } : {}),
    };
    // Live-metadata callbacks (jam.metadata() parity): evaluated now, at
    // submit time, so the values reflect the current app state.
    for (const fn of metadataCallbacks) {
      try {
        const result = fn();
        if (result && typeof result === "object") {
          Object.assign(metadata, result);
        }
      } catch {
        // A throwing metadata callback must never lose the report.
      }
    }
    if (replayRecorder?.degraded) {
      metadata.replayDegraded = true;
    }
    Object.assign(metadata, stopOptions.metadata);
    return submitCaptureReport(
      {
        endpoint,
        publicKey: options.publicKey,
        linkToken: options.linkToken,
        reference: options.reference,
      },
      {
        title: stopOptions.title ?? "Bug report",
        description: stopOptions.description,
        priority: stopOptions.priority,
        tags: stopOptions.tags,
        url: stopOptions.url,
        visibility: stopOptions.visibility,
        email: stopOptions.email,
        fullName: stopOptions.fullName,
        metadata,
        deviceInfo: collectDeviceInfo(),
        artifacts,
      }
    );
  };

  return {
    async start(startOptions?: CaptureStartOptions) {
      if (active) {
        throw new Error("capture already started");
      }
      const session = recorder.startSession(
        startOptions?.lookbackMs ?? lookbackMs
      );
      let recording: RecordingController | null = null;
      if (startOptions?.video ?? options.video) {
        recording = await startDisplayRecording();
        recorder.markRecordingStarted(recording.startedAt);
      }
      if (startOptions?.replay ?? options.replay) {
        await ensureReplay().catch(() => null);
      }
      active = { recording, artifacts: [] };
      saveCaptureSession(session);
    },

    async stop(stopOptions) {
      if (!active) {
        throw new Error("capture not started");
      }
      const session = active;
      active = null;
      const extras = [...session.artifacts];
      if (session.recording) {
        try {
          const { blob, durationMs } = await session.recording.stop();
          extras.push({
            attachmentType: "video",
            fileName: "recording.webm",
            blob,
          });
          stopOptions = {
            ...stopOptions,
            metadata: { durationMs, ...stopOptions.metadata },
          };
        } catch {
          // Recording failure must not lose the report.
        }
      }
      const snapshot = recorder.getSessionSnapshot();
      recorder.discardSession();
      clearCaptureSession();
      if (!snapshot) {
        throw new Error("capture session missing");
      }
      return submit(stopOptions, snapshot, extras);
    },

    async report(reportOptions) {
      const extras: CaptureArtifact[] = [];
      const screenshot = reportOptions.screenshot;
      if (screenshot === "auto") {
        extras.push({
          attachmentType: "screenshot",
          fileName: "screenshot.png",
          blob: await captureScreenshot(),
        });
      } else if (screenshot instanceof Blob) {
        extras.push({
          attachmentType: "screenshot",
          fileName: "screenshot.png",
          blob: screenshot,
        });
      }
      const snapshot = recorder.getRecentSnapshot(lookbackMs);
      return submit(reportOptions, snapshot, extras);
    },

    metadata(fn) {
      metadataCallbacks.push(fn);
    },

    attach(blob, fileName, attachmentType) {
      pendingArtifacts.push({
        attachmentType: attachmentType ?? guessAttachmentType(fileName),
        fileName,
        blob,
      });
    },

    screenshot: () => captureScreenshot(),

    mount(mountOptions) {
      return mountCaptureWidget((opts) => this.report(opts), mountOptions);
    },

    destroy() {
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", persistActiveSession);
      }
      clearCaptureSession();
      instrumentation.dispose();
      replayRecorder?.stop();
      replayRecorder = null;
      active = null;
      recorder.discardSession();
      pendingArtifacts.splice(0);
    },
  };
}

/**
 * Script-tag embed — Jam-style zero-config install. Dropping
 * `<script src="https://pile.nyc/capture.js" data-pile-key="pil_…"
 * data-pile-widget></script>` on a page auto-initializes capture and mounts
 * the report widget. Attributes: `data-pile-key` (public key) or
 * `data-pile-link` (recording-link token), `data-pile-endpoint`,
 * `data-pile-replay`, `data-pile-widget`, `data-pile-lookback`. The instance
 * is exposed as `window.pileCapture` and `initCapture` stays available for
 * programmatic use.
 */
function autoInitFromScriptTag(): void {
  if (typeof document === "undefined") {
    return;
  }
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script) {
    return;
  }
  const publicKey = script.dataset.pileKey;
  const linkToken = script.dataset.pileLink;
  if (!publicKey && !linkToken) {
    return;
  }
  const lookback = Number(script.dataset.pileLookback);
  const capture = initCapture({
    publicKey,
    linkToken,
    endpoint: script.dataset.pileEndpoint,
    replay: script.dataset.pileReplay === "true",
    lookbackMs:
      Number.isFinite(lookback) && lookback > 0 ? lookback : undefined,
  });
  (globalThis as { pileCapture?: Capture }).pileCapture = capture;
  if (script.dataset.pileWidget === "true") {
    capture.mount();
  }
}

autoInitFromScriptTag();
