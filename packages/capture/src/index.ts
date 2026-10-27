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

/**
 * PILE-665/675 submission options layered on the base init options.
 * `streamParts` streams MediaRecorder chunks into an R2 multipart upload
 * while recording; `includeDomReplay` attaches the raw rrweb event stream
 * as replay.json; `includeNetworkBodies` pins whether text request and
 * response bodies are captured.
 */
export interface CaptureStreamingOptions {
  streamParts?: boolean;
  includeDomReplay?: boolean;
  includeNetworkBodies?: boolean;
}

export type PileCaptureInitOptions = CaptureInitOptions &
  CaptureStreamingOptions;

/** State for a recording streamed through R2 multipart parts. */
interface StreamedUpload {
  token: string;
  sessionId: string;
  uploadId: string;
  partUploadUrl: string;
  /** Normal one-shot upload URL kept as a fallback if a part fails. */
  videoUploadUrl: string | null;
  shareUrl?: string;
  recordingUrl: string;
  buffered: Blob[];
  bufferedBytes: number;
  nextPart: number;
  failed: boolean;
  uploads: Promise<void>[];
}

// R2 requires every non-final multipart part to be at least 5 MiB, so
// MediaRecorder's 1s chunks are coalesced until they clear the floor.
const STREAM_PART_MIN_BYTES = 5 * 1024 * 1024;
const ABSOLUTE_HTTP_URL = /^https?:\/\//;

