import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.js";
import {
  InboxModel,
  issueTone,
  priorityLabel,
  prStateLabel,
  shortAssignee,
  type InboxIssue,
  type InboxKey,
  type InboxPromptOptions,
  type InboxView,
  type InboxViewModel,
} from "./inbox.js";

function issue(overrides: Partial<InboxIssue> = {}): InboxIssue {
  return {
    id: "issue-1",
    identifier: "ISS-1",
    title: "Fix the thing",
    description: "a description",
    status: "todo",
    priority: "medium",
    teamId: "team-1",
    assigneeId: null,
    prUrl: null,
    prState: null,
    prCheckState: null,
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  };
}

function createFakeView(viewportRows = 20) {
  const rendered: InboxViewModel[] = [];
  let keyHandler: ((key: InboxKey) => void) | null = null;
  const prompts: InboxPromptOptions[] = [];
  const view: InboxView = {
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
    scrollDetail: vi.fn(),
    scrollDetailTo: vi.fn(),
    promptText(options) {
      prompts.push(options);
    },
    destroy: vi.fn(),
  };
  return {
    view,
    rendered,
    prompts,
    press(name: string, modifiers: Partial<InboxKey> = {}) {
      keyHandler?.({ name, ctrl: false, shift: false, ...modifiers });
    },
    submitPrompt(value: string) {
      prompts.at(-1)?.onSubmit(value);
    },
    cancelPrompt() {
      prompts.at(-1)?.onCancel();
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

describe("issueTone", () => {
  it("maps statuses to tones", () => {
    expect(issueTone(issue({ status: "triage" }))).toBe("warn");
    expect(issueTone(issue({ status: "backlog" }))).toBe("muted");
    expect(issueTone(issue({ status: "todo" }))).toBe("queued");
    expect(issueTone(issue({ status: "in_progress" }))).toBe("live");
    expect(issueTone(issue({ status: "done" }))).toBe("ok");
    expect(issueTone(issue({ status: "canceled" }))).toBe("muted");
  });
});

describe("priorityLabel", () => {
  it("shortens priorities", () => {
    expect(priorityLabel("urgent")).toBe("URG");
    expect(priorityLabel("high")).toBe("HI");
    expect(priorityLabel("medium")).toBe("MED");
    expect(priorityLabel("low")).toBe("LOW");
  });
});

describe("prStateLabel", () => {
  it("combines state and check state", () => {
    expect(
      prStateLabel(
        issue({ prUrl: "https://github.com/a/b/pull/1", prState: "open" })
      )
    ).toBe("open");
    expect(
      prStateLabel(
        issue({
          prUrl: "https://github.com/a/b/pull/1",
          prState: "open",
          prCheckState: "success",
        })
      )
    ).toBe("open✓");
    expect(
      prStateLabel(
        issue({
          prUrl: "https://github.com/a/b/pull/1",
          prState: "open",
          prCheckState: "failure",
        })
      )
    ).toBe("open✗");
    expect(prStateLabel(issue())).toBe("");
  });
});

describe("shortAssignee", () => {
  it("keeps agent ids, shortens user uuids", () => {
    expect(shortAssignee("devin-cli")).toBe("devin-cli");
    expect(shortAssignee("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(
      "f47ac10b"
    );
    expect(shortAssignee(null)).toBe("");
  });
});

describe("InboxModel", () => {
  it("keeps selection stable across repolls", () => {
    const model = new InboxModel();
    model.setIssues([
      issue({ id: "a", identifier: "ISS-1" }),
      issue({ id: "b", identifier: "ISS-2" }),
    ]);
    model.moveSelection(1);
    model.setIssues([
      issue({ id: "b", identifier: "ISS-2" }),
      issue({ id: "a", identifier: "ISS-1" }),
    ]);
    expect(model.selected?.id).toBe("b");
  });

  it("windows rows around the selection", () => {
    const model = new InboxModel();
    model.setIssues(
      Array.from({ length: 10 }, (_, i) =>
        issue({
          id: `i-${i}`,
          createdAt: `2026-09-30T10:0${i}:00.000Z`,
        })
      )
    );
    model.selectLast();
    const vm = model.viewModel(NOW, 4);
    expect(vm.selectedIndex).toBe(9);
    expect(vm.topIndex).toBe(6);
    expect(vm.rows.map((r) => r.id)).toEqual(["i-6", "i-7", "i-8", "i-9"]);
  });

  it("merges an updated issue in place", () => {
    const model = new InboxModel();
    model.setIssues([issue({ id: "a", status: "todo" })]);
    model.upsertIssue(issue({ id: "a", status: "in_progress" }));
    expect(model.issueList[0]?.status).toBe("in_progress");
    expect(model.viewModel(NOW, 10).rows[0]?.status).toBe("in_progress");
  });

  it("renders description and comments in the detail pane", () => {
    const model = new InboxModel();
    model.setIssues([issue({ id: "a", description: "the bug" })]);
    model.setComments("a", [
      {
        id: "c-1",
        authorId: "devin-cli",
        externalAuthor: null,
        body: "on it",
        createdAt: "2026-09-30T10:30:00.000Z",
      },
    ]);
    const vm = model.viewModel(NOW, 10);
    expect(vm.detailTitle).toContain("ISS-1");
    expect(vm.detailText).toContain("the bug");
    expect(vm.detailText).toContain("comments (1)");
    expect(vm.detailText).toContain("devin-cli: on it");
  });

  it("ignores comments that arrive after the selection moved", () => {
    const model = new InboxModel();
    model.setIssues([issue({ id: "a" }), issue({ id: "b" })]);
    model.moveSelection(1);
    model.setComments("a", [
      {
        id: "c-1",
        authorId: null,
        externalAuthor: null,
        body: "stale",
        createdAt: "2026-09-30T10:30:00.000Z",
      },
    ]);
    expect(model.viewModel(NOW, 10).detailText).toContain("comments (…)");
    expect(model.viewModel(NOW, 10).detailText).not.toContain("stale");
  });

  it("drives the assign picker", () => {
    const model = new InboxModel();
    model.setIssues([issue({ id: "a" })]);
    model.openPicker([
      { label: "unassign", description: "", value: null },
      { label: "devin-cli", description: "agent", value: "devin-cli" },
    ]);
    expect(model.currentMode).toBe("assign");
    expect(model.movePicker(1)).toBe(true);
    expect(model.pickerSelection?.value).toBe("devin-cli");
    expect(model.movePicker(1)).toBe(false);
    model.closePicker();
    expect(model.currentMode).toBe("list");
    const vm = model.viewModel(NOW, 10);
    expect(vm.pickerLines).toHaveLength(0);
  });

  it("cycles the status filter", () => {
    const model = new InboxModel();
    expect(model.cycleStatusFilter()).toBe("triage");
    expect(model.filter.status).toBe("triage");
    model.cycleStatusFilter();
    expect(model.filter.status).toBe("backlog");
    model.cycleStatusFilter();
    model.cycleStatusFilter();
    model.cycleStatusFilter();
    model.cycleStatusFilter();
    model.cycleStatusFilter();
    expect(model.filter.status).toBeUndefined();
  });

  it("resolves team keys to ids for the filter", () => {
    const model = new InboxModel();
    model.setTeams([{ id: "team-1", key: "ISS", name: "Pile" }]);
    expect(model.resolveTeamId("iss")).toBe("team-1");
    expect(model.resolveTeamId("team-1")).toBe("team-1");
    expect(model.resolveTeamId("nope")).toBeUndefined();
    model.setFilter({ teamId: "team-1" });
    expect(model.viewModel(NOW, 10).statusLine).toContain("team:ISS");
  });

  it("surfaces notices and errors in the status line", () => {
    const model = new InboxModel();
    model.setNotice("ISS-1 → done");
    expect(model.viewModel(NOW, 10).statusLine).toContain("ISS-1 → done");
    model.setNotice(null);
    model.setError("GET /issues returned 500");
    expect(model.viewModel(NOW, 10).statusLine).toContain("500");
  });
});

async function waitForRender(
  rendered: InboxViewModel[],
  predicate: (vm: InboxViewModel) => boolean
): Promise<InboxViewModel> {
  return await vi.waitFor(
    () => {
      const vm = rendered.at(-1);
      expect(vm).toBeDefined();
      expect(predicate(vm as InboxViewModel)).toBe(true);
      return vm as InboxViewModel;
    },
    { timeout: 5000, interval: 10 }
  );
}

function createInboxFetch() {
  const issues: Record<string, unknown>[] = [
    issue({
      id: "issue-a",
      identifier: "ISS-10",
      title: "First issue",
      status: "todo",
      description: "first body",
      prUrl: "https://github.com/VortexNYC/pile/pull/234",
      prState: "open",
      prCheckState: "success",
    }),
    issue({
      id: "issue-b",
      identifier: "ISS-11",
      title: "Second issue",
      status: "triage",
      description: "second body",
    }),
  ];
  const comments: Record<string, unknown>[] = [
    {
      id: "c-1",
      authorId: null,
      externalAuthor: "jam",
      body: "needs repro",
      createdAt: "2026-09-30T10:30:00.000Z",
    },
  ];
  const mockFetch = vi.fn().mockImplementation((url, init) => {
    const requestUrl = new URL(
      typeof url === "string" ? url : (url as URL).href
    );
    const pathname = requestUrl.pathname;
    const method =
      init && typeof init === "object" && "method" in init
        ? String(init.method)
        : "GET";
    const bodyText =
      init && typeof init === "object" && typeof init.body === "string"
        ? init.body
        : null;

    if (pathname === "/workspaces/ws-1/teams") {
      return jsonResponse({
        teams: [{ id: "team-1", key: "ISS", name: "Pile" }],
      });
    }
    if (pathname === "/workspaces/ws-1/memberships") {
      return jsonResponse({
        memberships: [
          {
            id: "m-1",
            organizationId: "ws-1",
            userId: "jam",
            role: "owner",
            createdAt: "2026-09-30T00:00:00.000Z",
          },
        ],
      });
    }
    if (pathname === "/workspaces/ws-1/agent/providers") {
      return jsonResponse([{ agentId: "devin-cli" }]);
    }
    if (pathname === "/workspaces/ws-1/issues" && method === "GET") {
      const statusFilter = requestUrl.searchParams.get("status");
      const search = requestUrl.searchParams.get("search");
      let filtered = issues;
      if (statusFilter !== null) {
        filtered = filtered.filter((i) => i.status === statusFilter);
      }
      if (search !== null) {
        filtered = filtered.filter((i) =>
          String(i.title).toLowerCase().includes(search.toLowerCase())
        );
      }
      return jsonResponse({ issues: filtered });
    }
    if (
      pathname === "/workspaces/ws-1/issues/issue-a/comments" &&
      method === "GET"
    ) {
      return jsonResponse({ comments });
    }
    if (
      pathname === "/workspaces/ws-1/issues/issue-b/comments" &&
      method === "GET"
    ) {
      return jsonResponse({ comments: [] });
    }
    if (
      pathname === "/workspaces/ws-1/issues/issue-a/comments" &&
      method === "POST"
    ) {
      const body = bodyText !== null ? JSON.parse(bodyText) : {};
      const created = {
        id: `c-${comments.length + 1}`,
        authorId: "user-1",
        externalAuthor: null,
        body: body.body,
        createdAt: "2026-09-30T12:00:00.000Z",
      };
      comments.push(created);
      return jsonResponse(created, 201);
    }
    if (pathname === "/workspaces/ws-1/issues/issue-a" && method === "PATCH") {
      const body = bodyText !== null ? JSON.parse(bodyText) : {};
      Object.assign(issues[0], body);
      return jsonResponse(issues[0]);
    }
    if (
      pathname === "/workspaces/ws-1/issues/issue-a/assign" &&
      method === "POST"
    ) {
      const body = bodyText !== null ? JSON.parse(bodyText) : {};
      issues[0].assigneeId = body.assigneeId;
      return jsonResponse({ issue: issues[0] });
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  });
  return { mockFetch, issues, comments };
}

describe("pile inbox", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalApiKey: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "pile-inbox-"));
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

  it("exits 1 without --workspace", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitCode = await runCli(["inbox"]);
    expect(exitCode).toBe(1);
    spy.mockRestore();
  });

  it("renders the issue table and detail pane, then exits on q", async () => {
    const { mockFetch } = createInboxFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      ["inbox", "--workspace", "ws-1", "--interval", "60000"],
      {
        fetch: mockFetch,
        createInboxView: () => view,
        now: () => NOW,
      }
    );

    const vm = await waitForRender(
      rendered,
      (m) => m.rows.length === 2 && m.detailText.includes("needs repro")
    );
    expect(vm.rows.map((r) => r.identifier)).toEqual(["ISS-10", "ISS-11"]);
    expect(vm.rows[0]?.prLabel).toBe("open✓");
    expect(vm.rows[0]?.team).toBe("ISS");
    expect(vm.detailTitle).toContain("ISS-10");
    expect(vm.detailText).toContain("first body");
    expect(vm.detailText).toContain("jam: needs repro");

    press("q");
    expect(await done).toBe(0);
    expect(view.destroy).toHaveBeenCalled();
  });

  it("moves issue status via PATCH on b/t/i/d keys", async () => {
    const { mockFetch, issues } = createInboxFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      ["inbox", "--workspace", "ws-1", "--interval", "60000"],
      {
        fetch: mockFetch,
        createInboxView: () => view,
        now: () => NOW,
      }
    );

    await waitForRender(rendered, (m) => m.rows.length === 2);

    press("i");
    const vm = await waitForRender(
      rendered,
      (m) =>
        m.statusLine.includes("ISS-10 → in_progress") ||
        m.rows[0]?.status === "in_progress"
    );
    expect(vm.rows[0]?.status).toBe("in_progress");
    const patchCalls = mockFetch.mock.calls.filter(([url, init]) => {
      const u = new URL(typeof url === "string" ? url : (url as URL).href);
      return (
        u.pathname === "/workspaces/ws-1/issues/issue-a" &&
        init &&
        typeof init === "object" &&
        "method" in init &&
        init.method === "PATCH"
      );
    });
    expect(patchCalls).toHaveLength(1);
    expect(issues[0]?.status).toBe("in_progress");

    press("q");
    expect(await done).toBe(0);
  });

  it("assigns via the picker (a, j, enter)", async () => {
    const { mockFetch, issues } = createInboxFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      ["inbox", "--workspace", "ws-1", "--interval", "60000"],
      {
        fetch: mockFetch,
        createInboxView: () => view,
        now: () => NOW,
      }
    );

    await waitForRender(rendered, (m) => m.rows.length === 2);

    press("a");
    await waitForRender(
      rendered,
      (m) => m.mode === "assign" && m.pickerLines.length === 3
    );

    press("j");
    press("j");
    press("return");
    await waitForRender(
      rendered,
      (m) => m.mode === "list" && (m.statusLine.includes("devin-cli") || false)
    );
    expect(issues[0]?.assigneeId).toBe("devin-cli");
    const assignCalls = mockFetch.mock.calls.filter(([url, init]) => {
      const u = new URL(typeof url === "string" ? url : (url as URL).href);
      return (
        u.pathname === "/workspaces/ws-1/issues/issue-a/assign" &&
        init &&
        typeof init === "object" &&
        "method" in init &&
        init.method === "POST"
      );
    });
    expect(assignCalls).toHaveLength(1);

    press("q");
    expect(await done).toBe(0);
  });

  it("posts a comment via the c prompt", async () => {
    const { mockFetch, comments } = createInboxFetch();
    const { view, rendered, press, prompts, submitPrompt } = createFakeView();

    const done = runCli(
      ["inbox", "--workspace", "ws-1", "--interval", "60000"],
      {
        fetch: mockFetch,
        createInboxView: () => view,
        now: () => NOW,
      }
    );

    await waitForRender(rendered, (m) => m.rows.length === 2);

    press("c");
    expect(prompts).toHaveLength(1);
    await waitForRender(rendered, (m) => m.mode === "input");

    // while the prompt owns the keyboard, q does not quit
    press("q");
    expect(prompts).toHaveLength(1);

    submitPrompt("  shipped in #234  ");
    await waitForRender(
      rendered,
      (m) => m.mode === "list" && m.detailText.includes("shipped in #234")
    );
    expect(comments.at(-1)?.body).toBe("shipped in #234");

    press("q");
    expect(await done).toBe(0);
  });

  it("filters by status via the f cycle and search via /", async () => {
    const { mockFetch } = createInboxFetch();
    const { view, rendered, press, prompts, submitPrompt } = createFakeView();

    const done = runCli(
      ["inbox", "--workspace", "ws-1", "--interval", "60000"],
      {
        fetch: mockFetch,
        createInboxView: () => view,
        now: () => NOW,
      }
    );

    await waitForRender(rendered, (m) => m.rows.length === 2);

    press("f");
    await waitForRender(
      rendered,
      (m) => m.statusLine.includes("status:triage") && m.rows.length === 1
    );

    press("f");
    await waitForRender(
      rendered,
      (m) => m.statusLine.includes("status:backlog") && m.rows.length === 0
    );

    press("f");
    press("f");
    press("f");
    press("f");
    press("f");
    await waitForRender(
      rendered,
      (m) => !m.statusLine.includes("status:") && m.rows.length === 2
    );

    press("/");
    expect(prompts).toHaveLength(1);
    submitPrompt("second");
    await waitForRender(
      rendered,
      (m) => m.statusLine.includes('search:"second"') && m.rows.length === 1
    );
    expect(rendered.at(-1)?.rows[0]?.identifier).toBe("ISS-11");

    const issueCalls = mockFetch.mock.calls.filter(([url]) => {
      const u = new URL(typeof url === "string" ? url : (url as URL).href);
      return (
        u.pathname === "/workspaces/ws-1/issues" &&
        u.searchParams.get("search") === "second"
      );
    });
    expect(issueCalls.length).toBeGreaterThan(0);

    press("q");
    expect(await done).toBe(0);
  });

  it("honors --status and --team flags on load", async () => {
    const { mockFetch } = createInboxFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      [
        "inbox",
        "--workspace",
        "ws-1",
        "--interval",
        "60000",
        "--status",
        "triage",
        "--team",
        "iss",
      ],
      { fetch: mockFetch, createInboxView: () => view, now: () => NOW }
    );

    const vm = await waitForRender(rendered, (m) => m.rows.length === 1);
    expect(vm.rows[0]?.identifier).toBe("ISS-11");
    expect(vm.statusLine).toContain("status:triage");
    expect(vm.statusLine).toContain("team:ISS");

    const listCalls = mockFetch.mock.calls.filter(([url]) => {
      const u = new URL(typeof url === "string" ? url : (url as URL).href);
      return u.pathname === "/workspaces/ws-1/issues";
    });
    expect(
      listCalls.some(([url]) => {
        const u = new URL(typeof url === "string" ? url : (url as URL).href);
        return (
          u.searchParams.get("status") === "triage" &&
          u.searchParams.get("teamId") === "team-1"
        );
      })
    ).toBe(true);

    press("q");
    expect(await done).toBe(0);
  });

  it("opens the linked PR with o", async () => {
    const { mockFetch } = createInboxFetch();
    const { view, rendered, press } = createFakeView();
    const spawnMock = vi.fn(() => ({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    }));

    const done = runCli(
      ["inbox", "--workspace", "ws-1", "--interval", "60000"],
      {
        fetch: mockFetch,
        createInboxView: () => view,
        spawn: spawnMock,
        now: () => NOW,
      }
    );

    await waitForRender(rendered, (m) => m.rows.length === 2);

    press("o");
    await waitForRender(rendered, (m) => m.statusLine.includes("opened"));
    expect(spawnMock).toHaveBeenCalledWith(
      expect.any(String),
      ["https://github.com/VortexNYC/pile/pull/234"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    press("q");
    expect(await done).toBe(0);
  });

  it("works as bare `pile issues`", async () => {
    const { mockFetch } = createInboxFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      ["issues", "--workspace", "ws-1", "--interval", "60000"],
      { fetch: mockFetch, createInboxView: () => view, now: () => NOW }
    );

    await waitForRender(rendered, (m) => m.rows.length === 2);
    press("q");
    expect(await done).toBe(0);
  });

  it("reports poll errors in the status line", async () => {
    const mockFetch = vi.fn().mockImplementation((url) => {
      const pathname = new URL(typeof url === "string" ? url : url.href)
        .pathname;
      if (pathname === "/workspaces/ws-1/teams") {
        return jsonResponse({ teams: [] });
      }
      return Promise.resolve(new Response("boom", { status: 500 }));
    });
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      ["inbox", "--workspace", "ws-1", "--interval", "60000"],
      {
        fetch: mockFetch,
        createInboxView: () => view,
        now: () => NOW,
      }
    );

    const vm = await waitForRender(rendered, (m) =>
      m.statusLine.includes("500")
    );
    expect(vm.statusLine).toContain("GET /issues returned 500");

    press("q");
    expect(await done).toBe(0);
  });
});
