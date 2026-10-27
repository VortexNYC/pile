/** Jam-parity event capture for the member feedback bubble. Reuses the
 * capture SDK's instrumentation engine (console, errors, click/key/nav
 * trail, network waterfall — the same collectors that power the
 * one-tag capture script) and keeps a session-long rolling buffer, so a
 * report includes what already happened, not what happens next.
 *
 * Network capture is shallow by default (method/url/status/duration —
 * no request/response bodies): the console's own API traffic is
 * high-volume, and cloning every response for body capture would tax
 * every screen. The reporter can opt in to body capture (PILE-675) —
 * the collectors re-install at that point so subsequent requests carry
 * sanitized bodies. Auth headers and sensitive query params are still
 * redacted upstream by the SDK's sanitizer. */

import {
  installInstrumentation,
  type Instrumentation,
} from "../../../../packages/capture/src/engine/instrument.js";
import {
  buildDebuggerSubmissionPayload,
  EventRecorder,
  type CaptureSession,
} from "../../../../packages/capture/src/engine/recorder.js";
import {
  assertBrowserTabSurface,
  prepareCaptureVideo,
  releaseCaptureVideo,
  requestDisplayStream,
  resolveRecordingMimeType,
  type RecordingController,
} from "../../../../packages/capture/src/media.js";
import type { DebuggerEvent } from "../../../../packages/capture/src/types.js";

/** Whole-session buffer — the SDK's own recent-events ring only keeps
 * 60s, but a member may file feedback minutes after the bug. */
const MAX_BUFFERED_EVENTS = 800;
const MAX_CONSOLE_ENTRIES = 200;
const MAX_NETWORK_ENTRIES = 300;
const MAX_USER_EVENTS = 25;
const MAX_ERRORS = 50;
/** Cap-style long-form recording: full multi-minute walkthroughs, not
 * just a 15s instant replay. */
export const MAX_RECORDING_MS = 300_000;
const RECORDING_AUDIO_BITS_PER_SECOND = 64_000;
const RECORDING_VIDEO_BITS_PER_SECOND = 550_000;

interface CaptureState {
  events: DebuggerEvent[];
  recorder: EventRecorder;
  instrumentation: Instrumentation;
}

let state: CaptureState | null = null;
const captureOptions = { includeNetworkBodies: false };
/** Epoch ms the attached recording started — mirrors into the feedback
 * snapshot so the capture viewer can anchor every event timestamp to
 * video t=0 (Cap-style timestamp-anchored triage). */
let recordingAnchorMs: number | null = null;

export interface FeedbackCaptureOptions {
  /** PILE-675 — opt-in request/response body capture for the network
   * waterfall. Off by default; when enabled the collectors re-install
   * so requests after the toggle carry sanitized bodies + headers. */
  includeNetworkBodies?: boolean;
}

/** Install the always-on collectors once — safe to call repeatedly and
 * in non-DOM contexts (tests, SSR), where it no-ops. Option changes on
 * repeat calls route through the post-install updater so the collectors
 * re-install at the new capture depth. */
export function installFeedbackCapture(options?: FeedbackCaptureOptions): void {
  if (state || typeof window === "undefined") {
    if (state && options) setFeedbackCaptureOptions(options);
    return;
  }
  if (options?.includeNetworkBodies !== undefined) {
    captureOptions.includeNetworkBodies = options.includeNetworkBodies;
  }
  const events: DebuggerEvent[] = [];
  const recorder = new EventRecorder();
  const originalPush = recorder.push.bind(recorder);
  recorder.push = (event: DebuggerEvent) => {
    events.push(event);
    if (events.length > MAX_BUFFERED_EVENTS) events.shift();
    originalPush(event);
  };
  const instrumentation = installInstrumentation(recorder, {
    networkBodies: captureOptions.includeNetworkBodies,
  });
  state = { events, recorder, instrumentation };
}

