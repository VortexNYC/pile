import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.js";
import {
  FleetModel,
  formatAge,
  sessionTone,
  shortPrRef,
  sortFleetSessions,
  statusLabel,
  type FleetKey,
  type FleetPromptOptions,
  type FleetSession,
  type FleetView,
  type FleetViewModel,
} from "./fleet.js";
import type { RealtimeSocket } from "./realtime.js";

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    id: "sess-1",
    issueId: "issue-1",
    agentId: "devin-cli",
    provider: "devin-cli",
    status: "running",
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  };
}

function createFakeView(viewportRows = 20) {
  const rendered: FleetViewModel[] = [];
  let keyHandler: ((key: FleetKey) => void) | null = null;
  let prompt: FleetPromptOptions | null = null;
  const view: FleetView = {
    start() {},
    render(model) {
      rendered.push(model);
    },
    onKey(handler) {
      keyHandler = handler;
    },
    tableViewportRows() {
      return viewportRows;
    },
    promptText(options) {
      prompt = options;
    },
    destroy: vi.fn(),
  };
  return {
    view,
    rendered,
    press(name: string, modifiers: Partial<FleetKey> = {}) {
      keyHandler?.({ name, ctrl: false, shift: false, ...modifiers });
    },
    prompt() {
      return prompt;
    },
    submitPrompt(value: string) {
      const p = prompt;
      prompt = null;
      p?.onSubmit(value);
    },
    cancelPrompt() {
      const p = prompt;
      prompt = null;
      p?.onCancel();
    },
  };
}

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  );
}

const NOW = Date.parse("2026-09-30T12:00:00.000Z");

describe("sortFleetSessions", () => {
  it("sorts live sessions first, terminal sessions last", () => {
    const sorted = sortFleetSessions([
      session({ id: "done-1", status: "completed" }),
      session({ id: "live-1", status: "running" }),
      session({ id: "failed-1", status: "failed" }),
      session({ id: "live-2", status: "created" }),
    ]);
    expect(sorted.map((s) => s.id)).toEqual([
      "live-1",
      "live-2",
      "done-1",
      "failed-1",
    ]);
  });

  it("orders live sessions by dispatch order, terminal by most recently ended", () => {
    const sorted = sortFleetSessions([
      session({
        id: "live-new",
        status: "running",
        createdAt: "2026-09-30T11:00:00.000Z",
      }),
      session({
        id: "done-old",
        status: "completed",
        endedAt: "2026-09-30T09:00:00.000Z",
      }),
      session({
        id: "live-old",
        status: "waiting",
        createdAt: "2026-09-30T10:00:00.000Z",
      }),
      session({
        id: "done-new",
        status: "failed",
        endedAt: "2026-09-30T11:30:00.000Z",
      }),
    ]);
    expect(sorted.map((s) => s.id)).toEqual([
      "live-old",
      "live-new",
      "done-new",
      "done-old",
    ]);
  });
});

describe("formatAge", () => {
  it("formats seconds, minutes, hours, and days", () => {
    const base = "2026-09-30T12:00:00.000Z";
    const at = (offsetSeconds: number) =>
      new Date(NOW - offsetSeconds * 1000).toISOString();
    expect(formatAge(at(30), NOW)).toBe("30s");
    expect(formatAge(at(300), NOW)).toBe("5m");
    expect(formatAge(at(3900), NOW)).toBe("1h5m");
    expect(formatAge(at(7200), NOW)).toBe("2h");
    expect(formatAge(at(90000), NOW)).toBe("1d1h");
    expect(formatAge(base, NOW)).toBe("0s");
    expect(formatAge("not-a-date", NOW)).toBe("?");
  });
});

describe("shortPrRef", () => {
  it("shortens GitHub pull URLs", () => {
    expect(shortPrRef("https://github.com/VortexNYC/pile/pull/234")).toBe(
      "VortexNYC/pile#234"
    );
    expect(shortPrRef(null)).toBeNull();
    expect(shortPrRef("https://example.com/pr")).toBe("https://example.com/pr");
  });
});

describe("sessionTone/statusLabel", () => {
  it("maps statuses to tones", () => {
    expect(sessionTone(session({ status: "running" }))).toBe("live");
    expect(sessionTone(session({ status: "created" }))).toBe("queued");
    expect(sessionTone(session({ status: "completed" }))).toBe("ok");
    expect(sessionTone(session({ status: "failed" }))).toBe("fail");
    expect(sessionTone(session({ status: "canceled" }))).toBe("muted");
  });

  it("surfaces derived status on live sessions", () => {
    const stalled = session({ status: "running", derivedStatus: "stalled" });
    expect(sessionTone(stalled)).toBe("warn");
    expect(statusLabel(stalled)).toBe("running·stalled");
    expect(
      statusLabel(session({ status: "running", derivedStatus: "needs_input" }))
    ).toBe("running·needs-input");
    // terminal sessions keep their final status even with a stale derived flag
    const done = session({ status: "failed", derivedStatus: "stalled" });
    expect(sessionTone(done)).toBe("fail");
    expect(statusLabel(done)).toBe("failed");
  });
});

