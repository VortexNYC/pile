import {
  flagString,
  isJsonObject,
  parseJson,
  resolveConfig,
  type CliDeps,
} from "./cli.js";
import { formatAge, type StatusTone } from "./fleet.js";

export type TicketStatus = "todo" | "done" | "snoozed";
export type StatusFilter = "all" | TicketStatus;

// Inbox filter cycle order — `f` walks this list. Default is `todo`: the
// inbox is the actionable queue, everything else is review.
const FILTER_CYCLE: readonly StatusFilter[] = [
  "todo",
  "snoozed",
  "done",
  "all",
];

const TICKET_STATUSES = new Set<TicketStatus>(["todo", "done", "snoozed"]);

function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as ReadonlySet<string>).has(value);
}

export type TicketMessage = {
  readonly direction: string;
  readonly textContent: string;
  readonly channel: string;
};

export type TicketEvent = {
  readonly id: string;
  readonly type: string;
  readonly subType: string | null;
  readonly actorType: string;
  readonly createdAt: string;
  readonly message: TicketMessage | null;
  readonly note: { readonly body: string } | null;
};

export type SupportTicket = {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly status: TicketStatus;
  readonly priority: string;
  readonly sourceChannel: string;
  readonly externalSource: string;
  readonly issueId: string | null;
  readonly snoozedUntil: string | null;
  readonly lastCustomerMessageAt: string | null;
  readonly lastAgentMessageAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly customerEmail: string | null;
  readonly customerName: string | null;
  readonly companies: readonly string[];
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly events: readonly TicketEvent[];
};

export type InboxCounts = {
  readonly todo: number;
  readonly done: number;
  readonly snoozed: number;
  readonly mine: number;
  readonly unassigned: number;
};

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringList(value: unknown, pick?: (v: unknown) => string | null) {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s =
      pick !== undefined ? pick(item) : typeof item === "string" ? item : null;
    if (s !== null) out.push(s);
  }
  return out;
}

function parseTicketEvent(value: unknown): TicketEvent | null {
  if (!isJsonObject(value)) return null;
  const { id, type, actorType, createdAt } = value;
  if (
    typeof id !== "string" ||
    typeof type !== "string" ||
    typeof actorType !== "string" ||
    typeof createdAt !== "string"
  ) {
    return null;
  }
  let message: TicketMessage | null = null;
  if (isJsonObject(value.message)) {
    const { direction, textContent, channel } = value.message;
    if (
      typeof direction === "string" &&
      typeof textContent === "string" &&
      typeof channel === "string"
    ) {
      message = { direction, textContent, channel };
    }
  }
  const note =
    isJsonObject(value.note) && typeof value.note.body === "string"
      ? { body: value.note.body }
      : null;
  return {
    id,
    type,
    subType: optionalString(value.subType),
    actorType,
    createdAt,
    message,
    note,
  };
}

function parseSupportTicket(value: unknown): SupportTicket | null {
  if (!isJsonObject(value)) return null;
  const {
    id,
    number,
    title,
    status,
    priority,
    sourceChannel,
    externalSource,
    createdAt,
    updatedAt,
  } = value;
  if (
    typeof id !== "string" ||
    typeof number !== "number" ||
    typeof title !== "string" ||
    typeof status !== "string" ||
    !isTicketStatus(status) ||
    typeof priority !== "string" ||
    typeof sourceChannel !== "string" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }
  const customer = isJsonObject(value.customer) ? value.customer : {};
  return {
    id,
    number,
    title,
    status,
    priority,
    sourceChannel,
    externalSource:
      typeof externalSource === "string" ? externalSource : "manual",
    issueId: optionalString(value.issueId),
    snoozedUntil: optionalString(value.snoozedUntil),
    lastCustomerMessageAt: optionalString(value.lastCustomerMessageAt),
    lastAgentMessageAt: optionalString(value.lastAgentMessageAt),
    createdAt,
    updatedAt,
    customerEmail: optionalString(customer.email),
    customerName: optionalString(customer.fullName),
    companies: stringList(value.companies, (c) =>
      isJsonObject(c) ? optionalString(c.name) : null
    ),
    labels: stringList(value.labels, (l) =>
      isJsonObject(l) ? optionalString(l.name) : null
    ),
    assignees: stringList(value.assignees, (a) =>
      isJsonObject(a)
        ? (optionalString(a.name) ?? optionalString(a.assigneeId))
        : null
    ),
    events: Array.isArray(value.events)
      ? value.events
          .map(parseTicketEvent)
          .filter((e): e is TicketEvent => e !== null)
      : [],
  };
}

