/** Auto-captured context for the member feedback bubble. Deliberately
 * cheap: a bounded console-error ring buffer installed once at layout
 * mount plus a pure payload builder — no replay, no network recording.
 * The server turns this into standard capture artifacts (metadata.json,
 * device-info.json, console-logs.json) on the feedback ticket. */

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
  screenshotDataUrl?: string;
}

const MAX_CAPTURED_ERRORS = 50;
const buffer: CapturedConsoleError[] = [];
let installed = false;

export function pushCapturedError(level: string, message: string): void {
  buffer.push({
    level,
    message: message.slice(0, 2000),
    timestamp: new Date().toISOString(),
  });
  if (buffer.length > MAX_CAPTURED_ERRORS) buffer.shift();
}

export function capturedConsoleErrors(): CapturedConsoleError[] {
  return [...buffer];
}

export function formatConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/** Wrap console.error/console.warn and window error events once. Safe to
 * call repeatedly and in non-DOM contexts (tests, SSR) — it no-ops. */
export function installConsoleCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      pushCapturedError(level, args.map(formatConsoleArg).join(" "));
      original(...args);
    };
  }
  window.addEventListener("error", (event) => {
    pushCapturedError("error", event.message || "window.onerror");
  });
  window.addEventListener("unhandledrejection", (event) => {
    pushCapturedError(
      "error",
      `unhandledrejection: ${formatConsoleArg(event.reason)}`
    );
  });
}

/** Test hook — module state persists across tests in a file. */
export function resetConsoleCaptureForTests(): void {
  buffer.length = 0;
  installed = false;
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
 * fields plus whatever context the browser exposes right now. */
export function buildFeedbackBody(input: {
  kind: FeedbackKind;
  title: string;
  description: string;
  screenshotDataUrl?: string;
}): FeedbackBody {
  const win = typeof window === "undefined" ? undefined : window;
  const nav = typeof navigator === "undefined" ? undefined : navigator;
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
    consoleErrors: capturedConsoleErrors(),
    ...(input.screenshotDataUrl
      ? { screenshotDataUrl: input.screenshotDataUrl }
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