describe("FleetModel", () => {
  it("keeps the selected session stable across repolls", () => {
    const model = new FleetModel();
    model.setSessions([
      session({ id: "a" }),
      session({ id: "b" }),
      session({ id: "c" }),
    ]);
    model.moveSelection(1);
    expect(model.selected?.id).toBe("b");
    // a repoll reorders rows; selection follows the id
    model.setSessions([
      session({ id: "b" }),
      session({ id: "a" }),
      session({ id: "c" }),
    ]);
    expect(model.selected?.id).toBe("b");
  });

  it("drops selection to the first row when the session disappears", () => {
    const model = new FleetModel();
    model.setSessions([session({ id: "a" }), session({ id: "b" })]);
    model.moveSelection(1);
    model.setSessions([session({ id: "a" })]);
    expect(model.selected?.id).toBe("a");
  });

  it("clamps selection movement at the edges", () => {
    const model = new FleetModel();
    model.setSessions([session({ id: "a" }), session({ id: "b" })]);
    expect(model.moveSelection(-1)).toBe(false);
    expect(model.moveSelection(1)).toBe(true);
    expect(model.moveSelection(1)).toBe(false);
    expect(model.selected?.id).toBe("b");
  });

  it("windows rows around the selection", () => {
    const model = new FleetModel();
    model.setSessions(
      Array.from({ length: 10 }, (_, i) =>
        session({ id: `s-${i}`, createdAt: `2026-09-30T10:0${i}:00.000Z` })
      )
    );
    model.selectLast();
    const vm = model.viewModel(NOW, 4);
    expect(vm.selectedIndex).toBe(9);
    expect(vm.topIndex).toBe(6);
    expect(vm.rows.map((r) => r.id)).toEqual(["s-6", "s-7", "s-8", "s-9"]);
  });

  it("swaps the log tail when the selection changes", () => {
    const model = new FleetModel();
    model.setSessions([session({ id: "a" }), session({ id: "b" })]);
    model.setTail("a", {
      logs: "lane a logs",
      status: "running",
      result: null,
      error: null,
    });
    expect(model.viewModel(NOW, 10).logText).toBe("lane a logs");
    model.moveSelection(1);
    expect(model.viewModel(NOW, 10).logText).toBe("loading…");
    model.setTail("b", {
      logs: "lane b logs",
      status: "running",
      result: null,
      error: null,
    });
    expect(model.viewModel(NOW, 10).logText).toBe("lane b logs");
  });

  it("ignores tails that arrive after the selection moved", () => {
    const model = new FleetModel();
    model.setSessions([session({ id: "a" }), session({ id: "b" })]);
    model.moveSelection(1);
    model.setTail("a", {
      logs: "stale",
      status: "running",
      result: null,
      error: null,
    });
    expect(model.viewModel(NOW, 10).logText).toBe("loading…");
  });

  it("shows a terminal session's final status when live state is gone", () => {
    const model = new FleetModel();
    model.setSessions([
      session({ id: "dead", status: "failed", result: "boom" }),
    ]);
    model.setTail("dead", {
      logs: null,
      status: null,
      result: "boom",
      error: "state 400",
    });
    const vm = model.viewModel(NOW, 10);
    expect(vm.logTitle).toContain("failed");
    expect(vm.logText).toBe("[failed] boom");
  });

  it("labels issues by identifier once resolved", () => {
    const model = new FleetModel();
    model.setSessions([session({ id: "a", issueId: "uuid-1" })]);
    expect(model.issueIdsNeedingLabels()).toEqual(["uuid-1"]);
    model.setIssueLabel("uuid-1", "ISS-42");
    expect(model.issueIdsNeedingLabels()).toEqual([]);
    expect(model.viewModel(NOW, 10).rows[0]?.issue).toBe("ISS-42");
  });

  it("renders live count and fleet health in the status line", () => {
    const model = new FleetModel();
    model.setSessions([
      session({ id: "a", status: "running" }),
      session({ id: "b", status: "completed" }),
    ]);
    model.setHealth({
      live: 1,
      missingEndedAt: 0,
      providers: [
        {
          agentId: "devin-cli",
          live: 1,
          keptSandboxes: 3,
          infraStreak: 0,
          unhealthy: false,
        },
      ],
    });
    model.setLastPoll(NOW);
    const vm = model.viewModel(NOW, 10);
    expect(vm.liveCount).toBe(1);
    expect(vm.statusLine).toContain("1 live");
    expect(vm.statusLine).toContain("fleet: ok");
    expect(vm.statusLine).toContain("devin-cli 1 live/3 kept");
  });

  it("marks unhealthy fleets", () => {
    const model = new FleetModel();
    model.setHealth({
      live: 2,
      missingEndedAt: 4,
      providers: [
        {
          agentId: "devin-cli",
          live: 2,
          keptSandboxes: 0,
          infraStreak: 3,
          unhealthy: true,
        },
      ],
    });
    const vm = model.viewModel(NOW, 10);
    expect(vm.statusLine).toContain("UNHEALTHY");
    expect(vm.statusLine).toContain("streak 3");
  });

  it("surfaces a poll error in the status line", () => {
    const model = new FleetModel();
    model.setError("GET /agent/sessions returned 500");
    expect(model.viewModel(NOW, 10).statusLine).toContain(
      "GET /agent/sessions returned 500"
    );
  });
});

