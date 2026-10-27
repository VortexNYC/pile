/** Jam-parity event capture for the member feedback bubble. Reuses the
 * capture SDK's instrumentation engine (console, errors, click/key/nav
 * trail, shallow network waterfall — the same collectors that power the
 * one-tag capture script) and keeps a session-long rolling buffer, so a
 * report includes what already happened, not what happens next.
 *
 * Network capture is deliberately shallow (method/url/status/duration —
 * no request/response bodies): the console's own API traffic is
 * high-volume, and cloning every response for body capture would tax
 * every screen. Auth headers and sensitive query params are still
 * redacted upstream by the SDK's sanitizer. */

import { installInstrumentation } from "../../../../packages/capture/src/engine/instrument.js";
import {
  buildDebuggerSubmissionPayload,
  EventRecorder,
  type CaptureSession,
} from "../../../../packages/capture/src/engine/recorder.js";
import { startDisplayRecording } from "../../../../packages/capture/src/media.js";
import type { DebuggerEvent } from "../../../../packages/capture/src/types.js";

/** Whole-session buffer — the SDK's own recent-events ring only keeps
 * 60s, but a member may file feedback minutes after the bug. */
const MAX_BUFFERED_EVENTS = 800;
const MAX_CONSOLE_ENTRIES = 200;
const MAX_NETWORK_ENTRIES = 300;
const MAX_USER_EVENTS = 25;
const MAX_ERRORS = 50;
export const MAX_RECORDING_MS = 15_000;

interface CaptureState {
  events: DebuggerEvent[];
}

let state: CaptureState | null = null;

/** Install the always-on collectors once — safe to call repeatedly and
 * in non-DOM contexts (tests, SSR), where it no-ops. */
export function installFeedbackCapture(): void {
  if (state || typeof window === "undefined") return;
  const events: DebuggerEvent[] = [];
  const recorder = new EventRecorder();
  const originalPush = recorder.push.bind(recorder);
  recorder.push = (event: DebuggerEvent) => {
    events.push(event);
    if (events.length > MAX_BUFFERED_EVENTS) events.shift();
    originalPush(event);
  };
  installInstrumentation(recorder, { networkBodies: false });
  state = { events };
}

/** Test hook — module state persists across tests in a file. */
export function resetFeedbackCaptureForTests(): void {
  state = null;
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
}

/** Map a raw DebuggerEvent buffer into the neutral shapes the feedback
 * endpoint accepts (the server re-shapes them into the Jam-style
 * console-logs.json / network-requests.json / user-events.json
 * artifacts the capture viewers read). Pure — directly testable. */
export function snapshotToFeedbackEvents(
  events: DebuggerEvent[]
): FeedbackCaptureSnapshot {
  const session: CaptureSession = {
    sessionId: "feedback",
    startedAt: Date.now(),
    recordingStartedAt: null,
    events: [...events],
  };
  const payload = buildDebuggerSubmissionPayload(session);
  return {
    consoleLogs: payload.logs.slice(-MAX_CONSOLE_ENTRIES).map((log) => ({
      level: log.level,
      message: log.message,
      timestamp: log.timestamp,
    })),
    networkRequests: payload.networkRequests
      .slice(-MAX_NETWORK_ENTRIES)
      .map((request) => ({
        method: request.method,
        url: request.url,
        ...(request.status !== undefined ? { status: request.status } : {}),
        ...(request.duration !== undefined
          ? { duration: request.duration }
          : {}),
        timestamp: request.timestamp,
      })),
    userEvents: payload.actions.slice(-MAX_USER_EVENTS).map((action) => ({
      type: action.type,
      ...(action.target !== undefined ? { target: action.target } : {}),
      timestamp: action.timestamp,
      ...(action.metadata ? { metadata: action.metadata } : {}),
    })),
    errors: payload.errors.slice(-MAX_ERRORS).map((error) => ({
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
      ...(error.source !== undefined ? { source: error.source } : {}),
      timestamp: error.timestamp,
    })),
  };
}

/** Snapshot the rolling buffer as feedback body fields. Empty arrays
 * when capture was never installed. */
export function feedbackCaptureSnapshot(): FeedbackCaptureSnapshot {
  return snapshotToFeedbackEvents(state?.events ?? []);
}

/** Record a short screen clip (Jam's instant replay, explicit-share
 * edition): the browser tab picker prompts, then MediaRecorder rolls
 * for up to `maxMs` — stopping early if the member ends the share. */
export async function recordScreenClip(
  maxMs = MAX_RECORDING_MS
): Promise<{ blob: Blob; durationMs: number }> {
  const controller = await startDisplayRecording();
  const track = controller.stream.getVideoTracks()[0];
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, maxMs);
    track?.addEventListener(
      "ended",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
  return controller.stop();
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
