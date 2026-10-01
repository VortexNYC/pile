import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.js";
import {
  eventLines,
  InboxModel,
  priorityTone,
  sortTickets,
  ticketDetailText,
  ticketStatusTone,
  type InboxKey,
  type InboxView,
  type InboxViewModel,
  type SupportTicket,
  type TicketEvent,
} from "./support.js";

function ticket(overrides: Partial<SupportTicket> = {}): SupportTicket {
  return {
    id: "t-1",
    number: 1,
    title: "Login is broken",
    status: "todo",
    priority: "medium",
    sourceChannel: "chat",
    externalSource: "manual",
    issueId: null,
    snoozedUntil: null,
    lastCustomerMessageAt: null,
    lastAgentMessageAt: null,
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
    customerEmail: "jane@acme.com",
    customerName: "Jane Doe",
    companies: [],
    labels: [],
    assignees: [],
    events: [],
    ...overrides,
  };
}

function ticketJson(overrides: Record<string, unknown> = {}) {
  return {
    id: "t-1",
    organizationId: "ws-1",
    customerId: "cust-1",
    number: 1,
    title: "Login is broken",
    status: "todo",
    priority: "medium",
    sourceChannel: "chat",
    externalSource: "manual",
    issueId: null,
    snoozedUntil: null,
    lastCustomerMessageAt: null,
    lastAgentMessageAt: null,
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
    customer: {
      id: "cust-1",
      email: "jane@acme.com",
      fullName: "Jane Doe",
      phone: null,
    },
    companies: [],
    identities: [],
    labels: [],
    assignees: [],
    events: [],
    ...overrides,
  };
}

function event(overrides: Partial<TicketEvent> = {}): TicketEvent {
  return {
    id: "ev-1",
    type: "message",
    subType: null,
    actorType: "customer",
    createdAt: "2026-09-30T10:02:00.000Z",
    message: {
      direction: "inbound",
      textContent: "hi, login is broken",
      channel: "chat",
    },
    note: null,
    ...overrides,
  };
}

