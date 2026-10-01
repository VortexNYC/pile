import { describe, expect, it } from "vitest";

import {
  laneProgressFromActivities,
  laneReportStepMessage,
  renderLaneProgressComment,
  typicalLaneDurationMs,
} from "./lane-progress.js";

const base = {
  id: "sess-1",
  organizationId: "org_1",
  agentId: "devin",
  status: "running",
  url: "https://app.devin.ai/sessions/abc",
  prUrl: null,
  branch: null,
  createdAt: "2026-10-01T14:00:00.000Z",
  startedAt: "2026-10-01T14:02:00.000Z",
  endedAt: null,
} as const;

describe("typicalLaneDurationMs", () => {
  it("returns null without usable history", () => {
    expect(typicalLaneDurationMs([])).toBeNull();
    expect(
      typicalLaneDurationMs([
        { createdAt: base.createdAt, startedAt: null, endedAt: null },
      ])
    ).toBeNull();
  });

  it("takes the median, falling back to createdAt", () => {
    const at = (m: number) =>
      new Date(Date.parse(base.createdAt) + m * 60000).toISOString();
    expect(
      typicalLaneDurationMs([
        { createdAt: at(0), startedAt: null, endedAt: at(10) },
        { createdAt: at(0), startedAt: at(0), endedAt: at(30) },
        { createdAt: at(0), startedAt: null, endedAt: at(20) },
      ])
    ).toEqual({ ms: 20 * 60000, samples: 3 });
    expect(
      typicalLaneDurationMs([
        { createdAt: at(0), startedAt: null, endedAt: at(10) },
        { createdAt: at(0), startedAt: null, endedAt: at(20) },
      ])
    ).toEqual({ ms: 15 * 60000, samples: 2 });
  });
});

describe("laneProgressFromActivities", () => {
  it("picks the newest step and the newest reported task list", () => {
    const result = laneProgressFromActivities([
      { type: "status", message: "Session running", payload: null },
      { type: "thought", message: "Running tests\nmore detail", payload: null },
      {
        type: "action",
        message: "Write code",
        payload: JSON.stringify({
          todos: [{ content: "Write code", status: "in_progress" }],
        }),
      },
      { type: "action", message: "older", payload: null },
    ]);
    expect(result.step).toBe("Running tests");
    expect(result.todos).toEqual([
      { content: "Write code", status: "in_progress" },
    ]);
  });
});

describe("laneReportStepMessage", () => {
  it("prefers step, then the in-progress todo", () => {
    expect(laneReportStepMessage(" Lint ", undefined)).toBe("Lint");
    expect(
      laneReportStepMessage(undefined, [
        { content: "a", status: "completed" },
        { content: "b", status: "in_progress" },
      ])
    ).toBe("b");
    expect(laneReportStepMessage(undefined, [])).toBe("Task list updated");
  });
});

describe("renderLaneProgressComment", () => {
  const now = Date.parse("2026-10-01T14:12:00.000Z");

  it("renders a live lane with link, step, elapsed, ETA, and tasks", () => {
    const body = renderLaneProgressComment({
      session: base,
      step: "Running tests",
      todos: [
        { content: "Read issue", status: "completed" },
        { content: "Run tests", status: "in_progress" },
        { content: "Open PR", status: "pending" },
      ],
      typical: { ms: 30 * 60000, samples: 7 },
      apiBaseUrl: "https://pile.nyc",
      now,
    });
    expect(body).toContain("**Agent devin is on it**");
    expect(body).toContain("[sess-1](https://app.devin.ai/sessions/abc)");
    expect(body).toContain(
      "pile agent sessions watch sess-1 --workspace org_1"
    );
    expect(body).toContain("Current step: Running tests");
    expect(body).toContain("10m elapsed");
    expect(body).toContain("ETA: ~14:32 UTC");
    expect(body).toContain("median of last 7");
    expect(body).toContain("- [x] Read issue");
    expect(body).toContain("- [ ] Run tests _(in progress)_");
    expect(body).toContain("- [ ] Open PR");
  });

  it("falls back to the Pile session URL and flags overdue / no history", () => {
    const overdue = renderLaneProgressComment({
      session: { ...base, url: null },
      step: null,
      todos: null,
      typical: { ms: 5 * 60000, samples: 2 },
      apiBaseUrl: "https://pile.nyc/",
      now,
    });
    expect(overdue).toContain(
      "[sess-1](https://pile.nyc/workspaces/org_1/agent/sessions/sess-1)"
    );
    expect(overdue).toContain("ETA: past typical");
    const fresh = renderLaneProgressComment({
      session: base,
      step: null,
      todos: null,
      typical: null,
      now,
    });
    expect(fresh).toContain("no completed devin lanes");
  });

  it("freezes a terminal lane with its duration and no ETA", () => {
    const body = renderLaneProgressComment({
      session: {
        ...base,
        status: "completed",
        endedAt: "2026-10-01T14:20:00.000Z",
        prUrl: "https://github.com/VortexNYC/pile/pull/1",
      },
      step: "Opened PR",
      todos: null,
      typical: { ms: 30 * 60000, samples: 7 },
      now,
    });
    expect(body).toContain("**Agent devin completed** after 18m");
    expect(body).toContain("Last step: Opened PR");
    expect(body).toContain("ended 14:20 UTC");
    expect(body).not.toContain("ETA");
    expect(body).toContain("PR: https://github.com/VortexNYC/pile/pull/1");
  });
});