async function waitForRender(
  rendered: FleetViewModel[],
  predicate: (vm: FleetViewModel) => boolean
): Promise<FleetViewModel> {
  return await vi.waitFor(
    () => {
      const vm = rendered.at(-1);
      expect(vm).toBeDefined();
      expect(predicate(vm as FleetViewModel)).toBe(true);
      return vm as FleetViewModel;
    },
    { timeout: 5000, interval: 10 }
  );
}

describe("pile fleet", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalApiKey: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "pile-fleet-"));
    originalHome = process.env.HOME;
    originalApiKey = process.env.PILE_API_KEY;
    process.env.HOME = home;
    process.env.PILE_API_KEY = "test-api-key";
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    process.env.PILE_API_KEY = originalApiKey;
    rmSync(home, { recursive: true, force: true });
  });

  function createFleetFetch() {
    const sessions: Record<string, unknown>[] = [
      session({
        id: "sess-live",
        issueId: "issue-live",
        status: "running",
        createdAt: "2026-09-30T11:00:00.000Z",
      }),
      session({
        id: "sess-done",
        issueId: "issue-done",
        status: "failed",
        endedAt: "2026-09-30T11:30:00.000Z",
      }),
    ];
    return vi
      .fn()
      .mockImplementation((url: URL | string, init?: RequestInit) => {
        const pathname = new URL(typeof url === "string" ? url : url.href)
          .pathname;
        if (pathname === "/workspaces/ws-1/agent/sessions") {
          return jsonResponse({ sessions });
        }
        if (pathname === "/workspaces/ws-1/agent/fleet-health") {
          return jsonResponse({
            live: 1,
            missingEndedAt: 0,
            providers: [
              {
                agentId: "devin-cli",
                live: 1,
                keptSandboxes: 0,
                infraStreak: 0,
                unhealthy: false,
              },
            ],
          });
        }
        if (pathname === "/workspaces/ws-1/agent/sessions/sess-live/state") {
          return jsonResponse({
            session: sessions[0],
            provider: { state: "running", logs: "lane-one\nstill going" },
          });
        }
        if (pathname === "/workspaces/ws-1/agent/sessions/sess-done/state") {
          return Promise.resolve(new Response("gone", { status: 400 }));
        }
        if (pathname === "/workspaces/ws-1/issues/issue-live") {
          return jsonResponse({ id: "issue-live", identifier: "ISS-10" });
        }
        if (pathname === "/workspaces/ws-1/issues/issue-done") {
          return jsonResponse({ id: "issue-done", identifier: "ISS-11" });
        }
        if (pathname === "/workspaces/ws-1/agent/setup-status") {
          return jsonResponse({
            githubConnected: true,
            providers: [
              {
                agentId: "devin",
                credentials: "workspace",
                computeProvider: "daytona",
                computeCredentials: "deployment",
                missing: [],
                ready: true,
              },
              {
                agentId: "devin-cli",
                credentials: "workspace",
                computeProvider: "daytona",
                computeCredentials: "deployment",
                missing: [],
                ready: true,
              },
              {
                agentId: "cursor",
                credentials: "none",
                computeProvider: "daytona",
                computeCredentials: "none",
                missing: ["credentials", "compute credentials"],
                ready: false,
              },
            ],
          });
        }
        if (pathname === "/workspaces/ws-1/agent/dispatch-batch") {
          const body =
            typeof init?.body === "string"
              ? (JSON.parse(init.body) as { items?: { issueId: string }[] })
              : {};
          return jsonResponse({
            batchId: "batch-12345678",
            results: (body.items ?? []).map((item) => ({
              issueId: item.issueId,
              sessionId: `sess-${item.issueId}`,
              status: "created",
              error: null,
            })),
          });
        }
        if (pathname.endsWith("/cancel")) {
          return jsonResponse({ id: "sess-live", status: "canceled" });
        }
        if (pathname.endsWith("/prompt")) {
          return jsonResponse({ id: "sess-live", status: "running" });
        }
        if (pathname.endsWith("/retry")) {
          return jsonResponse(
            session({ id: "sess-retry", status: "created" }),
            201
          );
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      });
  }

  it("exits 1 without --workspace", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitCode = await runCli(["fleet"]);
    expect(exitCode).toBe(1);
    spy.mockRestore();
  });

  it("renders the session table and log tail, then exits on q", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      {
        fetch: mockFetch,
        createView: () => view,
        now: () => NOW,
        createSocket: null,
      }
    );

    const vm = await waitForRender(
      rendered,
      (m) => m.rows.length === 2 && m.logText.includes("lane-one")
    );
    expect(vm.rows.map((r) => r.id)).toEqual(["sess-live", "sess-done"]);
    expect(vm.rows[0]?.status).toBe("running");
    expect(vm.rows[1]?.status).toBe("failed");
    expect(vm.statusLine).toContain("1 live");
    expect(vm.statusLine).toContain("fleet: ok");

    press("q");
    expect(await done).toBe(0);
    expect(view.destroy).toHaveBeenCalled();
  });

  it("swaps the log tail when the selection moves and exits on ctrl-c", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      {
        fetch: mockFetch,
        createView: () => view,
        now: () => NOW,
        createSocket: null,
      }
    );

    await waitForRender(rendered, (m) => m.logText.includes("lane-one"));

    press("j");
    const vm = await waitForRender(
      rendered,
      (m) => m.selectedId === "sess-done" && m.logText.includes("[failed]")
    );
    expect(vm.logTitle).toContain("sess-don");
    expect(vm.logTitle).toContain("ISS-11");

    press("c", { ctrl: true });
    expect(await done).toBe(0);
    expect(view.destroy).toHaveBeenCalled();
  });

  it("keeps running and reports the error when the sessions poll fails", async () => {
    const mockFetch = vi.fn().mockImplementation((url: URL | string) => {
      const pathname = new URL(typeof url === "string" ? url : url.href)
        .pathname;
      if (pathname === "/workspaces/ws-1/agent/fleet-health") {
        return jsonResponse({
          live: 0,
          missingEndedAt: 0,
          providers: [],
        });
      }
      return Promise.resolve(new Response("boom", { status: 500 }));
    });
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      {
        fetch: mockFetch,
        createView: () => view,
        now: () => NOW,
        createSocket: null,
      }
    );

    const vm = await waitForRender(rendered, (m) =>
      m.statusLine.includes("500")
    );
    expect(vm.statusLine).toContain("GET /agent/sessions returned 500");

    press("q");
    expect(await done).toBe(0);
    expect(view.destroy).toHaveBeenCalled();
  });

  it("keeps polling when --poll is passed, never opening a socket", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press } = createFakeView();
    const createSocket = vi.fn(() => {
      throw new Error("socket should not be created in --poll mode");
    });

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000", "--poll"],
      {
        fetch: mockFetch,
        createView: () => view,
        now: () => NOW,
        createSocket,
      }
    );

    const vm = await waitForRender(rendered, (m) =>
      m.logText.includes("lane-one")
    );
    expect(createSocket).not.toHaveBeenCalled();
    expect(vm.statusLine).toContain("polling");

    press("q");
    expect(await done).toBe(0);
  });

  it("requests the sessions, state, health, and issue endpoints", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      {
        fetch: mockFetch,
        createView: () => view,
        now: () => NOW,
        createSocket: null,
      }
    );

    await waitForRender(rendered, (m) => m.logText.includes("lane-one"));
    const urls = mockFetch.mock.calls.map(
      ([url]) => new URL(typeof url === "string" ? url : (url as URL).href)
    );
    const paths = urls.map((u) => u.pathname);
    expect(paths).toContain("/workspaces/ws-1/agent/sessions");
    expect(paths).toContain("/workspaces/ws-1/agent/fleet-health");
    expect(paths).toContain("/workspaces/ws-1/agent/sessions/sess-live/state");
    expect(paths).toContain("/workspaces/ws-1/issues/issue-live");
    const sessionsReq = urls.find(
      (u) => u.pathname === "/workspaces/ws-1/agent/sessions"
    );
    expect(sessionsReq?.searchParams.get("summary")).toBe("1");

    press("q");
    expect(await done).toBe(0);
    expect(view.destroy).toHaveBeenCalled();
  });

  it("x cancels the selected running lane", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      { fetch: mockFetch, createView: () => view, now: () => NOW }
    );
    await waitForRender(rendered, (m) => m.logText.includes("lane-one"));

    press("x");
    await waitForRender(rendered, (m) =>
      m.statusLine.includes("cancel sent → sess-liv")
    );
    const calls = mockFetch.mock.calls.map(
      ([url]) =>
        new URL(typeof url === "string" ? url : (url as URL).href).pathname
    );
    expect(calls).toContain("/workspaces/ws-1/agent/sessions/sess-live/cancel");

    press("q");
    expect(await done).toBe(0);
  });

  it("x on a terminal lane does not hit the API", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      { fetch: mockFetch, createView: () => view, now: () => NOW }
    );
    await waitForRender(rendered, (m) => m.logText.includes("lane-one"));

    press("j"); // select the failed lane
    await waitForRender(rendered, (m) => m.selectedId === "sess-done");
    press("x");
    await waitForRender(rendered, (m) =>
      m.statusLine.includes("lane already failed")
    );
    const calls = mockFetch.mock.calls.map(
      ([url]) =>
        new URL(typeof url === "string" ? url : (url as URL).href).pathname
    );
    expect(calls).not.toContain(
      "/workspaces/ws-1/agent/sessions/sess-done/cancel"
    );

    press("q");
    expect(await done).toBe(0);
  });

  it("n sends a follow-up prompt to the selected lane", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press, prompt, submitPrompt } = createFakeView();

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      { fetch: mockFetch, createView: () => view, now: () => NOW }
    );
    await waitForRender(rendered, (m) => m.logText.includes("lane-one"));

    press("n");
    await waitForRender(rendered, (m) => m.mode === "input");
    expect(prompt()?.title).toContain("nudge sess-liv");

    submitPrompt("also update the changelog");
    await waitForRender(rendered, (m) =>
      m.statusLine.includes("nudged sess-liv")
    );
    const promptCall = mockFetch.mock.calls.find(([url]) =>
      new URL(
        typeof url === "string" ? url : (url as URL).href
      ).pathname.endsWith("/prompt")
    );
    expect(promptCall).toBeDefined();
    expect(JSON.parse(String(promptCall?.[1]?.body))).toEqual({
      prompt: "also update the changelog",
    });

    press("q");
    expect(await done).toBe(0);
  });

  it("R retries a failed lane", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      { fetch: mockFetch, createView: () => view, now: () => NOW }
    );
    await waitForRender(rendered, (m) => m.logText.includes("lane-one"));

    press("j"); // select the failed lane
    await waitForRender(rendered, (m) => m.selectedId === "sess-done");
    press("r", { shift: true });
    await waitForRender(rendered, (m) =>
      m.statusLine.includes("retry → sess-ret created")
    );
    const calls = mockFetch.mock.calls.map(
      ([url]) =>
        new URL(typeof url === "string" ? url : (url as URL).href).pathname
    );
    expect(calls).toContain("/workspaces/ws-1/agent/sessions/sess-done/retry");

    press("q");
    expect(await done).toBe(0);
  });

  it("R on a live lane does not hit the API", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      { fetch: mockFetch, createView: () => view, now: () => NOW }
    );
    await waitForRender(rendered, (m) => m.logText.includes("lane-one"));

    press("r", { shift: true });
    await waitForRender(rendered, (m) =>
      m.statusLine.includes("lane still running")
    );
    const calls = mockFetch.mock.calls.map(
      ([url]) =>
        new URL(typeof url === "string" ? url : (url as URL).href).pathname
    );
    expect(calls.filter((p) => p.endsWith("/retry"))).toEqual([]);

    press("q");
    expect(await done).toBe(0);
  });

  it("d dispatches the selected issue through the agent picker and batch endpoint", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press, prompt, submitPrompt } = createFakeView();

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      { fetch: mockFetch, createView: () => view, now: () => NOW }
    );
    await waitForRender(rendered, (m) => m.logText.includes("lane-one"));

    press("d");
    const picker = await waitForRender(
      rendered,
      (m) => m.mode === "picker" && m.pickerLines.length > 0
    );
    expect(picker.logTitle).toContain("pick an agent");
    expect(picker.pickerLines.join("\n")).toContain("devin-cli");

    press("j"); // past "(default)" to the first agent
    press("j"); // devin-cli
    press("return");
    await waitForRender(rendered, (m) => m.mode === "input");
    expect(prompt()?.title).toContain("dispatch 1 issue → devin-cli");

    submitPrompt("feat/override");
    await waitForRender(rendered, (m) =>
      m.statusLine.includes("1/1 dispatched")
    );
    const batchCall = mockFetch.mock.calls.find(([url]) =>
      new URL(
        typeof url === "string" ? url : (url as URL).href
      ).pathname.endsWith("/dispatch-batch")
    );
    expect(JSON.parse(String(batchCall?.[1]?.body))).toEqual({
      items: [
        {
          issueId: "issue-live",
          agentId: "devin-cli",
          branch: "feat/override",
        },
      ],
    });

    press("q");
    expect(await done).toBe(0);
  });

  it("d fans marked issues out as one batch", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press, submitPrompt } = createFakeView();

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      { fetch: mockFetch, createView: () => view, now: () => NOW }
    );
    await waitForRender(rendered, (m) => m.rows.length === 2);

    press("space");
    press("j");
    press("space");
    const marked = await waitForRender(
      rendered,
      (m) => m.markCount === 2 && m.rows.every((r) => r.marked)
    );
    expect(marked.statusLine).toContain("(2)");

    press("d");
    await waitForRender(
      rendered,
      (m) => m.mode === "picker" && m.pickerLines.length > 0
    );
    press("return"); // "(default)" agent
    await waitForRender(rendered, (m) => m.mode === "input");
    submitPrompt(""); // keep the issues' branches
    await waitForRender(rendered, (m) =>
      m.statusLine.includes("2/2 dispatched")
    );

    const batchCalls = mockFetch.mock.calls.filter(([url]) =>
      new URL(
        typeof url === "string" ? url : (url as URL).href
      ).pathname.endsWith("/dispatch-batch")
    );
    expect(batchCalls).toHaveLength(1);
    expect(JSON.parse(String(batchCalls[0]?.[1]?.body))).toEqual({
      items: [{ issueId: "issue-live" }, { issueId: "issue-done" }],
    });
    // dispatched issues lose their marks
    await waitForRender(rendered, (m) => m.markCount === 0);

    press("q");
    expect(await done).toBe(0);
  });

  it("custom… option prompts for an agent id before the branch override", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press, prompt, submitPrompt } = createFakeView();

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      { fetch: mockFetch, createView: () => view, now: () => NOW }
    );
    await waitForRender(rendered, (m) => m.logText.includes("lane-one"));

    press("d");
    const picker = await waitForRender(
      rendered,
      (m) => m.mode === "picker" && m.pickerLines.length > 0
    );
    // last option is the custom escape hatch
    for (let i = 0; i < picker.pickerLines.length - 1; i += 1) press("j");
    press("return");
    await waitForRender(rendered, (m) => m.mode === "input");
    expect(prompt()?.title).toBe("agent id");

    submitPrompt("flue");
    await waitForRender(rendered, (m) => m.mode === "input");
    expect(prompt()?.title).toContain("dispatch 1 issue → flue");

    submitPrompt("");
    await waitForRender(rendered, (m) =>
      m.statusLine.includes("1/1 dispatched")
    );
    const batchCall = mockFetch.mock.calls.find(([url]) =>
      new URL(
        typeof url === "string" ? url : (url as URL).href
      ).pathname.endsWith("/dispatch-batch")
    );
    expect(JSON.parse(String(batchCall?.[1]?.body))).toEqual({
      items: [{ issueId: "issue-live", agentId: "flue" }],
    });

    press("q");
    expect(await done).toBe(0);
  });

  it("escape closes the agent picker without dispatching", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      { fetch: mockFetch, createView: () => view, now: () => NOW }
    );
    await waitForRender(rendered, (m) => m.logText.includes("lane-one"));

    press("d");
    await waitForRender(rendered, (m) => m.mode === "picker");
    press("escape");
    await waitForRender(rendered, (m) => m.mode === "list");
    const calls = mockFetch.mock.calls.map(
      ([url]) =>
        new URL(typeof url === "string" ? url : (url as URL).href).pathname
    );
    expect(calls.filter((p) => p.endsWith("/dispatch-batch"))).toEqual([]);

    press("q");
    expect(await done).toBe(0);
  });
});