/** Update capture options after install. The network-bodies opt-in
 * (PILE-675) re-installs the collectors so requests after the toggle
 * are captured at the new depth — earlier buffer entries keep the
 * shallow shape they were recorded with. */
export function setFeedbackCaptureOptions(
  options: FeedbackCaptureOptions
): void {
  const next =
    options.includeNetworkBodies ?? captureOptions.includeNetworkBodies;
  const changed = next !== captureOptions.includeNetworkBodies;
  captureOptions.includeNetworkBodies = next;
  if (!state || !changed) return;
  state.instrumentation.dispose();
  state.instrumentation = installInstrumentation(state.recorder, {
    networkBodies: next,
  });
}

/** Set/clear the recording anchor that lands on the feedback payload —
 * the bubble sets it when a clip is attached and clears it when the
 * member removes the clip. */
export function setRecordingAnchorMs(ms: number | null): void {
  recordingAnchorMs = ms;
}

/** Test hook — module state persists across tests in a file. */
export function resetFeedbackCaptureForTests(): void {
  state?.instrumentation.dispose();
  state = null;
  captureOptions.includeNetworkBodies = false;
  recordingAnchorMs = null;
}

export interface FeedbackConsoleLog {
  level: string;
  message: string;
  timestamp: string;
}

export interface FeedbackNetworkRequest {
  method: string;
  url: string;
  status?: number;
  duration?: number;
  timestamp: string;
  /** PILE-675 opt-in — sanitized bodies/headers, present only when the
   * reporter enabled body capture before the request ran. */
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
}

