import { describe, expect, it } from "vitest";

import {
  DEFAULT_INACTIVITY_MINUTES,
  DEFAULT_TIMEOUT_MINUTES,
  hashAgentState,
  parseAgentTimeouts,
  progressIsStale,
} from "./sweep.js";

describe("parseAgentTimeouts", () => {
  it("returns defaults for missing or invalid config", () => {
    expect(parseAgentTimeouts(null)).toEqual({
      timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
      inactivityMinutes: DEFAULT_INACTIVITY_MINUTES,
    });
    expect(parseAgentTimeouts("not-json")).toEqual({
      timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
      inactivityMinutes: DEFAULT_INACTIVITY_MINUTES,
    });
  });

  it("reads timeout and inactivityTimeout", () => {
    expect(
      parseAgentTimeouts(JSON.stringify({ timeout: 90, inactivityTimeout: 10 }))
    ).toEqual({ timeoutMinutes: 90, inactivityMinutes: 10 });
  });
});

describe("progressIsStale", () => {
  const now = Date.parse("2026-09-16T16:00:00.000Z");

  it("uses createdAt when lastProgressAt is missing", () => {
    expect(
      progressIsStale({
        now,
        createdAt: "2026-09-16T15:30:00.000Z",
        lastProgressAt: null,
        inactivityMinutes: 20,
      })
    ).toBe(true);
    expect(
      progressIsStale({
        now,
        createdAt: "2026-09-16T15:50:00.000Z",
        lastProgressAt: null,
        inactivityMinutes: 20,
      })
    ).toBe(false);
  });

  it("prefers lastProgressAt", () => {
    expect(
      progressIsStale({
        now,
        createdAt: "2026-09-16T12:00:00.000Z",
        lastProgressAt: "2026-09-16T15:50:00.000Z",
        inactivityMinutes: 20,
      })
    ).toBe(false);
  });
});

describe("hashAgentState", () => {
  it("changes when provider payload changes", () => {
    expect(hashAgentState({ a: 1 })).not.toBe(hashAgentState({ a: 2 }));
  });
});
