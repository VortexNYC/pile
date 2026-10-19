import { describe, expect, it } from "vitest";

import {
  FLEET_FAILURE_RATE,
  FLEET_FAILURE_WINDOW_MS,
  startFailureRateUnhealthy,
  startFailureStats,
} from "./fleet-health.js";

const NOW = Date.parse("2026-10-19T14:00:00Z");
const at = (ageMs: number) => new Date(NOW - ageMs).toISOString();
const row = (
  status: string,
  infraFailure: number,
  ageMs = 60_000
): { status: string; infraFailure: number; createdAt: string } => ({
  status,
  infraFailure,
  createdAt: at(ageMs),
});

describe("startFailureStats (PILE-452)", () => {
  it("rates infra-failed starts over the trailing window", () => {
    const stats = startFailureStats(
      [
        row("failed", 1),
        row("completed", 0),
        row("running", 0),
        row("failed", 1),
      ],
      NOW
    );
    expect(stats).toEqual({
      starts: 4,
      infraFailures: 2,
      rate: 0.5,
    });
    expect(startFailureRateUnhealthy(stats)).toBe(true);
  });

  it("stays green at or below the threshold and on empty windows", () => {
    const edge = startFailureStats(
      [
        row("failed", 1),
        ...Array.from({ length: 4 }, () => row("completed", 0)),
      ],
      NOW
    );
    expect(edge.rate).toBeCloseTo(FLEET_FAILURE_RATE);
    expect(startFailureRateUnhealthy(edge)).toBe(false);
    expect(startFailureRateUnhealthy(startFailureStats([], NOW))).toBe(false);
  });

  it("excludes parked holds and sessions outside the window", () => {
    const stats = startFailureStats(
      [
        row("waiting", 0), // parked — never attempted a start
        row("failed", 1, FLEET_FAILURE_WINDOW_MS + 60_000), // stale
        row("failed", 1),
      ],
      NOW
    );
    expect(stats.starts).toBe(1);
    expect(stats.infraFailures).toBe(1);
    expect(stats.rate).toBe(1);
  });
});
