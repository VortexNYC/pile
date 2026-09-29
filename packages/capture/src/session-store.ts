import type { CaptureSession } from "./engine/recorder.js";
import type { DebuggerEvent } from "./types.js";

const STORAGE_KEY = "pile-capture:session";
const EVENT_KINDS = new Set(["action", "console", "error", "network"]);

const getStorage = (): Storage | null => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
};

const isDebuggerEvent = (value: unknown): value is DebuggerEvent =>
  typeof value === "object" &&
  value !== null &&
  "kind" in value &&
  typeof value.kind === "string" &&
  EVENT_KINDS.has(value.kind) &&
  "timestamp" in value &&
  typeof value.timestamp === "number";

/**
 * Persist the active capture session to tab-scoped storage so a page
 * refresh mid-session resumes it instead of dropping it. Best-effort:
 * quota or privacy-mode failures are ignored.
 */
export function saveCaptureSession(session: CaptureSession): void {
  try {
    getStorage()?.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage full or blocked — the in-memory session is still intact.
  }
}

export function loadCaptureSession(): CaptureSession | null {
  let raw: string | null = null;
  try {
    raw = getStorage()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearCaptureSession();
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("sessionId" in parsed) ||
    typeof parsed.sessionId !== "string" ||
    !("startedAt" in parsed) ||
    typeof parsed.startedAt !== "number" ||
    !("events" in parsed) ||
    !Array.isArray(parsed.events)
  ) {
    clearCaptureSession();
    return null;
  }
  const recordingStartedAt =
    "recordingStartedAt" in parsed &&
    typeof parsed.recordingStartedAt === "number"
      ? parsed.recordingStartedAt
      : null;
  return {
    sessionId: parsed.sessionId,
    startedAt: parsed.startedAt,
    recordingStartedAt,
    events: parsed.events.filter(isDebuggerEvent),
  };
}

export function clearCaptureSession(): void {
  try {
    getStorage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}
