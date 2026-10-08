import { afterEach, describe, expect, it, vi } from "vitest";

import { createPhaseTimer, logSlowPhases } from "./phase-timer.js";

function fakeClock(...ticks: number[]) {
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)];
}

describe("phase timer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attributes time to the phase that just ended and sums repeats", () => {
    const timer = createPhaseTimer(fakeClock(0, 10, 25.4, 30, 30));
    timer.mark("load");
    timer.mark("notify");
    timer.mark("load");
    expect(timer.phases()).toEqual({ load: 15, notify: 15 });
    expect(timer.elapsedMs()).toBe(30);
  });

  it("logs only once the threshold is crossed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fast = createPhaseTimer(fakeClock(0, 100, 100));
    fast.mark("notify");
    expect(logSlowPhases("issue.update.slow", fast, 500, {})).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    const slow = createPhaseTimer(fakeClock(0, 700, 700));
    slow.mark("notify");
    expect(
      logSlowPhases("issue.update.slow", slow, 500, { issueId: "i1" })
    ).toBe(true);
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      event: "issue.update.slow",
      totalMs: 700,
      phases: { notify: 700 },
      issueId: "i1",
    });
  });
});