class FakeSocket implements RealtimeSocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<
    string,
    ((event: { readonly data: unknown }) => void)[]
  >();

  send(data: string): void {
    this.sent.push(data);
  }

  addEventListener(
    type: string,
    listener: (event: { readonly data: unknown }) => void
  ): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  private dispatch(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data });
    }
  }

  open(): void {
    this.readyState = 1;
    this.dispatch("open");
  }

  emit(value: unknown): void {
    this.dispatch("message", JSON.stringify(value));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch("close");
  }
}

function sessionEvent(
  row: Record<string, unknown>,
  issue: Record<string, unknown>,
  type = "agent_session.updated"
): Record<string, unknown> {
  return { type, organizationId: "ws-1", session: row, issue };
}

function countCalls(
  mockFetch: ReturnType<typeof vi.fn>,
  pathname: string
): number {
  return mockFetch.mock.calls.filter(
    ([url]) =>
      new URL(typeof url === "string" ? url : (url as URL).href).pathname ===
      pathname
  ).length;
}

describe("pile fleet realtime mode", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalApiKey: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "pile-fleet-rt-"));
    originalHome = process.env.HOME;
    originalApiKey = process.env.PILE_API_KEY;
    process.env.HOME = home;
    process.env.PILE_API_KEY = "test-api-key";
  });

  afterAll(() => {
    process.env.HOME = originalHome;
    process.env.PILE_API_KEY = originalApiKey;
    rmSync(home, { recursive: true, force: true });
  });

  function createFleetFetch() {
    const sessions: Record<string, unknown>[] = [
      session({
        id: "sess-live",
        issueId: "issue-live",
        status: "running",
        createdAt: "2026-09-30T11:00:00.000Z",
      }),
      session({
        id: "sess-done",
        issueId: "issue-done",
        status: "failed",
        endedAt: "2026-09-30T11:30:00.000Z",
      }),
    ];
    return vi.fn().mockImplementation((url: URL | string) => {
      const pathname = new URL(typeof url === "string" ? url : url.href)
        .pathname;
      if (pathname === "/workspaces/ws-1/agent/sessions") {
        return jsonResponse({ sessions });
      }
      if (pathname === "/workspaces/ws-1/agent/fleet-health") {
        return jsonResponse({
          live: 1,
          missingEndedAt: 0,
          providers: [],
        });
      }
      if (pathname === "/workspaces/ws-1/agent/sessions/sess-live/state") {
        return jsonResponse({
          session: sessions[0],
          provider: { state: "running", logs: "lane-one\nstill going" },
        });
      }
      return jsonResponse({ id: "x", identifier: "ISS-1" });
    });
  }

  it("connects with ?token= and updates rows from events without refetching", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press } = createFakeView();
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      {
        fetch: mockFetch,
        createView: () => view,
        now: () => NOW,
        createSocket: (url) => {
          urls.push(url);
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      }
    );

    await waitForRender(rendered, (m) => m.logText.includes("lane-one"));
    const socket = sockets[0];
    expect(socket).toBeDefined();
    expect(urls[0]).toBe(
      "ws://127.0.0.1:8787/workspaces/ws-1/realtime?token=test-api-key"
    );
    expect(countCalls(mockFetch, "/workspaces/ws-1/agent/sessions")).toBe(1);

    socket!.open();
    const vm = await waitForRender(rendered, (m) =>
      m.statusLine.includes("realtime")
    );
    expect(vm.statusLine).toContain("1 live");

    // open triggers a resync; wait for it to settle before counting calls.
    await vi.waitFor(() =>
      expect(countCalls(mockFetch, "/workspaces/ws-1/agent/sessions")).toBe(2)
    );

    socket!.emit(
      sessionEvent(
        {
          id: "sess-new",
          issueId: "issue-new",
          agentId: "codex",
          provider: "codex",
          status: "running",
          createdAt: "2026-09-30T11:40:00.000Z",
          updatedAt: "2026-09-30T11:41:00.000Z",
        },
        { id: "issue-new", identifier: "ISS-12" }
      )
    );

    const next = await waitForRender(
      rendered,
      (m) => m.rows.length === 3 && m.rows[0]?.id === "sess-live"
    );
    expect(next.rows.map((r) => r.id)).toContain("sess-new");
    expect(next.rows.find((r) => r.id === "sess-new")?.issue).toBe("ISS-12");
    expect(next.statusLine).toContain("2 live");
    // The event upsert alone updated the table — no third list call.
    expect(countCalls(mockFetch, "/workspaces/ws-1/agent/sessions")).toBe(2);

    press("q");
    expect(await done).toBe(0);
    expect(view.destroy).toHaveBeenCalled();
  });

  it("refreshes the log tail when an event lands on the selected lane", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press } = createFakeView();
    const sockets: FakeSocket[] = [];

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      {
        fetch: mockFetch,
        createView: () => view,
        now: () => NOW,
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      }
    );

    await waitForRender(rendered, (m) => m.logText.includes("lane-one"));
    const socket = sockets[0]!;
    socket.open();
    // The reconnect resync re-fetches the selected lane's tail too — wait for
    // that second /state call to land before snapshotting.
    await vi.waitFor(() =>
      expect(
        countCalls(mockFetch, "/workspaces/ws-1/agent/sessions/sess-live/state")
      ).toBe(2)
    );
    const stateCallsBefore = 2;

    socket.emit(
      sessionEvent(
        {
          id: "sess-live",
          issueId: "issue-live",
          agentId: "devin-cli",
          provider: "devin-cli",
          status: "running",
          createdAt: "2026-09-30T11:00:00.000Z",
          updatedAt: "2026-09-30T11:45:00.000Z",
          lastProgressAt: "2026-09-30T11:45:00.000Z",
        },
        { id: "issue-live", identifier: "ISS-10" }
      )
    );

    await vi.waitFor(() =>
      expect(
        countCalls(mockFetch, "/workspaces/ws-1/agent/sessions/sess-live/state")
      ).toBe(stateCallsBefore + 1)
    );

    press("q");
    expect(await done).toBe(0);
  });

  it("updates the PR column on pr.updated events", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press } = createFakeView();
    const sockets: FakeSocket[] = [];

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      {
        fetch: mockFetch,
        createView: () => view,
        now: () => NOW,
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      }
    );

    await waitForRender(rendered, (m) => m.logText.includes("lane-one"));
    const socket = sockets[0]!;
    socket.open();
    await vi.waitFor(() =>
      expect(countCalls(mockFetch, "/workspaces/ws-1/agent/sessions")).toBe(2)
    );

    socket.emit({
      type: "pr.updated",
      organizationId: "ws-1",
      issue: {
        id: "issue-live",
        identifier: "ISS-10",
        prUrl: "https://github.com/VortexNYC/pile/pull/234",
        prState: "open",
        branch: "pile-264-realtime",
      },
    });

    const vm = await waitForRender(
      rendered,
      (m) => m.rows[0]?.prLabel === "VortexNYC/pile#234"
    );
    expect(vm.rows[0]?.issue).toBe("ISS-10");

    press("q");
    expect(await done).toBe(0);
  });

  it("shows terminal status from the event without hitting /state", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press } = createFakeView();
    const sockets: FakeSocket[] = [];

    const done = runCli(
      ["fleet", "--workspace", "ws-1", "--interval", "60000"],
      {
        fetch: mockFetch,
        createView: () => view,
        now: () => NOW,
        createSocket: () => {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      }
    );

    await waitForRender(rendered, (m) => m.logText.includes("lane-one"));
    const socket = sockets[0]!;
    socket.open();
    // Initial poll + reconnect resync each fetch the tail once.
    await vi.waitFor(() =>
      expect(
        countCalls(mockFetch, "/workspaces/ws-1/agent/sessions/sess-live/state")
      ).toBe(2)
    );

    socket.emit(
      sessionEvent(
        {
          id: "sess-live",
          issueId: "issue-live",
          agentId: "devin-cli",
          provider: "devin-cli",
          status: "completed",
          result: "shipped it",
          createdAt: "2026-09-30T11:00:00.000Z",
          updatedAt: "2026-09-30T11:50:00.000Z",
          endedAt: "2026-09-30T11:50:00.000Z",
        },
        { id: "issue-live", identifier: "ISS-10" },
        "agent_session.completed"
      )
    );

    const vm = await waitForRender(rendered, (m) =>
      m.logText.includes("[completed] shipped it")
    );
    expect(vm.rows[0]?.status).toBe("completed");
    expect(vm.statusLine).toContain("0 live");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      countCalls(mockFetch, "/workspaces/ws-1/agent/sessions/sess-live/state")
    ).toBe(2);

    press("q");
    expect(await done).toBe(0);
  });

  it("falls back to polling when the socket drops", async () => {
    const mockFetch = createFleetFetch();
    const { view, rendered, press } = createFakeView();
    const sockets: FakeSocket[] = [];

    const done = runCli(["fleet", "--workspace", "ws-1", "--interval", "50"], {
      fetch: mockFetch,
      createView: () => view,
      now: () => NOW,
      // Long backoff: the socket stays down for the whole test.
      reconnect: { initialMs: 60_000, maxMs: 60_000 },
      createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    await waitForRender(rendered, (m) => m.logText.includes("lane-one"));
    const socket = sockets[0]!;
    socket.open();
    await waitForRender(rendered, (m) => m.statusLine.includes("realtime"));
    const callsBefore = countCalls(
      mockFetch,
      "/workspaces/ws-1/agent/sessions"
    );

    socket.close();

    const vm = await waitForRender(
      rendered,
      (m) =>
        m.statusLine.includes("polling") &&
        countCalls(mockFetch, "/workspaces/ws-1/agent/sessions") > callsBefore
    );
    expect(vm.statusLine).not.toContain("realtime ·");

    press("q");
    expect(await done).toBe(0);
  });
});
