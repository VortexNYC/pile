import { describe, expect, it } from "vitest";

import { buildHangReport, formatHangReport } from "./hang-report.js";

describe("buildHangReport", () => {
  const now = Date.parse("2026-10-01T12:00:00.000Z");
  const session = {
    status: "running" as const,
    createdAt: "2026-10-01T11:00:00.000Z",
    startedAt: "2026-10-01T11:05:00.000Z",
    lastProgressAt: "2026-10-01T11:30:00.000Z",
    providerSessionId: "prov-1",
    retryCount: 0,
  };

  it("captures per-phase elapsed time, last trail entries, and process state", () => {
    const report = buildHangReport({
      session,
      reason: "inactive",
      now,
      lastActivity: {
        type: "action",
        message: "bash: pnpm install",
        createdAt: "2026-10-01T11:29:00.000Z",
      },
      lastEvent: {
        type: "activity",
        message: "bash: pnpm install",
        createdAt: "2026-10-01T11:29:00.000Z",
      },
      state: {
        provider: {
          state: { status: "running", pid: 42 },
          logs: "step 1\nstep 2\ntool_call: bash pnpm install\n",
        },
        compute: { lastSeen: "2026-10-01T11:31:00.000Z" },
      },
    });

    expect(report.reason).toBe("inactive");
    expect(report.detectedAt).toBe("2026-10-01T12:00:00.000Z");
    expect(report.phases).toEqual({
      queuedMs: 5 * 60_000,
      runningMs: 55 * 60_000,
      silentMs: 30 * 60_000,
      totalMs: 60 * 60_000,
    });
    expect(report.lastActivity?.message).toBe("bash: pnpm install");
    expect(report.process?.runner).toBe('{"status":"running","pid":42}');
    expect(report.process?.lastSeenAt).toBe("2026-10-01T11:31:00.000Z");
    expect(report.process?.logTail).toContain("tool_call: bash pnpm install");

    const text = formatHangReport(report);
    expect(text).toContain("Hang report (inactive)");
    expect(text).toContain("queued 5m, running 55m, silent 30m");
    expect(text).toContain("last activity: [action] bash: pnpm install");
    expect(text).toContain("compute last seen: 2026-10-01T11:31:00.000Z");
    expect(text).toContain("tool_call: bash pnpm install");
  });

  it("degrades to a report with no trail or process evidence", () => {
    const report = buildHangReport({
      session: { ...session, startedAt: null, lastProgressAt: null },
      reason: "external_silent",
      now,
      lastActivity: null,
      lastEvent: null,
      state: null,
    });
    expect(report.phases.queuedMs).toBe(60 * 60_000);
    expect(report.phases.runningMs).toBeNull();
    expect(report.phases.silentMs).toBe(60 * 60_000);
    expect(report.process).toBeNull();
    expect(formatHangReport(report)).toContain("last activity: none recorded");
  });

  it("bounds and scrubs captured log output", () => {
    const token = ["ghp", "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8"].join("_");
    const report = buildHangReport({
      session,
      reason: "timeout",
      now,
      lastActivity: null,
      lastEvent: null,
      state: {
        provider: {
          logs: `${"x".repeat(5000)}\nGITHUB_TOKEN=${token}`,
        },
      },
    });
    const tail = report.process?.logTail ?? "";
    expect(tail.length).toBeLessThanOrEqual(2001);
    expect(tail).not.toContain(token);
  });
});
