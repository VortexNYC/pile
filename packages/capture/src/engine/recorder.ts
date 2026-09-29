import {
  MAX_RECENT_EVENT_AGE_MS,
  MAX_RECENT_EVENT_COUNT,
} from "../constants.js";
import type { DebuggerEvent, BugReportDebuggerPayload } from "../types.js";
import {
  appendActionEventWithDedup,
  appendEventWithRetentionPolicy,
  appendNetworkEventWithDedup,
} from "./retention.js";

export interface CaptureSession {
  sessionId: string;
  startedAt: number;
  recordingStartedAt: number | null;
  events: DebuggerEvent[];
}

const createSessionId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

/**
 * Always-on event recorder. Instrumentation installs at init() and feeds a
 * rolling recent-events buffer, so a report submitted later still contains
 * what happened before the user triggered it — the Jam-style model.
 */
export class EventRecorder {
  private recentEvents: DebuggerEvent[] = [];
  private session: CaptureSession | null = null;

  push(event: DebuggerEvent): void {
    const appendTo = (events: DebuggerEvent[]) => {
      if (event.kind === "network") {
        appendNetworkEventWithDedup(events, event);
      } else if (event.kind === "action") {
        appendActionEventWithDedup(events, event);
      } else {
        appendEventWithRetentionPolicy(events, event);
      }
    };
    appendTo(this.recentEvents);
    if (this.session) {
      appendTo(this.session.events);
    }
    this.trimRecentEvents();
  }

  startSession(lookbackMs = 0): CaptureSession {
    const now = Date.now();
    const session: CaptureSession = {
      sessionId: createSessionId(),
      startedAt: now,
      recordingStartedAt: null,
      events: [],
    };
    if (lookbackMs > 0) {
      for (const event of this.recentEvents) {
        if (now - event.timestamp <= lookbackMs) {
          appendEventWithRetentionPolicy(session.events, event);
        }
      }
    }
    this.session = session;
    return session;
  }

  resumeSession(session: CaptureSession): void {
    this.session = session;
  }

  markRecordingStarted(recordingStartedAt: number): void {
    if (this.session) {
      this.session.recordingStartedAt = recordingStartedAt;
    }
  }

  getSessionSnapshot(): CaptureSession | null {
    return this.session;
  }

  /**
   * Snapshot of recent events for a one-shot report with no active session.
   */
  getRecentSnapshot(lookbackMs: number): CaptureSession {
    const now = Date.now();
    return {
      sessionId: createSessionId(),
      startedAt: now,
      recordingStartedAt: null,
      events: this.recentEvents.filter(
        (event) => now - event.timestamp <= lookbackMs
      ),
    };
  }

  discardSession(): void {
    this.session = null;
  }

  private trimRecentEvents(): void {
    const now = Date.now();
    this.recentEvents = this.recentEvents.filter(
      (event) => now - event.timestamp <= MAX_RECENT_EVENT_AGE_MS
    );
    if (this.recentEvents.length > MAX_RECENT_EVENT_COUNT) {
      this.recentEvents = this.recentEvents.slice(-MAX_RECENT_EVENT_COUNT);
    }
  }
}

export function buildDebuggerSubmissionPayload(
  snapshot: CaptureSession
): BugReportDebuggerPayload {
  const anchorTimestamp = snapshot.recordingStartedAt ?? snapshot.startedAt;
  const events = snapshot.events.toSorted((a, b) => a.timestamp - b.timestamp);
  const payload: BugReportDebuggerPayload = {
    actions: [],
    logs: [],
    networkRequests: [],
    errors: [],
  };
  for (const event of events) {
    const timestamp = new Date(event.timestamp).toISOString();
    const offset = toOffset(event.timestamp, anchorTimestamp);
    if (event.kind === "action") {
      payload.actions.push({
        type: event.actionType,
        target: event.target,
        timestamp,
        offset,
        metadata: event.metadata,
      });
      continue;
    }
    if (event.kind === "console") {
      payload.logs.push({
        level: event.level,
        message: event.message,
        timestamp,
        offset,
        metadata: event.metadata,
      });
      continue;
    }
    if (event.kind === "error") {
      payload.errors.push({
        message: event.message,
        stack: event.stack,
        source: event.source,
        timestamp,
        offset,
      });
      continue;
    }
    payload.networkRequests.push({
      method: event.method,
      url: event.url,
      status: event.status,
      duration: event.duration,
      requestHeaders: event.requestHeaders,
      responseHeaders: event.responseHeaders,
      requestBody: event.requestBody,
      responseBody: event.responseBody,
      timing: event.timing,
      graphql: event.graphql,
      timestamp,
      offset,
    });
  }
  return payload;
}

export function hasDebuggerPayloadData(
  payload: BugReportDebuggerPayload
): boolean {
  return (
    payload.actions.length > 0 ||
    payload.logs.length > 0 ||
    payload.networkRequests.length > 0 ||
    payload.errors.length > 0
  );
}

function toOffset(
  eventTimestamp: number,
  anchorTimestamp: number
): number | null {
  const rawOffset = Math.floor(eventTimestamp - anchorTimestamp);
  return rawOffset >= 0 ? rawOffset : null;
}
