import {
  flagString,
  isJsonObject,
  parseJson,
  resolveConfig,
  type CliDeps,
} from "./cli.js";

export type FleetSession = {
  readonly id: string;
  readonly issueId: string;
  readonly agentId: string;
  readonly provider: string;
  readonly status: string;
  readonly result?: string | null;
  readonly prUrl?: string | null;
  readonly prState?: string | null;
  readonly branch?: string | null;
  readonly purpose?: string | null;
  readonly createdAt: string;
  readonly startedAt?: string | null;
  readonly updatedAt: string;
  readonly endedAt?: string | null;
  readonly derivedStatus?: string | null;
};

export type FleetHealth = {
  readonly live: number;
  readonly missingEndedAt: number;
  readonly providers: readonly {
    readonly agentId: string;
    readonly live: number;
    readonly keptSandboxes: number;
    readonly infraStreak: number;
    readonly unhealthy: boolean;
  }[];
};

export type SessionTail = {
  readonly logs: string | null;
  readonly status: string | null;
  readonly result: string | null;
  readonly error: string | null;
};

const TERMINAL_SESSION_STATUSES = new Set(["completed", "failed", "canceled"]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_SESSION_STATUSES.has(status);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseFleetSession(value: unknown): FleetSession | null {
  if (!isJsonObject(value)) return null;
  const { id, issueId, agentId, provider, status, createdAt, updatedAt } =
    value;
  if (
    typeof id !== "string" ||
    typeof issueId !== "string" ||
    typeof agentId !== "string" ||
    typeof provider !== "string" ||
    typeof status !== "string" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }
  return {
    id,
    issueId,
    agentId,
    provider,
    status,
    result: optionalString(value.result),
    prUrl: optionalString(value.prUrl),
    prState: optionalString(value.prState),
    branch: optionalString(value.branch),
    purpose: optionalString(value.purpose),
    createdAt,
    startedAt: optionalString(value.startedAt),
    updatedAt,
    endedAt: optionalString(value.endedAt),
    derivedStatus: optionalString(value.derivedStatus),
  };
}

function parseFleetHealth(value: unknown): FleetHealth | null {
  if (!isJsonObject(value) || typeof value.live !== "number") return null;
  if (!Array.isArray(value.providers)) return null;
  const providers = value.providers
    .map((p) => {
      if (!isJsonObject(p)) return null;
      if (
        typeof p.agentId !== "string" ||
        typeof p.live !== "number" ||
        typeof p.keptSandboxes !== "number" ||
        typeof p.infraStreak !== "number" ||
        typeof p.unhealthy !== "boolean"
      ) {
        return null;
      }
      return {
        agentId: p.agentId,
        live: p.live,
        keptSandboxes: p.keptSandboxes,
        infraStreak: p.infraStreak,
        unhealthy: p.unhealthy,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
  return {
    live: value.live,
    missingEndedAt:
      typeof value.missingEndedAt === "number" ? value.missingEndedAt : 0,
    providers,
  };
}

export type FleetApi = {
  listSessions(limit: number): Promise<FleetSession[]>;
  getSessionTail(sessionId: string): Promise<SessionTail>;
  fleetHealth(): Promise<FleetHealth>;
  getIssueIdentifier(issueId: string): Promise<string | null>;
};

export function createFleetApi(options: {
  readonly doFetch: typeof fetch;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly workspace: string;
}): FleetApi {
  const { doFetch, apiKey, workspace } = options;
  const baseUrl = options.baseUrl.replace(/\/$/u, "");
  const headers = new Headers({ Authorization: `Bearer ${apiKey}` });
  const sessionsBase = `${baseUrl}/workspaces/${workspace}/agent/sessions`;

  return {
    async listSessions(limit) {
      const res = await doFetch(`${sessionsBase}?limit=${limit}`, { headers });
      if (!res.ok) {
        throw new Error(`GET /agent/sessions returned ${res.status}`);
      }
      const parsed = parseJson(await res.text());
      if (!isJsonObject(parsed) || !Array.isArray(parsed.sessions)) {
        throw new Error("Unexpected /agent/sessions response");
      }
      return parsed.sessions
        .map(parseFleetSession)
        .filter((s): s is FleetSession => s !== null);
    },

    async getSessionTail(sessionId) {
      const res = await doFetch(`${sessionsBase}/${sessionId}/state`, {
        headers,
      });
      if (!res.ok) {
        // /state 400s once the compute is destroyed; terminal sessions keep
        // their record but have no live provider state to tail.
        return {
          logs: null,
          status: null,
          result: null,
          error: `state ${res.status}`,
        };
      }
      const parsed = parseJson(await res.text());
      if (!isJsonObject(parsed)) {
        return { logs: null, status: null, result: null, error: "bad state" };
      }
      const session = isJsonObject(parsed.session)
        ? parseFleetSession(parsed.session)
        : null;
      const provider = parsed.provider;
      const logs =
        isJsonObject(provider) && typeof provider.logs === "string"
          ? provider.logs
          : null;
      return {
        logs,
        status: session?.status ?? null,
        result: session?.result ?? null,
        error: null,
      };
    },

    async fleetHealth() {
      const res = await doFetch(
        `${baseUrl}/workspaces/${workspace}/agent/fleet-health`,
        { headers }
      );
      if (!res.ok) {
        throw new Error(`GET /agent/fleet-health returned ${res.status}`);
      }
      const health = parseFleetHealth(parseJson(await res.text()));
      if (health === null) {
        throw new Error("Unexpected /agent/fleet-health response");
      }
      return health;
    },

    async getIssueIdentifier(issueId) {
      const res = await doFetch(
        `${baseUrl}/workspaces/${workspace}/issues/${issueId}`,
        { headers }
      );
      if (!res.ok) return null;
      const parsed = parseJson(await res.text());
      return isJsonObject(parsed) && typeof parsed.identifier === "string"
        ? parsed.identifier
        : null;
    },
  };
}

export function sortFleetSessions(
  sessions: readonly FleetSession[]
): FleetSession[] {
  const live: FleetSession[] = [];
  const terminal: FleetSession[] = [];
  for (const session of sessions) {
    (isTerminalStatus(session.status) ? terminal : live).push(session);
  }
  // Live lanes keep dispatch order (createdAt asc) so rows don't reshuffle on
  // every progress update; finished lanes surface most recently ended first.
  live.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  terminal.sort((a, b) =>
    (b.endedAt ?? b.updatedAt).localeCompare(a.endedAt ?? a.updatedAt)
  );
  return [...live, ...terminal];
}

export function formatAge(createdAt: string, now: number): string {
  const started = Date.parse(createdAt);
  if (!Number.isFinite(started)) return "?";
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours}h${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest > 0 ? `${days}d${rest}h` : `${days}d`;
}

export function shortPrRef(prUrl: string | null | undefined): string | null {
  if (!prUrl) return null;
  const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/u.exec(prUrl);
  if (match) return `${match[1]}#${match[2]}`;
  return prUrl;
}

export type StatusTone = "live" | "queued" | "warn" | "ok" | "fail" | "muted";

export function sessionTone(session: FleetSession): StatusTone {
  if (!isTerminalStatus(session.status)) {
    if (
      session.derivedStatus === "stalled" ||
      session.derivedStatus === "needs_input"
    ) {
      return "warn";
    }
    return session.status === "running" ? "live" : "queued";
  }
  if (session.status === "completed") return "ok";
  if (session.status === "failed") return "fail";
  return "muted";
}

export function statusLabel(session: FleetSession): string {
  if (
    !isTerminalStatus(session.status) &&
    (session.derivedStatus === "stalled" ||
      session.derivedStatus === "needs_input")
  ) {
    return `${session.status}·${session.derivedStatus.replace("_", "-")}`;
  }
  return session.status;
}

export type FleetRow = {
  readonly id: string;
  readonly status: string;
  readonly tone: StatusTone;
  readonly issue: string;
  readonly agent: string;
  readonly age: string;
  readonly prLabel: string;
  readonly prUrl: string | null;
};

export type FleetViewModel = {
  readonly rows: readonly FleetRow[];
  readonly topIndex: number;
  readonly selectedIndex: number;
  readonly selectedId: string | null;
  readonly logTitle: string;
  readonly logText: string;
  readonly statusLine: string;
  readonly liveCount: number;
  readonly totalCount: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FleetModel {
  private sessions: FleetSession[] = [];
  private selectedId: string | null = null;
  private topIndex = 0;
  private readonly issueLabels = new Map<string, string | null>();
  private tail: SessionTail | null = null;
  private tailForId: string | null = null;
  private health: FleetHealth | null = null;
  private healthError: string | null = null;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;

  get sessionList(): readonly FleetSession[] {
    return this.sessions;
  }

  get selected(): FleetSession | null {
    return this.sessions.find((s) => s.id === this.selectedId) ?? null;
  }

  setSessions(sessions: readonly FleetSession[]): void {
    this.sessions = sortFleetSessions(sessions);
    if (
      this.selectedId !== null &&
      !this.sessions.some((s) => s.id === this.selectedId)
    ) {
      this.selectedId = null;
    }
    if (this.selectedId === null && this.sessions.length > 0) {
      this.selectedId = this.sessions[0]?.id ?? null;
    }
    const index = this.sessions.findIndex((s) => s.id === this.selectedId);
    this.topIndex = Math.min(this.topIndex, Math.max(0, index));
  }

  setIssueLabel(issueId: string, identifier: string | null): void {
    this.issueLabels.set(issueId, identifier);
  }

  issueIdsNeedingLabels(): string[] {
    const missing = new Set<string>();
    for (const session of this.sessions) {
      if (!this.issueLabels.has(session.issueId)) missing.add(session.issueId);
    }
    return [...missing];
  }

  issueLabel(issueId: string): string {
    return this.issueLabels.get(issueId) ?? `${issueId.slice(0, 8)}…`;
  }

  setTail(sessionId: string, tail: SessionTail): void {
    if (sessionId !== this.selectedId) return;
    this.tail = tail;
    this.tailForId = sessionId;
  }

  setHealth(health: FleetHealth): void {
    this.health = health;
    this.healthError = null;
  }

  setHealthError(message: string): void {
    this.healthError = message;
  }

  setLastPoll(at: number): void {
    this.lastPollAt = at;
  }

  setError(message: string | null): void {
    this.lastError = message;
  }

  moveSelection(delta: number): boolean {
    if (this.sessions.length === 0) return false;
    const index = this.sessions.findIndex((s) => s.id === this.selectedId);
    const next = Math.min(
      this.sessions.length - 1,
      Math.max(0, (index < 0 ? 0 : index) + delta)
    );
    return this.selectAt(next);
  }

  selectFirst(): boolean {
    return this.selectAt(0);
  }

  selectLast(): boolean {
    return this.selectAt(this.sessions.length - 1);
  }

  private selectAt(index: number): boolean {
    const next = this.sessions[index];
    if (next === undefined || next.id === this.selectedId) return false;
    this.selectedId = next.id;
    this.tail = null;
    this.tailForId = null;
    return true;
  }

  private healthSummary(): string {
    if (this.health === null) {
      return this.healthError === null
        ? "fleet: n/a"
        : `fleet: ${this.healthError}`;
    }
    const parts = this.health.providers.map(
      (p) =>
        `${p.agentId} ${p.live} live/${p.keptSandboxes} kept` +
        (p.infraStreak > 0 ? ` streak ${p.infraStreak}` : "")
    );
    const unhealthy = this.health.providers.some((p) => p.unhealthy);
    return `fleet: ${unhealthy ? "UNHEALTHY" : "ok"} (${parts.join(", ")})`;
  }

  viewModel(now: number, viewportRows: number): FleetViewModel {
    const rows: FleetRow[] = this.sessions.map((session) => ({
      id: session.id,
      status: statusLabel(session),
      tone: sessionTone(session),
      issue: this.issueLabel(session.issueId),
      agent: session.agentId,
      age: formatAge(session.startedAt ?? session.createdAt, now),
      prLabel: shortPrRef(session.prUrl) ?? "",
      prUrl: session.prUrl ?? null,
    }));

    const selectedIndex = Math.max(
      0,
      this.sessions.findIndex((s) => s.id === this.selectedId)
    );
    const visible = Math.max(1, viewportRows);
    if (selectedIndex < this.topIndex) this.topIndex = selectedIndex;
    if (selectedIndex >= this.topIndex + visible) {
      this.topIndex = selectedIndex - visible + 1;
    }
    this.topIndex = Math.min(this.topIndex, Math.max(0, rows.length - visible));

    const selected = this.selected;
    const liveCount = this.sessions.filter(
      (s) => !isTerminalStatus(s.status)
    ).length;
    const polled =
      this.lastPollAt === null
        ? "never"
        : new Date(this.lastPollAt).toTimeString().slice(0, 8);
    const statusLine =
      (this.lastError === null ? "" : `error: ${this.lastError} | `) +
      `${liveCount} live · ${this.sessions.length} shown · updated ${polled} · ` +
      `${this.healthSummary()} | j/k select · r refresh · q quit`;

    let logTitle = "no session selected";
    let logText = "";
    if (selected !== null) {
      logTitle = `${selected.id.slice(0, 8)} · ${this.issueLabel(selected.issueId)} · ${statusLabel(selected)}`;
      if (this.tailForId === selected.id && this.tail !== null) {
        if (this.tail.logs !== null) {
          logText = this.tail.logs;
        } else if (isTerminalStatus(selected.status)) {
          logText = `[${statusLabel(selected)}] ${this.tail.result ?? this.tail.error ?? "no live state"}`;
        } else {
          logText = `[${statusLabel(selected)}] waiting for live state (${this.tail.error ?? "unavailable"})`;
        }
      } else {
        logText = "loading…";
      }
    }

    return {
      rows: rows.slice(this.topIndex, this.topIndex + visible),
      topIndex: this.topIndex,
      selectedIndex,
      selectedId: this.selectedId,
      logTitle,
      logText,
      statusLine,
      liveCount,
      totalCount: this.sessions.length,
    };
  }
}

export type FleetKey = {
  readonly name: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
};

export type FleetView = {
  start(): void;
  render(model: FleetViewModel): void;
  onKey(handler: (key: FleetKey) => void): void;
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
const MAX_LOG_LINES = 4000;

async function createOpenTuiView(): Promise<FleetView> {
  type TextChunk = import("@opentui/core").TextChunk;
  let ot: typeof import("@opentui/core");
  let renderer: import("@opentui/core").CliRenderer;
  try {
    ot = await import("@opentui/core");
    renderer = await ot.createCliRenderer({ exitOnCtrlC: false });
  } catch (error) {
    throw new Error(
      `pile fleet needs an interactive terminal with OpenTUI support (Bun, or Node.js >= 26.1 with node:ffi): ${errorMessage(error)}`,
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
    title: "sessions",
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
    title: "log",
    borderColor: "#374151",
    stickyScroll: true,
    stickyStart: "bottom",
    scrollY: true,
  });
  const logText = new ot.TextRenderable(renderer, {
    content: "",
    wrapMode: "char",
    width: "100%",
    fg: "#d1d5db",
  });
  right.add(logText);
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
        ["", "STATUS", "ISSUE", "AGENT", "AGE", "PR"].map((h) => [
          cell(h, HEADER_FG),
        ]),
      ];
      const body: TextChunk[][][] = model.rows.map((row, index) => {
        const selected = model.topIndex + index === model.selectedIndex;
        return [
          paint(selected ? ">" : "", undefined, selected),
          paint(row.status, TONE_COLORS[row.tone], selected),
          paint(row.issue, "#93c5fd", selected),
          paint(row.agent, undefined, selected),
          paint(row.age, "#9ca3af", selected),
          row.prLabel === ""
            ? paint("", undefined, selected)
            : [
                {
                  ...ot.link(row.prUrl ?? "")(row.prLabel),
                  ...(selected ? { bg: selectedBg } : {}),
                },
              ],
        ];
      });
      table.content = [...header, ...body];

      const lines = model.logText.split("\n");
      logText.content =
        lines.length > MAX_LOG_LINES
          ? lines.slice(-MAX_LOG_LINES).join("\n")
          : model.logText;
      right.title = `log — ${model.logTitle}`;
      right.scrollTop = right.scrollHeight;
      status.content = model.statusLine;
      renderer.requestRender();
    },
    destroy() {
      renderer.destroy();
    },
  };
}

export type FleetDeps = CliDeps & {
  readonly createView?: () => FleetView | Promise<FleetView>;
  readonly now?: () => number;
};

// `pile fleet --workspace <org>` — live dashboard of every agent session in a
// workspace: session table on the left, log tail of the selected lane on the
// right, fleet health along the bottom.
export async function fleetCommand(
  flags: Readonly<Record<string, string | boolean>>,
  deps: FleetDeps = {}
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

  const parsedInterval = Number(flagString(flags, "interval") ?? "4000");
  const intervalMs = Number.isFinite(parsedInterval)
    ? Math.max(250, parsedInterval)
    : 4000;
  const parsedLimit = Number(flagString(flags, "limit") ?? "50");
  const limit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.floor(parsedLimit))
    : 50;

  const api = createFleetApi({
    doFetch: deps.fetch ?? fetch,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    workspace,
  });
  const now = deps.now ?? (() => Date.now());
  const model = new FleetModel();
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
      const sessions = await api.listSessions(limit);
      if (stopped) return;
      model.setSessions(sessions);
      model.setError(null);
    } catch (error) {
      model.setError(errorMessage(error));
      render();
      return;
    }

    const missing = model.issueIdsNeedingLabels();
    await Promise.all(
      missing.map((issueId) =>
        api
          .getIssueIdentifier(issueId)
          .then((identifier) => model.setIssueLabel(issueId, identifier))
          .catch(() => model.setIssueLabel(issueId, null))
      )
    );
    if (stopped) return;

    const selected = model.selected;
    if (selected !== null) {
      const tail = await api
        .getSessionTail(selected.id)
        .catch((error: unknown): SessionTail => ({
          logs: null,
          status: null,
          result: null,
          error: errorMessage(error),
        }));
      if (!stopped) model.setTail(selected.id, tail);
    }

    try {
      model.setHealth(await api.fleetHealth());
    } catch (error) {
      model.setHealthError(errorMessage(error));
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

  view.onKey((key) => {
    if (stopped) return;
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      stopped = true;
      resolveQuit();
      return;
    }
    if (key.name === "j" || key.name === "down") {
      if (model.moveSelection(1)) void poll();
    } else if (key.name === "k" || key.name === "up") {
      if (model.moveSelection(-1)) void poll();
    } else if (key.name === "g") {
      if (key.shift ? model.selectLast() : model.selectFirst()) void poll();
    } else if (key.name === "r") {
      void poll();
    }
    render();
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