function createFakeView(viewportRows = 20) {
  const rendered: InboxViewModel[] = [];
  let keyHandler: ((key: InboxKey) => void) | null = null;
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
    destroy: vi.fn(),
  };
  return {
    view,
    rendered,
    press(name: string, modifiers: Partial<InboxKey> = {}) {
      keyHandler?.({ name, ctrl: false, shift: false, ...modifiers });
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

describe("sortTickets", () => {
  it("orders todo first by priority then most recent customer touch", () => {
    const sorted = sortTickets([
      ticket({ id: "done-1", status: "done" }),
      ticket({
        id: "low-new",
        status: "todo",
        priority: "low",
        lastCustomerMessageAt: "2026-09-30T11:00:00.000Z",
      }),
      ticket({ id: "urgent", status: "todo", priority: "urgent" }),
      ticket({
        id: "low-old",
        status: "todo",
        priority: "low",
        lastCustomerMessageAt: "2026-09-30T09:00:00.000Z",
      }),
      ticket({
        id: "snz",
        status: "snoozed",
        snoozedUntil: "2026-10-01T00:00:00.000Z",
      }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual([
      "urgent",
      "low-new",
      "low-old",
      "snz",
      "done-1",
    ]);
  });

  it("sorts snoozed by soonest resurface and done by most recent update", () => {
    const sorted = sortTickets([
      ticket({
        id: "done-old",
        status: "done",
        updatedAt: "2026-09-28T10:00:00.000Z",
      }),
      ticket({
        id: "snz-late",
        status: "snoozed",
        snoozedUntil: "2026-10-07T00:00:00.000Z",
      }),
      ticket({
        id: "snz-soon",
        status: "snoozed",
        snoozedUntil: "2026-10-01T00:00:00.000Z",
      }),
      ticket({
        id: "done-new",
        status: "done",
        updatedAt: "2026-09-30T10:00:00.000Z",
      }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual([
      "snz-soon",
      "snz-late",
      "done-new",
      "done-old",
    ]);
  });
});

describe("tones", () => {
  it("maps status to tone", () => {
    expect(ticketStatusTone(ticket({ status: "todo" }))).toBe("live");
    expect(ticketStatusTone(ticket({ status: "done" }))).toBe("ok");
    expect(ticketStatusTone(ticket({ status: "snoozed" }))).toBe("muted");
  });

  it("maps priority to tone", () => {
    expect(priorityTone("urgent")).toBe("fail");
    expect(priorityTone("high")).toBe("warn");
    expect(priorityTone("medium")).toBe("queued");
    expect(priorityTone("low")).toBe("muted");
  });
});

describe("detail rendering", () => {
  it("renders inbound/outbound messages and notes", () => {
    expect(
      eventLines(
        event({
          message: {
            direction: "outbound",
            textContent: "on it",
            channel: "email",
          },
        })
      )[0]
    ).toContain("→ outbound · email");
    expect(
      eventLines(
        event({ type: "note", message: null, note: { body: "internal" } })
      )[0]
    ).toContain("note");
    expect(
      eventLines(
        event({
          type: "status_change",
          subType: "done",
          message: null,
          actorType: "user",
        })
      )[0]
    ).toContain("status_change:done · user");
  });

  it("renders the ticket header, meta, and thread", () => {
    const text = ticketDetailText(
      ticket({
        number: 42,
        title: "Export fails",
        status: "snoozed",
        snoozedUntil: "2026-10-07T00:00:00.000Z",
        issueId: "issue-9",
        labels: ["bug"],
        companies: ["Acme"],
        events: [event()],
      }),
      NOW
    );
    expect(text).toContain("#42 — Export fails");
    expect(text).toContain("status snoozed");
    expect(text).toContain("companies Acme");
    expect(text).toContain("labels bug");
    expect(text).toContain("snoozed until 10-07 00:00");
    expect(text).toContain("linked issue issue-9");
    expect(text).toContain("hi, login is broken");
  });
});

describe("InboxModel", () => {
  it("keeps the selected ticket stable across repolls", () => {
    const model = new InboxModel();
    model.setTickets([ticket({ id: "a" }), ticket({ id: "b" })]);
    model.moveSelection(1);
    expect(model.selected?.id).toBe("b");
    model.setTickets([ticket({ id: "b" }), ticket({ id: "a" })]);
    expect(model.selected?.id).toBe("b");
  });

  it("replaces a ticket in place after a status transition", () => {
    const model = new InboxModel();
    model.setTickets([ticket({ id: "a" }), ticket({ id: "b" })]);
    model.replaceTicket(ticket({ id: "a", status: "done" }));
    expect(model.ticketList[0]?.id).toBe("b");
    expect(model.ticketList[1]?.status).toBe("done");
  });

  it("cycles the filter and resets selection", () => {
    const model = new InboxModel("todo");
    model.setTickets([ticket({ id: "a" }), ticket({ id: "b" })]);
    model.moveSelection(1);
    expect(model.cycleFilter()).toBe("snoozed");
    expect(model.selected).toBeNull();
    expect(model.cycleFilter()).toBe("done");
    expect(model.cycleFilter()).toBe("all");
    expect(model.cycleFilter()).toBe("todo");
  });

  it("windows rows around the selection", () => {
    const model = new InboxModel();
    model.setTickets(
      Array.from({ length: 10 }, (_, i) => ticket({ id: `t-${i}` }))
    );
    model.selectLast();
    const vm = model.viewModel(NOW, 4);
    expect(vm.selectedIndex).toBe(9);
    expect(vm.rows.map((r) => r.id)).toEqual(["t-6", "t-7", "t-8", "t-9"]);
  });

  it("shows snooze targets in the status column", () => {
    const model = new InboxModel();
    model.setTickets([
      ticket({
        id: "a",
        status: "snoozed",
        snoozedUntil: "2026-10-02T09:00:00.000Z",
      }),
    ]);
    expect(model.viewModel(NOW, 10).rows[0]?.status).toBe("snz→10-02 09:00");
  });

  it("renders counts and the pending action in the status line", () => {
    const model = new InboxModel();
    model.setCounts({
      todo: 4,
      done: 12,
      snoozed: 2,
      mine: 1,
      unassigned: 3,
    });
    model.setAction("#7 → done…");
    const vm = model.viewModel(NOW, 10);
    expect(vm.statusLine).toContain("4 todo");
    expect(vm.statusLine).toContain("1 mine");
    expect(vm.statusLine).toContain("3 unassigned");
    expect(vm.statusLine).toContain("#7 → done…");
  });

  it("surfaces a poll error and an empty-filter hint", () => {
    const model = new InboxModel();
    model.setError("GET /support/tickets returned 500");
    const vm = model.viewModel(NOW, 10);
    expect(vm.statusLine).toContain("GET /support/tickets returned 500");
    expect(vm.detailText).toContain("press f to change filter");
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

describe("pile support", () => {
  let home: string;
  let originalHome: string | undefined;
  let originalApiKey: string | undefined;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "pile-support-"));
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

  function createSupportFetch() {
    const posted: { url: string; method: string; body: unknown }[] = [];
    const tickets: Record<string, ReturnType<typeof ticketJson>> = {
      "t-open": ticketJson({ id: "t-open", number: 7, status: "todo" }),
      "t-park": ticketJson({
        id: "t-park",
        number: 3,
        title: "Old thread",
        status: "snoozed",
        snoozedUntil: "2026-10-02T00:00:00.000Z",
      }),
    };
    const mockFetch = vi
      .fn()
      .mockImplementation((url: URL | string, init?: RequestInit) => {
        const parsed = new URL(typeof url === "string" ? url : url.href);
        const pathname = parsed.pathname;
        if (pathname === "/workspaces/ws-1/support/tickets") {
          const status = parsed.searchParams.get("status");
          return jsonResponse({
            tickets: Object.values(tickets).filter(
              (t) => status === null || t.status === status
            ),
            nextCursor: null,
          });
        }
        if (pathname === "/workspaces/ws-1/support/inbox/counts") {
          return jsonResponse({
            counts: { todo: 1, done: 8, snoozed: 1, mine: 0, unassigned: 1 },
          });
        }
        const transition =
          /^\/workspaces\/ws-1\/support\/tickets\/(t-[a-z]+)\/(done|todo|snoozed)$/u.exec(
            pathname
          );
        if (transition !== null) {
          posted.push({
            url: pathname,
            method: init?.method ?? "GET",
            body:
              typeof init?.body === "string"
                ? JSON.parse(init.body)
                : undefined,
          });
          const [, id, status] = transition;
          tickets[id] = { ...tickets[id], status };
          return jsonResponse({ ticket: tickets[id] });
        }
        return Promise.resolve(new Response("not found", { status: 404 }));
      });
    return { mockFetch, posted };
  }

  it("exits 1 without --workspace", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitCode = await runCli(["support"]);
    expect(exitCode).toBe(1);
    spy.mockRestore();
  });

  it("exits 1 on an invalid --status", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitCode = await runCli([
      "support",
      "--workspace",
      "ws-1",
      "--status",
      "bogus",
    ]);
    expect(exitCode).toBe(1);
    spy.mockRestore();
  });

  it("renders the ticket table and detail, then exits on q", async () => {
    const { mockFetch } = createSupportFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      [
        "support",
        "--workspace",
        "ws-1",
        "--status",
        "all",
        "--interval",
        "60000",
      ],
      { fetch: mockFetch, createView: () => view, now: () => NOW }
    );

    const vm = await waitForRender(
      rendered,
      (m) => m.rows.length === 2 && m.detailText.includes("#7")
    );
    expect(vm.rows.map((r) => r.id)).toEqual(["t-open", "t-park"]);
    expect(vm.rows[0]?.status).toBe("todo");
    expect(vm.rows[1]?.status).toContain("snz");
    expect(vm.statusLine).toContain("1 todo");
    expect(vm.detailTitle).toContain("#7");
    expect(vm.detailTitle).toContain("Jane Doe");

    press("q");
    expect(await done).toBe(0);
    expect(view.destroy).toHaveBeenCalled();
  });

  it("marks the selected ticket done and refetches", async () => {
    const { mockFetch, posted } = createSupportFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      [
        "support",
        "inbox",
        "--workspace",
        "ws-1",
        "--status",
        "all",
        "--interval",
        "60000",
      ],
      { fetch: mockFetch, createView: () => view, now: () => NOW }
    );

    await waitForRender(rendered, (m) => m.selectedId === "t-open");
    press("d");
    await waitForRender(rendered, (m) =>
      m.rows.some((r) => r.id === "t-open" && r.status === "done")
    );
    expect(posted).toEqual([
      {
        url: "/workspaces/ws-1/support/tickets/t-open/done",
        method: "POST",
        body: undefined,
      },
    ]);

    press("q");
    expect(await done).toBe(0);
    expect(view.destroy).toHaveBeenCalled();
  });

  it("snoozes with a future until on s", async () => {
    const { mockFetch, posted } = createSupportFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      [
        "support",
        "--workspace",
        "ws-1",
        "--status",
        "all",
        "--interval",
        "60000",
      ],
      { fetch: mockFetch, createView: () => view, now: () => NOW }
    );

    await waitForRender(rendered, (m) => m.selectedId === "t-open");
    press("s");
    await waitForRender(rendered, (m) =>
      m.rows.some((r) => r.id === "t-open" && r.status === "snoozed")
    );
    const call = posted.find((p) => p.url.endsWith("/snoozed"));
    expect(call?.method).toBe("POST");
    const body = call?.body as { until: string };
    expect(Date.parse(body.until)).toBe(NOW + 24 * 60 * 60 * 1000);

    press("q");
    expect(await done).toBe(0);
  });

  it("cycles the status filter with f", async () => {
    const { mockFetch } = createSupportFetch();
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      ["support", "--workspace", "ws-1", "--interval", "60000"],
      { fetch: mockFetch, createView: () => view, now: () => NOW }
    );

    await waitForRender(rendered, (m) => m.filter === "todo");
    const ticketCalls = () =>
      mockFetch.mock.calls
        .map(([u]) => new URL(typeof u === "string" ? u : (u as URL).href))
        .filter((u) => u.pathname === "/workspaces/ws-1/support/tickets");
    expect(ticketCalls().at(-1)?.searchParams.get("status")).toBe("todo");

    press("f");
    await waitForRender(rendered, (m) => m.filter === "snoozed");
    expect(ticketCalls().at(-1)?.searchParams.get("status")).toBe("snoozed");

    press("q");
    expect(await done).toBe(0);
  });

  it("keeps running and reports the error when the tickets poll fails", async () => {
    const mockFetch = vi.fn().mockImplementation((url: URL | string) => {
      const pathname = new URL(typeof url === "string" ? url : url.href)
        .pathname;
      if (pathname === "/workspaces/ws-1/support/inbox/counts") {
        return jsonResponse({
          counts: { todo: 0, done: 0, snoozed: 0, mine: 0, unassigned: 0 },
        });
      }
      return Promise.resolve(new Response("boom", { status: 500 }));
    });
    const { view, rendered, press } = createFakeView();

    const done = runCli(
      ["support", "--workspace", "ws-1", "--interval", "60000"],
      { fetch: mockFetch, createView: () => view, now: () => NOW }
    );

    const vm = await waitForRender(rendered, (m) =>
      m.statusLine.includes("500")
    );
    expect(vm.statusLine).toContain("GET /support/tickets returned 500");

    press("q");
    expect(await done).toBe(0);
    expect(view.destroy).toHaveBeenCalled();
  });
});
