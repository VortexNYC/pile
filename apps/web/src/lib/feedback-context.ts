/** Auto-captured context for the member feedback bubble. Event capture
 * (console trail, window errors, click/key/nav events, shallow network
 * waterfall) lives in feedback-capture.ts on top of the capture SDK's
 * instrumentation; this module keeps the pure payload builder plus the
 * screenshot helpers. The server turns the submission into the same
 * Jam-style capture artifacts (console-logs.json, network-requests.json,
 * user-events.json, debugger.json, metadata, frames) the ticket
 * viewers read. */

import {
  feedbackCaptureSnapshot,
  type FeedbackConsoleLog,
  type FeedbackError,
  type FeedbackNetworkRequest,
  type FeedbackUserEvent,
} from "@/lib/feedback-capture";

export type FeedbackKind = "bug" | "feature" | "other";

export interface CapturedConsoleError {
  level: string;
  message: string;
  timestamp: string;
}

export interface FeedbackBody {
  kind: FeedbackKind;
  title: string;
  description: string;
  url?: string;
  userAgent?: string;
  viewport?: { width: number; height: number };
  deviceInfo?: Record<string, unknown>;
  consoleErrors?: CapturedConsoleError[];
  consoleLogs?: FeedbackConsoleLog[];
  networkRequests?: FeedbackNetworkRequest[];
  userEvents?: FeedbackUserEvent[];
  errors?: FeedbackError[];
  screenshotDataUrl?: string;
  recordingDataUrl?: string;
}

export function collectDeviceInfo(): Record<string, unknown> {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return {};
  }
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    platform: navigator.platform,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    screen: {
      width: window.screen?.width ?? null,
      height: window.screen?.height ?? null,
    },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    online: navigator.onLine,
  };
}

/** Shape the POST body for /workspaces/{org}/support/feedback — form
 * fields plus whatever context the browser exposes right now: the
 * instrumentation snapshot (console trail, network waterfall, click/key
 * events, errors) plus device info and any attached media. */
export function buildFeedbackBody(input: {
  kind: FeedbackKind;
  title: string;
  description: string;
  screenshotDataUrl?: string;
  recordingDataUrl?: string;
}): FeedbackBody {
  const win = typeof window === "undefined" ? undefined : window;
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const snapshot = feedbackCaptureSnapshot();
  return {
    kind: input.kind,
    title: input.title.trim(),
    description: input.description.trim(),
    ...(win ? { url: win.location.href } : {}),
    ...(nav ? { userAgent: nav.userAgent } : {}),
    ...(win
      ? { viewport: { width: win.innerWidth, height: win.innerHeight } }
      : {}),
    deviceInfo: collectDeviceInfo(),
    ...(snapshot.consoleLogs.length > 0
      ? { consoleLogs: snapshot.consoleLogs }
      : {}),
    ...(snapshot.networkRequests.length > 0
      ? { networkRequests: snapshot.networkRequests }
      : {}),
    ...(snapshot.userEvents.length > 0
      ? { userEvents: snapshot.userEvents }
      : {}),
    ...(snapshot.errors.length > 0 ? { errors: snapshot.errors } : {}),
    ...(input.screenshotDataUrl
      ? { screenshotDataUrl: input.screenshotDataUrl }
      : {}),
    ...(input.recordingDataUrl
      ? { recordingDataUrl: input.recordingDataUrl }
      : {}),
  };
}

export function canCaptureScreenshot(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function" &&
    typeof document !== "undefined"
  );
}

/** Grab a single frame via getDisplayMedia — the browser's own screen
 * picker, so the member chooses what to share. Returns a PNG data URL. */
export async function captureScreenshotDataUrl(): Promise<string | null> {
  if (!canCaptureScreenshot()) return null;
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
  });
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await new Promise<void>((resolve) => {
      if (video.readyState >= 2) {
        resolve();
        return;
      }
      video.addEventListener("loadeddata", () => resolve(), { once: true });
    });
    await video.play();
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
    ctx.drawImage(video, 0, 0);
    return canvas.toDataURL("image/png");
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}
