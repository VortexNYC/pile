import { afterEach, describe, expect, it } from "vitest";

import type { DebuggerEvent } from "../../../../packages/capture/src/types.js";
import {
  canRecordScreenClip,
  feedbackCaptureSnapshot,
  MAX_RECORDING_MS,
  resetFeedbackCaptureForTests,
  snapshotToFeedbackEvents,
} from "./feedback-capture";

afterEach(() => resetFeedbackCaptureForTests());

const at = (ms: number) => new Date(ms).toISOString();

describe("snapshotToFeedbackEvents", () => {
  it("maps every event kind into its feedback field", () => {
    const events: DebuggerEvent[] = [
      {
        kind: "console",
        timestamp: 1000,
        level: "warn",
        message: "slow query",
      },
      {
        kind: "console",
        timestamp: 1100,
        level: "error",
        message: "boom",
      },
      {
        kind: "network",
        timestamp: 1200,
        method: "POST",
        url: "https://pile.nyc/workspaces/org/issues",
        status: 500,
        duration: 42,
      },
      {
        kind: "action",
        timestamp: 1300,
        actionType: "click",
        target: "button.save",
      },
      {
        kind: "error",
        timestamp: 1400,
        message: "Uncaught TypeError",
        stack: "TypeError: x",
        source: "exception",
      },
    ];
    const snapshot = snapshotToFeedbackEvents(events);
    expect(snapshot.consoleLogs).toHaveLength(2);
    expect(snapshot.consoleLogs[0]).toMatchObject({
      level: "warn",
      message: "slow query",
      timestamp: at(1000),
    });
    expect(snapshot.networkRequests).toHaveLength(1);
    expect(snapshot.networkRequests[0]).toMatchObject({
      method: "POST",
      url: "https://pile.nyc/workspaces/org/issues",
      status: 500,
      duration: 42,
      timestamp: at(1200),
    });
    expect(snapshot.userEvents).toHaveLength(1);
    expect(snapshot.userEvents[0]).toMatchObject({
      type: "click",
      target: "button.save",
      timestamp: at(1300),
    });
    expect(snapshot.errors).toHaveLength(1);
    expect(snapshot.errors[0]).toMatchObject({
      message: "Uncaught TypeError",
      source: "exception",
    });
  });

  it("keeps only the last 25 user events", () => {
    const events: DebuggerEvent[] = Array.from({ length: 40 }, (_, i) => ({
      kind: "action",
      timestamp: i,
      actionType: "click",
      target: `el-${i}`,
    }));
    const snapshot = snapshotToFeedbackEvents(events);
    expect(snapshot.userEvents).toHaveLength(25);
    expect(snapshot.userEvents[0]?.target).toBe("el-15");
    expect(snapshot.userEvents[24]?.target).toBe("el-39");
  });

  it("caps console logs and network requests", () => {
    const events: DebuggerEvent[] = [
      ...Array.from({ length: 210 }, (_, i) => ({
        kind: "console" as const,
        timestamp: i,
        level: "log" as const,
        message: `m${i}`,
      })),
      ...Array.from({ length: 310 }, (_, i) => ({
        kind: "network" as const,
        timestamp: 1000 + i,
        method: "GET",
        url: `https://a.b/${i}`,
        status: 200,
      })),
    ];
    const snapshot = snapshotToFeedbackEvents(events);
    expect(snapshot.consoleLogs).toHaveLength(200);
    expect(snapshot.networkRequests).toHaveLength(300);
  });
});

describe("feedbackCaptureSnapshot", () => {
  it("returns empty arrays before instrumentation installs", () => {
    const snapshot = feedbackCaptureSnapshot();
    expect(snapshot.consoleLogs).toEqual([]);
    expect(snapshot.networkRequests).toEqual([]);
    expect(snapshot.userEvents).toEqual([]);
    expect(snapshot.errors).toEqual([]);
  });
});

describe("media helpers", () => {
  it("exposes a 5m clip cap", () => {
    expect(MAX_RECORDING_MS).toBe(300_000);
  });

  it("reports recording support as a boolean", () => {
    expect(typeof canRecordScreenClip()).toBe("boolean");
  });
});