function parseInboxCounts(value: unknown): InboxCounts | null {
  if (!isJsonObject(value) || !isJsonObject(value.counts)) return null;
  const { todo, done, snoozed, mine, unassigned } = value.counts;
  if (
    typeof todo !== "number" ||
    typeof done !== "number" ||
    typeof snoozed !== "number" ||
    typeof mine !== "number" ||
    typeof unassigned !== "number"
  ) {
    return null;
  }
  return { todo, done, snoozed, mine, unassigned };
}

export type SupportApi = {
  listTickets(options: {
    readonly status: StatusFilter;
    readonly limit: number;
    readonly q?: string;
  }): Promise<SupportTicket[]>;
  setStatus(
    ticketId: string,
    status: TicketStatus,
    until?: string
  ): Promise<SupportTicket | null>;
  inboxCounts(): Promise<InboxCounts>;
};

export function createSupportApi(options: {
  readonly doFetch: typeof fetch;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly workspace: string;
}): SupportApi {
  const { doFetch, apiKey, workspace } = options;
  const baseUrl = options.baseUrl.replace(/\/$/u, "");
  const headers = new Headers({ Authorization: `Bearer ${apiKey}` });
  const ticketsBase = `${baseUrl}/workspaces/${workspace}/support/tickets`;

  return {
    async listTickets({ status, limit, q }) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (status !== "all") params.set("status", status);
      if (q !== undefined && q.length > 0) params.set("q", q);
      const res = await doFetch(`${ticketsBase}?${params.toString()}`, {
        headers,
      });
      if (!res.ok) {
        throw new Error(`GET /support/tickets returned ${res.status}`);
      }
      const parsed = parseJson(await res.text());
      if (!isJsonObject(parsed) || !Array.isArray(parsed.tickets)) {
        throw new Error("Unexpected /support/tickets response");
      }
      return parsed.tickets
        .map(parseSupportTicket)
        .filter((t): t is SupportTicket => t !== null);
    },

    async setStatus(ticketId, status, until) {
      // The dedicated transition endpoints record actor + event history for
      // free; PATCH would need the actor fields passed explicitly.
      const init: RequestInit =
        status === "snoozed"
          ? {
              method: "POST",
              headers: new Headers({
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              }),
              body: JSON.stringify({ until }),
            }
          : { method: "POST", headers };
      const res = await doFetch(`${ticketsBase}/${ticketId}/${status}`, init);
      if (!res.ok) {
        throw new Error(
          `POST /support/tickets/{id}/${status} returned ${res.status}`
        );
      }
      const parsed = parseJson(await res.text());
      return isJsonObject(parsed) ? parseSupportTicket(parsed.ticket) : null;
    },

    async inboxCounts() {
      const res = await doFetch(
        `${baseUrl}/workspaces/${workspace}/support/inbox/counts`,
        { headers }
      );
      if (!res.ok) {
        throw new Error(`GET /support/inbox/counts returned ${res.status}`);
      }
      const counts = parseInboxCounts(parseJson(await res.text()));
      if (counts === null) {
        throw new Error("Unexpected /support/inbox/counts response");
      }
      return counts;
    },
  };
}

const STATUS_ORDER: Record<TicketStatus, number> = {
  todo: 0,
  snoozed: 1,
  done: 2,
};

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 3,
  high: 2,
  medium: 1,
  low: 0,
};

function lastCustomerTouch(ticket: SupportTicket): string {
  return ticket.lastCustomerMessageAt ?? ticket.updatedAt;
}