export interface FeedbackUserEvent {
  type: string;
  target?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface FeedbackError {
  message: string;
  stack?: string;
  source?: string;
  timestamp: string;
}

export interface FeedbackCaptureSnapshot {
  consoleLogs: FeedbackConsoleLog[];
  networkRequests: FeedbackNetworkRequest[];
  userEvents: FeedbackUserEvent[];
  errors: FeedbackError[];
  /** Epoch ms the attached recording started (`null` when none is
   * attached) — the capture viewer anchors event timestamps to it so a
   * `mm:ss` offset seeks straight to that moment in the video. */
  recordingStartedAtMs: number | null;
}

export interface FeedbackSnapshotOptions {
  /** PILE-675 — include sanitized request/response bodies + headers in
   * the network waterfall. Only meaningful for events captured while
   * body instrumentation was installed. */
  includeNetworkBodies?: boolean;
  /** Epoch ms the attached recording started — becomes the offset anchor
   * the SDK bakes into each event, so offsets line up with video t=0. */
  recordingStartedAtMs?: number | null;
}

/** Map a raw DebuggerEvent buffer into the neutral shapes the feedback
 * endpoint accepts (the server re-shapes them into the Jam-style
 * console-logs.json / network-requests.json / user-events.json
 * artifacts the capture viewers read). Pure — directly testable. */
export function snapshotToFeedbackEvents(
  events: DebuggerEvent[],
  options?: FeedbackSnapshotOptions
): FeedbackCaptureSnapshot {
  const includeNetworkBodies = options?.includeNetworkBodies ?? false;
  const session: CaptureSession = {
    sessionId: "feedback",
    startedAt: Date.now(),
    recordingStartedAt: options?.recordingStartedAtMs ?? null,
    events: [...events],
  };
  const payload = buildDebuggerSubmissionPayload(session);
  const networkRequests = payload.networkRequests
    .slice(-MAX_NETWORK_ENTRIES)
    .map((request) => {
      const entry: FeedbackNetworkRequest = {
        method: request.method,
        url: request.url,
        timestamp: request.timestamp,
      };
      if (request.status !== undefined) entry.status = request.status;
      if (request.duration !== undefined) entry.duration = request.duration;
      if (includeNetworkBodies) {
        if (request.requestHeaders) {
          entry.requestHeaders = request.requestHeaders;
        }
        if (request.responseHeaders) {
          entry.responseHeaders = request.responseHeaders;
        }
        if (request.requestBody) entry.requestBody = request.requestBody;
        if (request.responseBody) entry.responseBody = request.responseBody;
      }
      return entry;
    });
  const userEvents = payload.actions.slice(-MAX_USER_EVENTS).map((action) => {
    const entry: FeedbackUserEvent = {
      type: action.type,
      timestamp: action.timestamp,
    };
    if (action.target !== undefined) entry.target = action.target;
    if (action.metadata) entry.metadata = action.metadata;
    return entry;
  });
  const errors = payload.errors.slice(-MAX_ERRORS).map((error) => {
    const entry: FeedbackError = {
      message: error.message,
      timestamp: error.timestamp,
    };
    if (error.stack !== undefined) entry.stack = error.stack;
    if (error.source !== undefined) entry.source = error.source;
    return entry;
  });
  return {
    consoleLogs: payload.logs.slice(-MAX_CONSOLE_ENTRIES).map((log) => ({
      level: log.level,
      message: log.message,
      timestamp: log.timestamp,
    })),
    networkRequests,
    userEvents,
    errors,
    recordingStartedAtMs: options?.recordingStartedAtMs ?? null,
  };
}

/** Snapshot the rolling buffer as feedback body fields. Empty arrays
 * when capture was never installed. */
export function feedbackCaptureSnapshot(): FeedbackCaptureSnapshot {
  return snapshotToFeedbackEvents(state?.events ?? [], {
    includeNetworkBodies: captureOptions.includeNetworkBodies,
    recordingStartedAtMs: recordingAnchorMs,
  });
}

/** Merge the reporter's mic with whatever audio the tab share already
 * carries. Display + mic tracks can't both feed a single MediaRecorder
 * audio channel directly, so they mix down through an AudioContext
 * destination — the combined track rides the recording stream. */
function mergeMicrophoneTrack(
  displayStream: MediaStream,
  micStream: MediaStream
): { stream: MediaStream; cleanup: () => void } {
  const AudioContextImpl =
    typeof AudioContext !== "undefined"
      ? AudioContext
      : (globalThis as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
  if (!AudioContextImpl) {
    // No mixer in this engine — stack the tracks and let MediaRecorder
    // pick the first audio track rather than dropping the mic entirely.
    return {
      stream: new MediaStream([
        ...displayStream.getTracks(),
        ...micStream.getAudioTracks(),
      ]),
      cleanup: () => {},
    };
  }
  const context = new AudioContextImpl();
  const destination = context.createMediaStreamDestination();
  if (displayStream.getAudioTracks().length > 0) {
    context.createMediaStreamSource(displayStream).connect(destination);
  }
  context.createMediaStreamSource(micStream).connect(destination);
  return {
    stream: new MediaStream([
      ...displayStream.getVideoTracks(),
      ...destination.stream.getAudioTracks(),
    ]),
    cleanup: () => {
      if (context.state !== "closed") {
        void context.close().catch(() => undefined);
      }
    },
  };
}

/** Display-stream recorder like the SDK's `startDisplayRecording`, but
 * built on a possibly mic-merged stream so the MediaRecorder picks up
 * the combined audio. Stops mic tracks and closes the AudioContext when
 * the recorder stops. */
async function startCaptureRecording(options?: {
  includeMic?: boolean;
}): Promise<RecordingController> {
  const displayStream = await requestDisplayStream(true);
  assertBrowserTabSurface(displayStream);

  let micStream: MediaStream | null = null;
  if (
    options?.includeMic &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  ) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
    } catch {
      // Mic denied or unavailable — the clip still records with whatever
      // audio the tab share carries.
      micStream = null;
    }
  }

  let mergeCleanup: (() => void) | null = null;
  let recordingStream = displayStream;
  if (micStream) {
    const merged = mergeMicrophoneTrack(displayStream, micStream);
    recordingStream = merged.stream;
    mergeCleanup = merged.cleanup;
  }