interface ActiveSession {
  recording: RecordingController | null;
  artifacts: CaptureArtifact[];
  streamed: StreamedUpload | null;
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

export function initCapture(options: PileCaptureInitOptions): Capture {
  if (!options.publicKey && !options.linkToken) {
    throw new Error("initCapture requires publicKey or linkToken");
  }
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const lookbackMs = options.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  // PILE-675 — `includeNetworkBodies` is the explicit opt-in/out; it falls
  // back to the legacy `networkBodies` flag and defaults to on.
  const captureNetworkBodies =
    options.includeNetworkBodies ?? options.networkBodies ?? true;
  const recorder = new EventRecorder();
  // Instrumentation is always-on from init — this is what lets a later
  // report include the bug that already happened.
  const instrumentation: Instrumentation = installInstrumentation(recorder, {
    networkBodies: captureNetworkBodies !== false,
    excludeUrlPrefixes: [`${endpoint}/support/capture`],
  });
  const pendingArtifacts: CaptureArtifact[] = [];
  const metadataCallbacks: Array<() => Record<string, unknown>> = [];
  let active: ActiveSession | null = null;
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
  if (options.replay || options.includeDomReplay) {
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
        // PILE-675 — the raw rrweb event stream alongside the self-contained
        // HTML player, so agents/triage can replay or diff deterministically.
        if (options.includeDomReplay) {
          artifacts.push({
            attachmentType: "replay",
            fileName: "replay.json",
            blob: new Blob([JSON.stringify(replayEvents)], {
              type: "application/json",
            }),
          });
        }
      }
    }
    return artifacts;
  };

  const buildSubmissionMetadata = (
    stopOptions: CaptureReportOptions
  ): Record<string, unknown> => {
    const metadata: Record<string, unknown> = {
      email: stopOptions.email,
      ...(stopOptions.fullName ? { fullName: stopOptions.fullName } : {}),
      // PILE-675 — the body-retention intent rides the submission so the
      // server keeps (or strips) network bodies accordingly.
      includeNetworkBodies: captureNetworkBodies,
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
    return metadata;
  };

  const submit = async (
    stopOptions: CaptureReportOptions,
    snapshot: ReturnType<EventRecorder["getRecentSnapshot"]>,
    extras: CaptureArtifact[]
  ): Promise<CaptureResult> => {
    const artifacts = await buildArtifacts(snapshot, extras);
    const metadata = buildSubmissionMetadata(stopOptions);
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

  /**
   * PILE-665 — mint the capture session + R2 multipart upload up front so
   * MediaRecorder chunks stream in as parts while recording, and the share
   * link is known before the first frame lands.
   */
  const mintStreamedSession = async (): Promise<StreamedUpload> => {
    const tokenRes = await fetch(`${endpoint}/support/capture/token`, {
      method: "POST",
      headers: {
        ...(options.linkToken
          ? { "x-pile-capture-link": options.linkToken }
          : { "x-pile-capture-public-key": options.publicKey ?? "" }),
        ...(options.reference
          ? { "x-pile-capture-reference": options.reference }
          : {}),
      },
      credentials: "omit",
      mode: "cors",
    });
    if (!tokenRes.ok) {
      throw new Error(`capture token failed: ${tokenRes.status}`);
    }
    const { token, recordingUrl } = (await tokenRes.json()) as {
      token: string;
      recordingUrl: string;
    };

    const sessionRes = await fetch(
      `${endpoint}/support/capture/upload-session`,
      {
        method: "POST",
        headers: {
          "x-pile-capture-token": token,
          "content-type": "application/json",
        },
        credentials: "omit",
        mode: "cors",
        body: JSON.stringify({
          title: "Bug report",
          multipart: true,
          artifacts: [
            {
              attachmentType: "video",
              fileName: "recording.webm",
              contentType: "video/webm",
            },
          ],
        }),
      }
    );
    if (!sessionRes.ok) {
      throw new Error(`upload-session failed: ${sessionRes.status}`);
    }
    const payload = (await sessionRes.json()) as {
      sessionId: string;
      uploadId?: string;
      partUploadUrl?: string;
      shareUrl?: string;
      uploads?: { uploadUrl: string; attachmentType: string }[];
    };
    if (!payload.uploadId || !payload.partUploadUrl) {
      throw new Error("multipart upload was not offered by the server");
    }
    return {
      token,
      sessionId: payload.sessionId,
      uploadId: payload.uploadId,
      partUploadUrl: payload.partUploadUrl,
      videoUploadUrl:
        payload.uploads?.find((u) => u.attachmentType === "video")?.uploadUrl ??
        null,
      shareUrl: payload.shareUrl,
      recordingUrl,
      buffered: [],
      bufferedBytes: 0,
      nextPart: 1,
      failed: false,
      uploads: [],
    };
  };

  const flushStreamedPart = (streamed: StreamedUpload): void => {
    if (streamed.bufferedBytes === 0) return;
    const body =
      streamed.buffered.length === 1
        ? streamed.buffered[0]!
        : new Blob(streamed.buffered, {
            type: streamed.buffered[0]!.type || "video/webm",
          });
    streamed.buffered = [];
    streamed.bufferedBytes = 0;
    const partNumber = streamed.nextPart;
    streamed.nextPart += 1;
    const separator = streamed.partUploadUrl.includes("?") ? "&" : "?";
    const relative = `${streamed.partUploadUrl}${separator}partNumber=${partNumber}&uploadId=${encodeURIComponent(
      streamed.uploadId
    )}`;
    const url = ABSOLUTE_HTTP_URL.test(relative)
      ? relative
      : `${endpoint}${relative}`;
    streamed.uploads.push(
      fetch(url, {
        method: "PUT",
        headers: {
          "x-pile-capture-token": streamed.token,
          "content-type": body.type || "video/webm",
        },
        credentials: "omit",
        mode: "cors",
        body,
      })
        .then((res) => {
          if (!res.ok) streamed.failed = true;
        })
        .catch(() => {
          streamed.failed = true;
        })
    );
  };

  const queueStreamedChunk = (streamed: StreamedUpload, chunk: Blob): void => {
    streamed.buffered.push(chunk);
    streamed.bufferedBytes += chunk.size;
    if (streamed.bufferedBytes >= STREAM_PART_MIN_BYTES) {
      flushStreamedPart(streamed);
    }
  };

  /**
   * PILE-665 — finalize a streamed session: the video is already in R2 as
   * multipart parts (or fell back to the one-shot upload when a part
   * failed); the remaining artifacts go through the standard protocol on
   * the same session, then finalize completes the upload server-side.
   */
  const submitStreamed = async (
    stopOptions: CaptureReportOptions,
    snapshot: ReturnType<EventRecorder["getRecentSnapshot"]>,
    extras: CaptureArtifact[],
    streamed: StreamedUpload,
    videoBlob: Blob | null
  ): Promise<CaptureResult> => {
    flushStreamedPart(streamed);
    await Promise.all(streamed.uploads);

    const headers = { "x-pile-capture-token": streamed.token };

    // If any part failed (or nothing streamed), fall back to the normal
    // one-shot upload for the video and clear the server-side multipart
    // state so finalize does not complete a partial object.
    const streamFailed =
      streamed.failed || (streamed.nextPart === 1 && videoBlob === null);
    if (streamFailed) {
      await fetch(`${endpoint}/support/capture/metadata`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        credentials: "omit",
        mode: "cors",
        body: JSON.stringify({
          metadata: {
            multipartUploadId: null,
            multipartObjectKey: null,
            multipartParts: [],
          },
        }),
      });
      if (videoBlob && streamed.videoUploadUrl) {
        const uploadUrl = ABSOLUTE_HTTP_URL.test(streamed.videoUploadUrl)
          ? streamed.videoUploadUrl
          : `${endpoint}${streamed.videoUploadUrl}`;
        const uploadRes = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": videoBlob.type || "video/webm",
          },
          credentials: "omit",
          mode: "cors",
          body: videoBlob,
        });
        if (!uploadRes.ok) {
          throw new Error(`artifact upload failed: ${uploadRes.status}`);
        }
      }
    }

    const artifacts = await buildArtifacts(snapshot, extras);
    const metadata = buildSubmissionMetadata(stopOptions);

    // Declare the remaining (non-video) artifacts on the same session —
    // the video record already exists from the streamed upload-session.
    const sessionRes = await fetch(
      `${endpoint}/support/capture/upload-session`,
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        credentials: "omit",
        mode: "cors",
        body: JSON.stringify({
          title: stopOptions.title ?? "Bug report",
          description: stopOptions.description,
          priority: stopOptions.priority,
          tags: stopOptions.tags,
          url: stopOptions.url,
          visibility: stopOptions.visibility,
          includeNetworkBodies: captureNetworkBodies,
          metadata,
          deviceInfo: collectDeviceInfo(),
          artifacts: artifacts.map((artifact) => ({
            attachmentType: artifact.attachmentType,
            fileName: artifact.fileName,
            contentType: artifact.blob.type || undefined,
          })),
        }),
      }
    );
    if (!sessionRes.ok) {
      throw new Error(`upload-session failed: ${sessionRes.status}`);
    }
    const sessionPayload = (await sessionRes.json()) as {
      uploads?: { uploadUrl: string }[];
    };
    const declaredUploads = sessionPayload.uploads ?? [];

    await Promise.all(
      artifacts.map(async (artifact, index) => {
        const target = declaredUploads[index];
        if (!target) {
          throw new Error("upload-session did not declare all artifacts");
        }
        const uploadUrl = ABSOLUTE_HTTP_URL.test(target.uploadUrl)
          ? target.uploadUrl
          : `${endpoint}${target.uploadUrl}`;
        const uploadResponse = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            ...headers,
            "content-type": artifact.blob.type || "application/octet-stream",
            ...(artifact.contentEncoding
              ? { "content-encoding": artifact.contentEncoding }
              : {}),
          },
          credentials: "omit",
          mode: "cors",
          body: artifact.blob,
        });
        if (!uploadResponse.ok) {
          throw new Error(`artifact upload failed: ${uploadResponse.status}`);
        }
      })
    );

    const finalizeRes = await fetch(`${endpoint}/support/capture/finalize`, {
      method: "POST",
      headers,
      credentials: "omit",
      mode: "cors",
    });
    if (!finalizeRes.ok) {
      throw new Error(`finalize failed: ${finalizeRes.status}`);
    }
    const finalized = (await finalizeRes.json()) as {
      ticketId: string;
      shareUrl?: string;
    };
    return {
      ticketId: finalized.ticketId,
      shareUrl: finalized.shareUrl ?? streamed.shareUrl,
      recordingUrl: streamed.recordingUrl,
    };
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
      let streamed: StreamedUpload | null = null;
      if (startOptions?.video ?? options.video) {
        // PILE-665 — mint the multipart session first so chunks stream as
        // parts while recording; failure falls back to one-shot upload.
        if (options.streamParts) {
          streamed = await mintStreamedSession().catch(() => null);
        }
        const activeStream = streamed;
        recording = await startDisplayRecording(
          activeStream
            ? {
                onChunk: (chunk) => {
                  queueStreamedChunk(activeStream, chunk);
                },
              }
            : undefined
        );
        recorder.markRecordingStarted(recording.startedAt);
      }
      if (
        startOptions?.replay ??
        (options.replay === true || options.includeDomReplay === true)
      ) {
        await ensureReplay().catch(() => null);
      }
      active = { recording, artifacts: [], streamed };
      void session;
    },

    async stop(stopOptions) {
      if (!active) {
        throw new Error("capture not started");
      }
      const session = active;
      active = null;
      const extras = [...session.artifacts];
      let streamedBlob: Blob | null = null;
      if (session.recording) {
        try {
          const { blob, durationMs } = await session.recording.stop();
          // Streamed recordings are already in R2 as multipart parts —
          // only the fallback path needs the assembled blob.
          if (session.streamed) {
            streamedBlob = blob;
          } else {
            extras.push({
              attachmentType: "video",
              fileName: "recording.webm",
              blob,
            });
          }
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
      if (!snapshot) {
        throw new Error("capture session missing");
      }
      if (session.streamed) {
        return submitStreamed(
          stopOptions,
          snapshot,
          extras,
          session.streamed,
          streamedBlob
        );
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
    streamParts: script.dataset.pileStreamParts === "true",
    includeDomReplay: script.dataset.pileDomReplay === "true",
    includeNetworkBodies:
      script.dataset.pileNetworkBodies === "false" ? false : undefined,
    lookbackMs:
      Number.isFinite(lookback) && lookback > 0 ? lookback : undefined,
  });
  (globalThis as { pileCapture?: Capture }).pileCapture = capture;
  if (script.dataset.pileWidget === "true") {
    capture.mount();
  }
}

autoInitFromScriptTag();