// Triage order: open tickets first (urgent/high on top, most recent customer
// ping next), then snoozed by soonest resurface, then done by most recently
// touched.
export function sortTickets(
  tickets: readonly SupportTicket[]
): SupportTicket[] {
  return tickets.toSorted((a, b) => {
    const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDiff !== 0) return statusDiff;
    if (a.status === "todo") {
      const priorityDiff =
        (PRIORITY_ORDER[b.priority] ?? 1) - (PRIORITY_ORDER[a.priority] ?? 1);
      if (priorityDiff !== 0) return priorityDiff;
      return lastCustomerTouch(b).localeCompare(lastCustomerTouch(a));
    }
    if (a.status === "snoozed") {
      return (a.snoozedUntil ?? a.updatedAt).localeCompare(
        b.snoozedUntil ?? b.updatedAt
      );
    }
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function ticketStatusTone(ticket: SupportTicket): StatusTone {
  if (ticket.status === "todo") return "live";
  if (ticket.status === "done") return "ok";
  return "muted";
}

export function priorityTone(priority: string): StatusTone {
  switch (priority) {
    case "urgent":
      return "fail";
    case "high":
      return "warn";
    case "medium":
      return "queued";
    default:
      return "muted";
  }
}

export function customerLabel(ticket: SupportTicket): string {
  return ticket.customerName ?? ticket.customerEmail ?? "—";
}

function shortTs(iso: string): string {
  // "2026-09-30T10:02:11.000Z" → "09-30 10:02"
  if (!Number.isFinite(Date.parse(iso))) return "?";
  return iso.slice(5, 16).replace("T", " ");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

export function eventLines(event: TicketEvent): string[] {
  const ts = shortTs(event.createdAt);
  if (event.message !== null) {
    const arrow = event.message.direction === "inbound" ? "←" : "→";
    return [
      `${ts} ${arrow} ${event.message.direction} · ${event.message.channel}`,
      indent(event.message.textContent),
      "",
    ];
  }
  if (event.note !== null) {
    return [`${ts} note · ${event.actorType}`, indent(event.note.body), ""];
  }
  const sub = event.subType === null ? "" : `:${event.subType}`;
  return [`${ts} ${event.type}${sub} · ${event.actorType}`];
}

export function ticketDetailText(ticket: SupportTicket, now: number): string {
  const lines: string[] = [
    `#${ticket.number} — ${ticket.title}`,
    `status ${ticket.status} · priority ${ticket.priority} · via ${ticket.sourceChannel}` +
      (ticket.externalSource !== "manual" ? ` (${ticket.externalSource})` : ""),
    `customer ${customerLabel(ticket)}` +
      (ticket.customerEmail !== null && ticket.customerName !== null
        ? ` <${ticket.customerEmail}>`
        : ""),
  ];
  if (ticket.companies.length > 0) {
    lines.push(`companies ${ticket.companies.join(", ")}`);
  }
  const meta: string[] = [];
  if (ticket.assignees.length > 0)
    meta.push(`assignees ${ticket.assignees.join(", ")}`);
  if (ticket.labels.length > 0) meta.push(`labels ${ticket.labels.join(", ")}`);
  if (meta.length > 0) lines.push(meta.join(" · "));
  lines.push(
    `created ${formatAge(ticket.createdAt, now)} ago · updated ${formatAge(ticket.updatedAt, now)} ago`
  );
  if (ticket.status === "snoozed" && ticket.snoozedUntil !== null) {
    lines.push(`snoozed until ${shortTs(ticket.snoozedUntil)}`);
  }
  if (ticket.issueId !== null) {
    lines.push(`linked issue ${ticket.issueId}`);
  }
  lines.push("", "—".repeat(24), "");
  if (ticket.events.length === 0) {
    lines.push("no activity yet");
  } else {
    for (const event of ticket.events) {
      lines.push(...eventLines(event));
    }
  }
  return lines.join("\n");
}

export type TicketRow = {
  readonly id: string;
  readonly number: string;
  readonly status: string;
  readonly tone: StatusTone;
  readonly priority: string;
  readonly priorityTone: StatusTone;
  readonly customer: string;
  readonly channel: string;
  readonly age: string;
  readonly title: string;
};

export type InboxViewModel = {
  readonly rows: readonly TicketRow[];
  readonly topIndex: number;
  readonly selectedIndex: number;
  readonly selectedId: string | null;
  readonly detailTitle: string;
  readonly detailText: string;
  readonly statusLine: string;
  readonly filter: StatusFilter;
  readonly todoCount: number | null;
  readonly totalCount: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class InboxModel {
  private tickets: SupportTicket[] = [];
  private selectedId: string | null = null;
  private topIndex = 0;
  private counts: InboxCounts | null = null;
  private countsError: string | null = null;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private pendingAction: string | null = null;
  private filter: StatusFilter;

  constructor(filter: StatusFilter = "todo") {
    this.filter = filter;
  }

  get statusFilter(): StatusFilter {
    return this.filter;
  }

  get ticketList(): readonly SupportTicket[] {
    return this.tickets;
  }

  get selected(): SupportTicket | null {
    return this.tickets.find((t) => t.id === this.selectedId) ?? null;
  }

  setTickets(tickets: readonly SupportTicket[]): void {
    this.tickets = sortTickets(tickets);
    if (
      this.selectedId !== null &&
      !this.tickets.some((t) => t.id === this.selectedId)
    ) {
      this.selectedId = null;
    }
    if (this.selectedId === null && this.tickets.length > 0) {
      this.selectedId = this.tickets[0]?.id ?? null;
    }
    const index = this.tickets.findIndex((t) => t.id === this.selectedId);
    this.topIndex = Math.min(this.topIndex, Math.max(0, index));
  }

  replaceTicket(ticket: SupportTicket): void {
    this.tickets = sortTickets(
      this.tickets.map((t) => (t.id === ticket.id ? ticket : t))
    );
    const index = this.tickets.findIndex((t) => t.id === this.selectedId);
    this.topIndex = Math.min(this.topIndex, Math.max(0, index));
  }

  // Returns the new filter so the command can refetch.
  cycleFilter(): StatusFilter {
    const index = FILTER_CYCLE.indexOf(this.filter);
    this.filter = FILTER_CYCLE[(index + 1) % FILTER_CYCLE.length] ?? "todo";
    this.selectedId = null;
    this.topIndex = 0;
    return this.filter;
  }

  setCounts(counts: InboxCounts): void {
    this.counts = counts;
    this.countsError = null;
  }

  setCountsError(message: string): void {
    this.countsError = message;
  }

  setLastPoll(at: number): void {
    this.lastPollAt = at;
  }

  setError(message: string | null): void {
    this.lastError = message;
  }

  setAction(label: string | null): void {
    this.pendingAction = label;
  }

  moveSelection(delta: number): boolean {
    if (this.tickets.length === 0) return false;
    const index = this.tickets.findIndex((t) => t.id === this.selectedId);
    const next = Math.min(
      this.tickets.length - 1,
      Math.max(0, (index < 0 ? 0 : index) + delta)
    );
    return this.selectAt(next);
  }

  selectFirst(): boolean {
    return this.selectAt(0);
  }

  selectLast(): boolean {
    return this.selectAt(this.tickets.length - 1);
  }

  private selectAt(index: number): boolean {
    const next = this.tickets[index];
    if (next === undefined || next.id === this.selectedId) return false;
    this.selectedId = next.id;
    return true;
  }

  private countsSummary(): string {
    if (this.counts === null) {
      return this.countsError === null
        ? "counts: n/a"
        : `counts: ${this.countsError}`;
    }
    return (
      `${this.counts.todo} todo` +
      (this.counts.mine > 0 ? ` · ${this.counts.mine} mine` : "") +
      ` · ${this.counts.unassigned} unassigned`
    );
  }

  viewModel(now: number, viewportRows: number): InboxViewModel {
    const rows: TicketRow[] = this.tickets.map((ticket) => ({
      id: ticket.id,
      number: `#${ticket.number}`,
      status:
        ticket.status === "snoozed" && ticket.snoozedUntil !== null
          ? `snz→${shortTs(ticket.snoozedUntil)}`
          : ticket.status,
      tone: ticketStatusTone(ticket),
      priority: ticket.priority,
      priorityTone: priorityTone(ticket.priority),
      customer: customerLabel(ticket),
      channel: ticket.sourceChannel,
      age: formatAge(ticket.lastCustomerMessageAt ?? ticket.createdAt, now),
      title: ticket.title,
    }));

    const selectedIndex = Math.max(
      0,
      this.tickets.findIndex((t) => t.id === this.selectedId)
    );
    const visible = Math.max(1, viewportRows);
    if (selectedIndex < this.topIndex) this.topIndex = selectedIndex;
    if (selectedIndex >= this.topIndex + visible) {
      this.topIndex = selectedIndex - visible + 1;
    }
    this.topIndex = Math.min(this.topIndex, Math.max(0, rows.length - visible));

    const selected = this.selected;
    const polled =
      this.lastPollAt === null
        ? "never"
        : new Date(this.lastPollAt).toTimeString().slice(0, 8);
    const statusLine =
      (this.lastError === null ? "" : `error: ${this.lastError} | `) +
      (this.pendingAction === null ? "" : `${this.pendingAction} | `) +
      `${this.filter} · ${this.tickets.length} shown · updated ${polled} · ` +
      `${this.countsSummary()} | j/k select · d done · t todo · s/S snooze · ` +
      `f filter · r refresh · q quit`;

    let detailTitle = "no ticket selected";
    let detailText = "";
    if (selected !== null) {
      detailTitle = `#${selected.number} · ${customerLabel(selected)} · ${selected.status}`;
      detailText = ticketDetailText(selected, now);
    } else {
      detailText = `no ${this.filter} tickets — press f to change filter`;
    }

    return {
      rows: rows.slice(this.topIndex, this.topIndex + visible),
      topIndex: this.topIndex,
      selectedIndex,
      selectedId: this.selectedId,
      detailTitle,
      detailText,
      statusLine,
      filter: this.filter,
      todoCount: this.counts?.todo ?? null,
      totalCount: this.tickets.length,
    };
  }
}

export type InboxKey = {
  readonly name: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
};

export type InboxView = {
  start(): void;
  render(model: InboxViewModel): void;
  onKey(handler: (key: InboxKey) => void): void;
  tableViewportRows(): number;
  destroy(): void;
};

const TONE_COLORS = {
  live: "#4ade80",
  queued: "#22d3ee",
  warn: "#facc15",
  ok: "#60a5fa",
  fail: "#f87171",
  muted: "#6b7280",
} as const satisfies Record<StatusTone, string>;

const SELECTED_BG = "#1e3a5f";
const HEADER_FG = "#9ca3af";
// Rows outside the table viewport: status line (1) + box border (2) + header
// row (1).
const TABLE_CHROME_ROWS = 4;
const MAX_DETAIL_LINES = 4000;

async function createOpenTuiView(): Promise<InboxView> {
  type TextChunk = import("@opentui/core").TextChunk;
  let ot: typeof import("@opentui/core");
  let renderer: import("@opentui/core").CliRenderer;
  try {
    ot = await import("@opentui/core");
    renderer = await ot.createCliRenderer({ exitOnCtrlC: false });
  } catch (error) {
    throw new Error(
      `pile support needs an interactive terminal with OpenTUI support (Bun, or Node.js >= 26.1 with node:ffi): ${errorMessage(error)}`,
      { cause: error }
    );
  }

  const root = new ot.BoxRenderable(renderer, {
    flexDirection: "column",
    width: "100%",
    height: "100%",
  });
  const panes = new ot.BoxRenderable(renderer, {
    flexDirection: "row",
    flexGrow: 1,
    width: "100%",
  });
  const left = new ot.BoxRenderable(renderer, {
    width: "48%",
    border: true,
    title: "tickets",
    borderColor: "#374151",
    flexDirection: "column",
  });
  const table = new ot.TextTableRenderable(renderer, {
    wrapMode: "none",
    columnGap: 1,
    cellPaddingX: 0,
    showBorders: false,
    border: false,
    outerBorder: false,
    width: "100%",
  });
  left.add(table);
  const right = new ot.ScrollBoxRenderable(renderer, {
    flexGrow: 1,
    border: true,
    title: "ticket",
    borderColor: "#374151",
    scrollY: true,
  });
  const detailText = new ot.TextRenderable(renderer, {
    content: "",
    wrapMode: "word",
    width: "100%",
    fg: "#d1d5db",
  });
  right.add(detailText);
  panes.add(left);
  panes.add(right);
  const status = new ot.TextRenderable(renderer, {
    content: "",
    height: 1,
    wrapMode: "none",
    truncate: true,
    fg: "#9ca3af",
  });
  root.add(panes);
  root.add(status);
  renderer.root.add(root);

  const selectedBg = ot.RGBA.fromHex(SELECTED_BG);
  const cell = (text: string, fg?: string): TextChunk =>
    ot.fg(fg ?? "#d1d5db")(text);

  return {
    start() {
      renderer.start();
    },
    onKey(handler) {
      renderer.keyInput.on("keypress", (key) => {
        handler({ name: key.name, ctrl: key.ctrl, shift: key.shift });
      });
    },
    tableViewportRows() {
      return Math.max(1, renderer.height - TABLE_CHROME_ROWS);
    },
    render(model) {
      const paint = (text: string, fg?: string, selected = false) => {
        const c = cell(text, fg);
        return [selected ? { ...c, bg: selectedBg } : c];
      };
      const header: TextChunk[][][] = [
        ["", "#", "STATUS", "PRI", "CUSTOMER", "CH", "AGE", "TITLE"].map(
          (h) => [cell(h, HEADER_FG)]
        ),
      ];
      const body: TextChunk[][][] = model.rows.map((row, index) => {
        const selected = model.topIndex + index === model.selectedIndex;
        return [
          paint(selected ? ">" : "", undefined, selected),
          paint(row.number, "#93c5fd", selected),
          paint(row.status, TONE_COLORS[row.tone], selected),
          paint(row.priority, TONE_COLORS[row.priorityTone], selected),
          paint(row.customer, undefined, selected),
          paint(row.channel, "#9ca3af", selected),
          paint(row.age, "#9ca3af", selected),
          paint(row.title, undefined, selected),
        ];
      });
      table.content = [...header, ...body];

      const lines = model.detailText.split("\n");
      detailText.content =
        lines.length > MAX_DETAIL_LINES
          ? lines.slice(-MAX_DETAIL_LINES).join("\n")
          : model.detailText;
      right.title = `ticket — ${model.detailTitle}`;
      status.content = model.statusLine;
      renderer.requestRender();
    },
    destroy() {
      renderer.destroy();
    },
  };
}

export type InboxDeps = CliDeps & {
  readonly createView?: () => InboxView | Promise<InboxView>;
  readonly now?: () => number;
};

const SNOOZE_DAY_MS = 24 * 60 * 60 * 1000;

// `pile support --workspace <org>` (alias `pile support inbox`) — ticket
// triage inbox: ticket table on the left, detail + event thread of the
// selected ticket on the right, inbox counts along the bottom.
export async function supportCommand(
  flags: Readonly<Record<string, string | boolean>>,
  deps: InboxDeps = {}
): Promise<number> {
  const workspace =
    flagString(flags, "workspace") ?? flagString(flags, "workspace-id");
  if (workspace === undefined || workspace.length === 0) {
    throw new Error("Missing --workspace. Use --workspace <org>.");
  }

  const config = resolveConfig();
  if (config.apiKey === undefined || config.apiKey.length === 0) {
    throw new Error(
      "Missing API key. Set PILE_API_KEY or run `pile config set --api-key <key>`."
    );
  }

  const parsedInterval = Number(flagString(flags, "interval") ?? "10000");
  const intervalMs = Number.isFinite(parsedInterval)
    ? Math.max(250, parsedInterval)
    : 10000;
  const parsedLimit = Number(flagString(flags, "limit") ?? "50");
  const limit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.floor(parsedLimit))
    : 50;
  const q = flagString(flags, "q");
  const statusFlag = flagString(flags, "status");
  if (
    statusFlag !== undefined &&
    statusFlag !== "all" &&
    !isTicketStatus(statusFlag)
  ) {
    throw new Error(
      `Invalid --status "${statusFlag}". Use todo, done, snoozed, or all.`
    );
  }

  const api = createSupportApi({
    doFetch: deps.fetch ?? fetch,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    workspace,
  });
  const now = deps.now ?? (() => Date.now());
  const model = new InboxModel(statusFlag ?? "todo");
  const view = await (deps.createView !== undefined
    ? deps.createView()
    : createOpenTuiView());

  let stopped = false;
  let resolveQuit!: () => void;
  const quit = new Promise<void>((resolve) => {
    resolveQuit = resolve;
  });

  const render = () => {
    view.render(model.viewModel(now(), view.tableViewportRows()));
  };

  async function pollOnce(): Promise<void> {
    try {
      const tickets = await api.listTickets({
        status: model.statusFilter,
        limit,
        q,
      });
      if (stopped) return;
      model.setTickets(tickets);
      model.setError(null);
    } catch (error) {
      model.setError(errorMessage(error));
      render();
      return;
    }

    try {
      model.setCounts(await api.inboxCounts());
    } catch (error) {
      model.setCountsError(errorMessage(error));
    }
    model.setLastPoll(now());
    render();
  }

  let pollInFlight: Promise<void> | null = null;
  let pollAgain = false;
  const poll = (): Promise<void> => {
    if (pollInFlight !== null) {
      pollAgain = true;
      return pollInFlight;
    }
    pollInFlight = (async () => {
      try {
        for (;;) {
          pollAgain = false;
          await pollOnce();
          if (!pollAgain || stopped) break;
        }
      } finally {
        pollInFlight = null;
      }
    })();
    return pollInFlight;
  };

  let actionInFlight = false;
  async function runAction(
    status: TicketStatus,
    until?: string
  ): Promise<void> {
    const ticket = model.selected;
    if (ticket === null || actionInFlight) return;
    actionInFlight = true;
    model.setAction(`#${ticket.number} → ${status}…`);
    render();
    try {
      const updated = await api.setStatus(ticket.id, status, until);
      if (!stopped && updated !== null) model.replaceTicket(updated);
      if (!stopped) model.setError(null);
    } catch (error) {
      if (!stopped) model.setError(errorMessage(error));
    } finally {
      model.setAction(null);
      actionInFlight = false;
    }
    await poll();
  }

  view.onKey((key) => {
    if (stopped) return;
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      stopped = true;
      resolveQuit();
      return;
    }
    if (key.name === "j" || key.name === "down") {
      if (model.moveSelection(1)) render();
      return;
    }
    if (key.name === "k" || key.name === "up") {
      if (model.moveSelection(-1)) render();
      return;
    }
    if (key.name === "g") {
      if (key.shift ? model.selectLast() : model.selectFirst()) render();
      return;
    }
    if (key.name === "r") {
      void poll();
      return;
    }
    if (key.name === "f") {
      model.cycleFilter();
      void poll();
      return;
    }
    if (key.name === "d") {
      void runAction("done");
      return;
    }
    if (key.name === "t") {
      void runAction("todo");
      return;
    }
    if (key.name === "s") {
      // s: snooze until tomorrow. S: park it for a week.
      const until = new Date(
        now() + (key.shift ? 7 : 1) * SNOOZE_DAY_MS
      ).toISOString();
      void runAction("snoozed", until);
      return;
    }
  });

  view.start();
  const timer = setInterval(() => {
    void poll();
  }, intervalMs);
  void poll();
  await quit;
  stopped = true;
  clearInterval(timer);
  view.destroy();
  return 0;
}
