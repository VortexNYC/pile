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

export type FleetAgent = {
  readonly agentId: string;
  readonly ready: boolean;
  readonly missing: readonly string[];
};

export type DispatchBatchItem = {
  readonly issueId: string;
  readonly agentId?: string;
  readonly branch?: string;
};

export type DispatchBatchResult = {
  readonly batchId: string;
  readonly results: readonly {
    readonly issueId: string;
    readonly sessionId: string | null;
    readonly status: string | null;
    readonly error: string | null;
  }[];
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

function parseFleetAgent(value: unknown): FleetAgent | null {
  if (!isJsonObject(value) || typeof value.agentId !== "string") return null;
  const missing = Array.isArray(value.missing)
    ? value.missing.filter((m): m is string => typeof m === "string")
    : [];
  return {
    agentId: value.agentId,
    ready: value.ready === true,
    missing,
  };
}

function parseDispatchBatchResult(value: unknown): DispatchBatchResult | null {
  if (!isJsonObject(value) || typeof value.batchId !== "string") return null;
  if (!Array.isArray(value.results)) return null;
  const results = value.results
    .map((r) => {
      if (!isJsonObject(r) || typeof r.issueId !== "string") return null;
      return {
        issueId: r.issueId,
        sessionId: optionalString(r.sessionId),
        status: optionalString(r.status),
        error: optionalString(r.error),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  return { batchId: value.batchId, results };
}

export type FleetApi = {
  listSessions(limit: number): Promise<FleetSession[]>;
  getSessionTail(sessionId: string): Promise<SessionTail>;
  fleetHealth(): Promise<FleetHealth>;
  getIssueIdentifier(issueId: string): Promise<string | null>;
  // Lane actions — all of these are API calls; the TUI never shells out to
  // git/GitHub directly (PILE-263).
  listAgents(): Promise<FleetAgent[]>;
  dispatchBatch(
    items: readonly DispatchBatchItem[]
  ): Promise<DispatchBatchResult>;
  cancelSession(sessionId: string): Promise<void>;
  promptSession(sessionId: string, prompt: string): Promise<void>;
  retrySession(sessionId: string): Promise<FleetSession | null>;
};

export function createFleetApi(options: {
  readonly doFetch: typeof fetch;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly workspace: string;
}): FleetApi {
  const { doFetch, apiKey, workspace } = options;
  const baseUrl = options.baseUrl.replace(/\/$/u, "");
  const base = `${baseUrl}/workspaces/${workspace}`;
  const headers = new Headers({ Authorization: `Bearer ${apiKey}` });
  const sessionsBase = `${base}/agent/sessions`;
  const jsonHeaders = () =>
    new Headers({
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    });

  return {
    async listSessions(limit) {
      // summary=1 keeps the poll light: lane-row scalars only, no
      // result/transcript blobs (PILE-256).
      const res = await doFetch(`${sessionsBase}?limit=${limit}&summary=1`, {
        headers,
      });
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

    async listAgents() {
      // setup-status reports every catalog agent with a ready flag — the
      // picker dims the ones missing credentials. Falls back to the
      // configured-providers list when the token can't read setup-status.
      const statusRes = await doFetch(`${base}/agent/setup-status`, {
        headers,
      });
      if (statusRes.ok) {
        const parsed = parseJson(await statusRes.text());
        if (!isJsonObject(parsed) || !Array.isArray(parsed.providers)) {
          throw new Error("Unexpected /agent/setup-status response");
        }
        const agents = parsed.providers
          .map(parseFleetAgent)
          .filter((a): a is FleetAgent => a !== null);
        agents.sort(
          (a, b) =>
            Number(b.ready) - Number(a.ready) ||
            a.agentId.localeCompare(b.agentId)
        );
        return agents;
      }
      const res = await doFetch(`${base}/agent/providers`, { headers });
      if (!res.ok) {
        throw new Error(`GET /agent/providers returned ${res.status}`);
      }
      const parsed = parseJson(await res.text());
      if (!Array.isArray(parsed)) {
        throw new Error("Unexpected /agent/providers response");
      }
      return parsed
        .map((p): FleetAgent | null =>
          isJsonObject(p) && typeof p.agentId === "string"
            ? { agentId: p.agentId, ready: true, missing: [] }
            : null
        )
        .filter((a): a is FleetAgent => a !== null);
    },

    async dispatchBatch(items) {
      const res = await doFetch(`${base}/agent/dispatch-batch`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ items }),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`dispatch failed: ${errorBody(text, res.status)}`);
      }
      const parsed = parseDispatchBatchResult(parseJson(text));
      if (parsed === null) {
        throw new Error("Unexpected /agent/dispatch-batch response");
      }
      return parsed;
    },

    async cancelSession(sessionId) {
      const res = await doFetch(`${sessionsBase}/${sessionId}/cancel`, {
        method: "POST",
        headers: jsonHeaders(),
      });
      if (!res.ok) {
        throw new Error(
          `cancel failed: ${errorBody(await res.text(), res.status)}`
        );
      }
    },

    async promptSession(sessionId, prompt) {
      const res = await doFetch(`${sessionsBase}/${sessionId}/prompt`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) {
        throw new Error(
          `nudge failed: ${errorBody(await res.text(), res.status)}`
        );
      }
    },

    async retrySession(sessionId) {
      const res = await doFetch(`${sessionsBase}/${sessionId}/retry`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({}),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`retry failed: ${errorBody(text, res.status)}`);
      }
      const parsed = parseJson(text);
      return isJsonObject(parsed) ? parseFleetSession(parsed) : null;
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
  readonly marked: boolean;
};

export type FleetPickerOption = {
  readonly label: string;
  readonly description: string;
  readonly value: string | null;
  // custom options open a free-text input for the value instead of dispatching
  // straight away (e.g. an agent id outside the configured list).
  readonly custom?: boolean;
};

export type FleetMode = "list" | "picker" | "input";

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
  readonly mode: FleetMode;
  readonly pickerLines: readonly string[];
  readonly pickerIndex: number;
  readonly markCount: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Vortex errors answer `{code, message}` — surface the message when present.
function errorBody(text: string, status: number): string {
  try {
    const parsed = parseJson(text);
    if (isJsonObject(parsed) && typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    // non-JSON body — fall through to the status
  }
  return `HTTP ${status}`;
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
  private notice: string | null = null;
  private mode: FleetMode = "list";
  private pickerOptions: FleetPickerOption[] = [];
  private pickerIndex = 0;
  private readonly markedIssueIds = new Set<string>();

  get sessionList(): readonly FleetSession[] {
    return this.sessions;
  }

  get selected(): FleetSession | null {
    return this.sessions.find((s) => s.id === this.selectedId) ?? null;
  }

  get currentMode(): FleetMode {
    return this.mode;
  }

  get pickerSelection(): FleetPickerOption | null {
    return this.pickerOptions[this.pickerIndex] ?? null;
  }

  get markCount(): number {
    return this.markedIssueIds.size;
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
    // Marks follow issueIds; drop ones whose lane scrolled out of the window
    // so an invisible mark never sneaks into a dispatch batch.
    const visible = new Set(this.sessions.map((s) => s.issueId));
    for (const issueId of this.markedIssueIds) {
      if (!visible.has(issueId)) this.markedIssueIds.delete(issueId);
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

  toggleMark(): boolean {
    const selected = this.selected;
    if (selected === null) return false;
    if (this.markedIssueIds.has(selected.issueId)) {
      this.markedIssueIds.delete(selected.issueId);
    } else {
      this.markedIssueIds.add(selected.issueId);
    }
    return true;
  }

  isMarked(issueId: string): boolean {
    return this.markedIssueIds.has(issueId);
  }

  clearMarks(): void {
    this.markedIssueIds.clear();
  }

  unmarkIssues(issueIds: readonly string[]): void {
    for (const issueId of issueIds) this.markedIssueIds.delete(issueId);
  }

  // Issues `d` will dispatch: every marked issue in row order, or just the
  // selected row's issue when nothing is marked.
  dispatchTargets(): string[] {
    const marked: string[] = [];
    for (const session of this.sessions) {
      if (
        this.markedIssueIds.has(session.issueId) &&
        !marked.includes(session.issueId)
      ) {
        marked.push(session.issueId);
      }
    }
    if (marked.length > 0) return marked;
    return this.selected === null ? [] : [this.selected.issueId];
  }

  openPicker(options: readonly FleetPickerOption[]): void {
    this.pickerOptions = [...options];
    this.pickerIndex = 0;
    this.mode = "picker";
  }

  movePicker(delta: number): boolean {
    if (this.pickerOptions.length === 0) return false;
    const next = Math.min(
      this.pickerOptions.length - 1,
      Math.max(0, this.pickerIndex + delta)
    );
    if (next === this.pickerIndex) return false;
    this.pickerIndex = next;
    return true;
  }

  closePicker(): void {
    this.pickerOptions = [];
    this.pickerIndex = 0;
    this.mode = "list";
  }

  setMode(mode: FleetMode): void {
    this.mode = mode;
  }

  setNotice(message: string | null): void {
    this.notice = message;
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
      marked: this.markedIssueIds.has(session.issueId),
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
    const hint =
      this.mode === "picker"
        ? "j/k choose · enter select · esc cancel"
        : this.mode === "input"
          ? "enter submit · esc cancel"
          : `j/k select · space mark${this.markedIssueIds.size > 0 ? ` (${this.markedIssueIds.size})` : ""} · d dispatch · x cancel · n nudge · R retry · r refresh · q quit`;
    const statusLine =
      (this.lastError === null ? "" : `error: ${this.lastError} | `) +
      (this.notice === null ? "" : `${this.notice} | `) +
      `${liveCount} live · ${this.sessions.length} shown · updated ${polled} · ` +
      `${this.healthSummary()} | ${hint}`;

    const pickerLines = this.pickerOptions.map(
      (option, index) =>
        `${index === this.pickerIndex ? ">" : " "} ${option.label}` +
        (option.description.length > 0 ? `  — ${option.description}` : "")
    );

    let logTitle = "no session selected";
    let logText = "";
    if (this.mode === "picker") {
      logTitle = "dispatch — pick an agent";
      logText = [...pickerLines, "", hint].join("\n");
    } else if (selected !== null) {
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
      mode: this.mode,
      pickerLines,
      pickerIndex: this.pickerIndex,
      markCount: this.markedIssueIds.size,
    };
  }
}

export type FleetKey = {
  readonly name: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
};

export type FleetPromptOptions = {
  readonly title: string;
  readonly placeholder?: string;
  readonly initial?: string;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
};

export type FleetView = {
  start(): void;
  render(model: FleetViewModel): void;
  onKey(handler: (key: FleetKey) => void): void;
  tableViewportRows(): number;
  // Modal single-line input (nudge prompt, branch override, custom agent id).
  // Owns the keyboard until submit/cancel.
  promptText(options: FleetPromptOptions): void;
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
const FOCUSED_BORDER = "#60a5fa";
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

  let modal: import("@opentui/core").BoxRenderable | null = null;
  let modalKeyHandler: ((key: FleetKey) => void) | null = null;
  const closeModal = () => {
    if (modalKeyHandler !== null) {
      renderer.keyInput.off("keypress", modalKeyHandler);
      modalKeyHandler = null;
    }
    if (modal !== null) {
      renderer.root.remove(modal);
      modal = null;
    }
  };

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
    promptText(options) {
      closeModal();
      const box = new ot.BoxRenderable(renderer, {
        position: "absolute",
        top: "30%",
        left: "15%",
        width: "70%",
        border: true,
        title: options.title,
        borderColor: FOCUSED_BORDER,
        backgroundColor: "#111827",
        flexDirection: "column",
        padding: 1,
      });
      const input = new ot.InputRenderable(renderer, {
        placeholder: options.placeholder ?? "",
        width: "100%",
      });
      if (options.initial !== undefined) {
        input.value = options.initial;
      }
      box.add(input);
      renderer.root.add(box);
      modal = box;
      input.on("enter", () => {
        const value = input.value;
        closeModal();
        options.onSubmit(value);
      });
      modalKeyHandler = (key) => {
        if (key.name === "escape") {
          closeModal();
          options.onCancel();
        }
      };
      renderer.keyInput.on("keypress", modalKeyHandler);
      input.focus();
      renderer.requestRender();
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
          paint(
            `${selected ? ">" : " "}${row.marked ? "*" : ""}`,
            row.marked ? TONE_COLORS.warn : undefined,
            selected
          ),
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
      closeModal();
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

  async function runAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      model.setNotice(`failed: ${errorMessage(error)}`);
      render();
    }
  }

  let inputOpen = false;
  function openInput(options: FleetPromptOptions): void {
    inputOpen = true;
    model.setMode("input");
    render();
    try {
      view.promptText(options);
    } catch (error) {
      inputOpen = false;
      model.setMode("list");
      model.setNotice(`prompt failed: ${errorMessage(error)}`);
      render();
    }
  }

  function submitDispatch(
    issueIds: readonly string[],
    agentId: string | undefined,
    branch: string | undefined
  ): void {
    void runAction(async () => {
      const items: DispatchBatchItem[] = issueIds.map((issueId) => ({
        issueId,
        ...(agentId === undefined ? {} : { agentId }),
        ...(branch === undefined ? {} : { branch }),
      }));
      // One batch per dispatch action — marked issues fan out together.
      const batch = await api.dispatchBatch(items);
      if (stopped) return;
      const ok = batch.results.filter((r) => r.error === null);
      const failed = batch.results.filter((r) => r.error !== null);
      model.unmarkIssues(ok.map((r) => r.issueId));
      const summary = `batch ${batch.batchId.slice(0, 8)}: ${ok.length}/${batch.results.length} dispatched`;
      model.setNotice(
        failed.length === 0
          ? summary
          : `${summary} — ${failed[0]?.error ?? "unknown error"}`
      );
      void poll();
      render();
    });
  }

  function promptBranch(
    issueIds: readonly string[],
    agentId: string | undefined
  ): void {
    openInput({
      title: `dispatch ${issueIds.length === 1 ? "1 issue" : `${issueIds.length} issues`} → ${agentId ?? "default agent"}`,
      placeholder: "branch override — empty keeps the issue's branch",
      onSubmit(value) {
        inputOpen = false;
        model.setMode("list");
        const branch = value.trim();
        submitDispatch(
          issueIds,
          agentId,
          branch.length > 0 ? branch : undefined
        );
      },
      onCancel() {
        inputOpen = false;
        model.setMode("list");
        render();
      },
    });
  }

  function commitAgentPick(): void {
    const option = model.pickerSelection;
    const issueIds = model.dispatchTargets();
    model.closePicker();
    if (option === null || issueIds.length === 0) {
      render();
      return;
    }
    if (option.custom === true) {
      openInput({
        title: "agent id",
        placeholder: "e.g. devin-cli — empty uses the repo default",
        onSubmit(value) {
          inputOpen = false;
          model.setMode("list");
          const agentId = value.trim();
          promptBranch(issueIds, agentId.length > 0 ? agentId : undefined);
        },
        onCancel() {
          inputOpen = false;
          model.setMode("list");
          render();
        },
      });
      return;
    }
    promptBranch(issueIds, option.value ?? undefined);
  }

  function dispatchSelected(): void {
    if (model.dispatchTargets().length === 0) {
      model.setNotice("no lane selected to dispatch");
      render();
      return;
    }
    void runAction(async () => {
      const agents = await api.listAgents().catch((): FleetAgent[] => []);
      if (stopped || model.currentMode !== "list") return;
      const options: FleetPickerOption[] = [
        {
          label: "(default)",
          description: "repo default, else devin",
          value: null,
        },
        ...agents.map((agent): FleetPickerOption => ({
          label: agent.agentId,
          description: agent.ready
            ? "ready"
            : `missing ${agent.missing.join(", ") || "setup"}`,
          value: agent.agentId,
        })),
        {
          label: "custom…",
          description: "type an agent id",
          value: null,
          custom: true,
        },
      ];
      model.openPicker(options);
      render();
    });
  }

  function cancelSelected(): void {
    const selected = model.selected;
    if (selected === null) return;
    if (isTerminalStatus(selected.status)) {
      model.setNotice(`lane already ${selected.status}`);
      render();
      return;
    }
    void runAction(async () => {
      await api.cancelSession(selected.id);
      model.setNotice(`cancel sent → ${selected.id.slice(0, 8)}`);
      void poll();
      render();
    });
  }

  function retrySelected(): void {
    const selected = model.selected;
    if (selected === null) return;
    if (!isTerminalStatus(selected.status)) {
      model.setNotice(`lane still ${selected.status} — x cancels`);
      render();
      return;
    }
    void runAction(async () => {
      const next = await api.retrySession(selected.id);
      model.setNotice(
        next === null
          ? `retry dispatched for ${selected.id.slice(0, 8)}`
          : `retry → ${next.id.slice(0, 8)} ${next.status}`
      );
      void poll();
      render();
    });
  }

  function nudgeSelected(): void {
    const selected = model.selected;
    if (selected === null) return;
    openInput({
      title: `nudge ${selected.id.slice(0, 8)}`,
      placeholder: "follow-up prompt for the lane",
      onSubmit(value) {
        inputOpen = false;
        model.setMode("list");
        const prompt = value.trim();
        if (prompt.length === 0) {
          render();
          return;
        }
        void runAction(async () => {
          await api.promptSession(selected.id, prompt);
          model.setNotice(`nudged ${selected.id.slice(0, 8)}`);
          void poll();
          render();
        });
      },
      onCancel() {
        inputOpen = false;
        model.setMode("list");
        render();
      },
    });
  }

  view.onKey((key) => {
    if (stopped) return;
    if (key.ctrl && key.name === "c") {
      stopped = true;
      resolveQuit();
      return;
    }
    // The modal text input owns the keyboard until it submits or cancels.
    if (inputOpen) return;
    if (key.name === "q") {
      stopped = true;
      resolveQuit();
      return;
    }
    if (model.currentMode === "picker") {
      if (key.name === "escape") {
        model.closePicker();
      } else if (key.name === "j" || key.name === "down") {
        model.movePicker(1);
      } else if (key.name === "k" || key.name === "up") {
        model.movePicker(-1);
      } else if (key.name === "return" || key.name === "linefeed") {
        commitAgentPick();
        return;
      }
      render();
      return;
    }
    if (key.name === "j" || key.name === "down") {
      if (model.moveSelection(1)) void poll();
    } else if (key.name === "k" || key.name === "up") {
      if (model.moveSelection(-1)) void poll();
    } else if (key.name === "g") {
      if (key.shift ? model.selectLast() : model.selectFirst()) void poll();
    } else if (key.name === "space") {
      model.toggleMark();
    } else if (key.name === "escape") {
      model.clearMarks();
    } else if (key.name === "d") {
      dispatchSelected();
      return;
    } else if (key.name === "x") {
      cancelSelected();
      return;
    } else if (key.name === "n") {
      nudgeSelected();
      return;
    } else if (key.name === "R" || (key.name === "r" && key.shift)) {
      retrySelected();
      return;
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