  const stopAll = () => {
    for (const track of displayStream.getTracks()) {
      track.stop();
    }
    if (micStream) {
      for (const track of micStream.getTracks()) {
        track.stop();
      }
    }
    for (const track of recordingStream.getTracks()) {
      track.stop();
    }
    mergeCleanup?.();
  };

  const warmupVideo = document.createElement("video");
  try {
    await prepareCaptureVideo(warmupVideo, displayStream);
  } catch (error) {
    releaseCaptureVideo(warmupVideo);
    stopAll();
    throw error;
  }
  releaseCaptureVideo(warmupVideo);

  const mimeType = resolveRecordingMimeType();
  const recorderOptions: MediaRecorderOptions =
    mimeType.length > 0
      ? {
          audioBitsPerSecond: RECORDING_AUDIO_BITS_PER_SECOND,
          mimeType,
          videoBitsPerSecond: RECORDING_VIDEO_BITS_PER_SECOND,
        }
      : {
          audioBitsPerSecond: RECORDING_AUDIO_BITS_PER_SECOND,
          videoBitsPerSecond: RECORDING_VIDEO_BITS_PER_SECOND,
        };
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(recordingStream, recorderOptions);
  } catch (error) {
    stopAll();
    throw error;
  }
  const startedAt = Date.now();
  const chunks: Blob[] = [];

  let resolveStop:
    | ((value: { blob: Blob; durationMs: number }) => void)
    | null = null;
  let rejectStop: ((reason?: unknown) => void) | null = null;
  const stopPromise = new Promise<{ blob: Blob; durationMs: number }>(
    (resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    }
  );

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  });
  recorder.addEventListener(
    "stop",
    () => {
      stopAll();
      resolveStop?.({
        blob: new Blob(chunks, { type: mimeType || "video/webm" }),
        durationMs: Date.now() - startedAt,
      });
    },
    { once: true }
  );
  recorder.addEventListener(
    "error",
    (event) => {
      stopAll();
      rejectStop?.(event);
    },
    { once: true }
  );
  displayStream.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
  });

  recorder.start(1000);
  return {
    startedAt,
    stream: recordingStream,
    stop: () => {
      if (recorder.state === "inactive") {
        return stopPromise;
      }
      recorder.stop();
      return stopPromise;
    },
  };
}

export interface TabRecordingOptions {
  /** Fold the reporter's microphone into the clip (Cap-style voiceover).
   * The permission prompt fires after the tab picker; a denial still
   * records with tab audio only. */
  includeMic?: boolean;
  /** Recording ceiling — defaults to MAX_RECORDING_MS (5 minutes). */
  maxDurationMs?: number;
}

export interface ScreenClip {
  blob: Blob;
  durationMs: number;
  /** Epoch ms MediaRecorder started — aligns console/network/click
   * timestamps to video t=0 for timestamp-anchored triage. */
  recordingStartedAtMs: number | null;
}

/** Record a screen clip (Jam's instant replay, explicit-share edition —
 * Cap-style long-form + mic): the browser tab picker prompts, then
 * MediaRecorder rolls for up to `maxDurationMs` — stopping early if the
 * member ends the share. */
export async function startTabRecording(
  options?: TabRecordingOptions
): Promise<ScreenClip> {
  const controller = await startCaptureRecording({
    includeMic: options?.includeMic,
  });
  const track = controller.stream.getVideoTracks()[0];
  await new Promise<void>((resolve) => {
    const timer = setTimeout(
      resolve,
      options?.maxDurationMs ?? MAX_RECORDING_MS
    );
    track?.addEventListener(
      "ended",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
  const result = await controller.stop();
  // Anchor the capture buffer to video t=0 — the feedback payload then
  // carries `recordingStartedAtMs` so the ticket's capture panel can
  // seek straight to the moment each console/network/click entry fired.
  recordingAnchorMs = controller.startedAt;
  return { ...result, recordingStartedAtMs: controller.startedAt };
}

export function canRecordScreenClip(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () =>
      reject(reader.error ?? new Error("Failed to read recording"))
    );
    reader.readAsDataURL(blob);
  });
}
