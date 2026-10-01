import { spawn } from "node:child_process";

import {
  flagString,
  isJsonObject,
  parseJson,
  resolveConfig,
  type CliDeps,
} from "./cli.js";
import { formatAge, shortPrRef, type StatusTone } from "./fleet.js";
import {
  TONE_COLORS,
  TUI,
  createTui,
  createTwoPane,
  errorMessage,
  type TextChunk,
  type TuiKey,
  type TuiPromptOptions,
} from "./tui.js";

export type InboxIssue = {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly priority: string;
  readonly teamId: string;
  readonly assigneeId: string | null;
  readonly prUrl: string | null;
  readonly prState: string | null;
  readonly prCheckState: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type InboxComment = {
  readonly id: string;
  readonly authorId: string | null;
  readonly externalAuthor: string | null;
  readonly body: string;
  readonly createdAt: string;
};

export type InboxMember = {
  readonly userId: string;
  readonly role: string;
};

export type InboxAgent = {
  readonly agentId: string;
};

export type InboxTeam = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
};

export type InboxFilter = {
  readonly status?: string;
  readonly teamId?: string;
  readonly search?: string;
};

export const INBOX_STATUSES = [
  "triage",
  "backlog",
  "todo",
  "in_progress",
  "done",
  "canceled",
] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

function isInboxStatus(value: string): value is InboxStatus {
  return (INBOX_STATUSES as readonly string[]).includes(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseInboxIssue(value: unknown): InboxIssue | null {
  if (!isJsonObject(value)) return null;
  const { id, title, status, priority, teamId, createdAt, updatedAt } = value;
  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof status !== "string" ||
    typeof priority !== "string" ||
    typeof teamId !== "string" ||
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string"
  ) {
    return null;
  }
  const identifier = optionalString(value.identifier);
  return {
    id,
    identifier: identifier ?? id.slice(0, 8),
    title,
    description: optionalString(value.description),
    status,
    priority,
    teamId,
    assigneeId: optionalString(value.assigneeId),
    prUrl: optionalString(value.prUrl),
    prState: optionalString(value.prState),
    prCheckState: optionalString(value.prCheckState),
    createdAt,
    updatedAt,
  };
}

function parseInboxComment(value: unknown): InboxComment | null {
  if (!isJsonObject(value)) return null;
  const { id, body, createdAt } = value;
  if (
    typeof id !== "string" ||
    typeof body !== "string" ||
    typeof createdAt !== "string"
  ) {
    return null;
  }
  return {
    id,
    authorId: optionalString(value.authorId),
    externalAuthor: optionalString(value.externalAuthor),
    body,
    createdAt,
  };
}

function parseInboxTeam(value: unknown): InboxTeam | null {
  if (!isJsonObject(value)) return null;
  const { id, key, name } = value;
  if (
    typeof id !== "string" ||
    typeof key !== "string" ||
    typeof name !== "string"
  ) {
    return null;
  }
  return { id, key, name };
}

function parseInboxMember(value: unknown): InboxMember | null {
  if (!isJsonObject(value)) return null;
  const { userId, role } = value;
  if (typeof userId !== "string" || typeof role !== "string") return null;
  return { userId, role };
}

export type InboxApi = {
  listIssues(filter: InboxFilter, limit: number): Promise<InboxIssue[]>;
  listComments(issueId: string): Promise<InboxComment[]>;
  setStatus(issueId: string, status: InboxStatus): Promise<InboxIssue | null>;
  assign(
    issueId: string,
    assigneeId: string | null
  ): Promise<InboxIssue | null>;
  addComment(issueId: string, body: string): Promise<InboxComment | null>;
  listTeams(): Promise<InboxTeam[]>;
  listMembers(): Promise<InboxMember[]>;
  // Requires agent:read; callers should treat failures as "no agents".
  listAgents(): Promise<InboxAgent[]>;
};

export function createInboxApi(options: {
  readonly doFetch: typeof fetch;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly workspace: string;
}): InboxApi {
  const { doFetch, apiKey, workspace } = options;
  const baseUrl = options.baseUrl.replace(/\/$/u, "");
  const base = `${baseUrl}/workspaces/${workspace}`;
  const headers = new Headers({ Authorization: `Bearer ${apiKey}` });

  const jsonHeaders = () =>
    new Headers({
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    });

  async function getJson<T>(
    path: string,
    pick: (parsed: unknown) => T | null,
    label: string
  ): Promise<T> {
    const res = await doFetch(`${base}${path}`, { headers });
    if (!res.ok) {
      throw new Error(`GET ${label} returned ${res.status}`);
    }
    const picked = pick(parseJson(await res.text()));
    if (picked === null) {
      throw new Error(`Unexpected ${label} response`);
    }
    return picked;
  }

  async function mutate(
    method: "PATCH" | "POST",
    path: string,
    body: Record<string, unknown>,
    label: string
  ): Promise<InboxIssue | null> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: jsonHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`${method} ${label} returned ${res.status}`);
    }
    const parsed = parseJson(await res.text());
    if (!isJsonObject(parsed)) return null;
    const issue = isJsonObject(parsed.issue) ? parsed.issue : parsed;
    return parseInboxIssue(issue);
  }

  return {
    async listIssues(filter, limit) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (filter.status) query.set("status", filter.status);
      if (filter.teamId) query.set("teamId", filter.teamId);
      if (filter.search) query.set("search", filter.search);
      return await getJson(
        `/issues?${query.toString()}`,
        (parsed) =>
          isJsonObject(parsed) && Array.isArray(parsed.issues)
            ? parsed.issues
                .map(parseInboxIssue)
                .filter((i): i is InboxIssue => i !== null)
            : null,
        "/issues"
      );
    },

    async listComments(issueId) {
      return await getJson(
        `/issues/${issueId}/comments`,
        (parsed) =>
          isJsonObject(parsed) && Array.isArray(parsed.comments)
            ? parsed.comments
                .map(parseInboxComment)
                .filter((c): c is InboxComment => c !== null)
            : null,
        "/issues/{id}/comments"
      );
    },

    async setStatus(issueId, status) {
      return await mutate("PATCH", `/issues/${issueId}`, { status }, "/issues");
    },

    async assign(issueId, assigneeId) {
      return await mutate(
        "POST",
        `/issues/${issueId}/assign`,
        { assigneeId },
        "/assign"
      );
    },

    async addComment(issueId, body) {
      const res = await doFetch(`${base}/issues/${issueId}/comments`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ body }),
      });
      if (!res.ok) {
        throw new Error(`POST /comments returned ${res.status}`);
      }
      return parseInboxComment(parseJson(await res.text()));
    },

    async listTeams() {
      return await getJson(
        "/teams",
        (parsed) =>
          isJsonObject(parsed) && Array.isArray(parsed.teams)
            ? parsed.teams
                .map(parseInboxTeam)
                .filter((t): t is InboxTeam => t !== null)
            : null,
        "/teams"
      );
    },

    async listMembers() {
      return await getJson(
        "/memberships",
        (parsed) =>
          isJsonObject(parsed) && Array.isArray(parsed.memberships)
            ? parsed.memberships
                .map(parseInboxMember)
                .filter((m): m is InboxMember => m !== null)
            : null,
        "/memberships"
      );
    },

    async listAgents() {
      const res = await doFetch(`${base}/agent/providers`, { headers });
      if (!res.ok) {
        throw new Error(`GET /agent/providers returned ${res.status}`);
      }
      const parsed = parseJson(await res.text());
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((p) =>
          isJsonObject(p) && typeof p.agentId === "string"
            ? { agentId: p.agentId }
            : null
        )
        .filter((a): a is InboxAgent => a !== null);
    },
  };
}

export function issueTone(issue: InboxIssue): StatusTone {
  switch (issue.status) {
    case "triage":
      return "warn";
    case "todo":
      return "queued";
    case "in_progress":
      return "live";
    case "done":
      return "ok";
    case "backlog":
    case "canceled":
    default:
      return "muted";
  }
}

export function priorityLabel(priority: string): string {
  switch (priority) {
    case "urgent":
      return "URG";
    case "high":
      return "HI";
    case "medium":
      return "MED";
    case "low":
      return "LOW";
    default:
      return priority.slice(0, 4).toUpperCase();
  }
}

export function prStateLabel(issue: InboxIssue): string {
  if (!issue.prUrl && !issue.prState) return "";
  const state = issue.prState ?? "linked";
  switch (issue.prCheckState) {
    case "success":
      return `${state}✓`;
    case "failure":
      return `${state}✗`;
    case "pending":
      return `${state}…`;
    default:
      return state;
  }
}

export function shortAssignee(assigneeId: string | null): string {
  if (assigneeId === null || assigneeId.length === 0) return "";
  // Agent ids read well already; user ids get shortened.
  if (assigneeId.includes("-") && assigneeId.length > 16) {
    return assigneeId.slice(0, 8);
  }
  return assigneeId;
}

export type InboxRow = {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly status: string;
  readonly tone: StatusTone;
  readonly priority: string;
  readonly team: string;
  readonly assignee: string;
  readonly prLabel: string;
  readonly prUrl: string | null;
};

export type InboxPickerOption = {
  readonly label: string;
  readonly description: string;
  readonly value: string | null;
};

export type InboxMode = "list" | "detail" | "assign" | "input";

export type InboxViewModel = {
  readonly rows: readonly InboxRow[];
  readonly topIndex: number;
  readonly selectedIndex: number;
  readonly selectedId: string | null;
  readonly detailTitle: string;
  readonly detailText: string;
  readonly statusLine: string;
  readonly filterLabel: string;
  readonly mode: InboxMode;
  readonly pickerLines: readonly string[];
  readonly pickerIndex: number;
  readonly totalCount: number;
};

function shortAuthor(comment: InboxComment): string {
  return (
    comment.externalAuthor ??
    (comment.authorId === null ? "unknown" : shortAssignee(comment.authorId))
  );
}

function commentStamp(createdAt: string): string {
  const parsed = Date.parse(createdAt);
  if (!Number.isFinite(parsed)) return "";
  return createdAt.slice(5, 16).replace("T", " ");
}

export class InboxModel {
  private issues: InboxIssue[] = [];
  private selectedId: string | null = null;
  private topIndex = 0;
  private mode: InboxMode = "list";
  private filterStatus: InboxStatus | null = null;
  private filterTeamId: string | undefined;
  private filterSearch: string | undefined;
  private teamLabels = new Map<string, string>();
  private comments: InboxComment[] = [];
  private commentsForId: string | null = null;
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private notice: string | null = null;
  private pickerOptions: InboxPickerOption[] = [];
  private pickerIndex = 0;

  get issueList(): readonly InboxIssue[] {
    return this.issues;
  }

  get selected(): InboxIssue | null {
    return this.issues.find((i) => i.id === this.selectedId) ?? null;
  }

  get currentMode(): InboxMode {
    return this.mode;
  }

  get filter(): InboxFilter {
    return {
      status: this.filterStatus ?? undefined,
      teamId: this.filterTeamId,
      search: this.filterSearch,
    };
  }

  setIssues(issues: readonly InboxIssue[]): void {
    // Server order is createdAt desc — stable enough for an inbox and keeps
    // rows from reshuffling when a status move lands mid-poll.
    this.issues = [...issues];
    if (
      this.selectedId !== null &&
      !this.issues.some((i) => i.id === this.selectedId)
    ) {
      this.selectedId = null;
    }
    if (this.selectedId === null && this.issues.length > 0) {
      this.selectedId = this.issues[0]?.id ?? null;
    }
    const index = this.issues.findIndex((i) => i.id === this.selectedId);
    this.topIndex = Math.min(this.topIndex, Math.max(0, index));
  }

  upsertIssue(issue: InboxIssue): void {
    const index = this.issues.findIndex((i) => i.id === issue.id);
    if (index >= 0) {
      const next = [...this.issues];
      next[index] = issue;
      this.issues = next;
    }
  }

  setTeams(teams: readonly InboxTeam[]): void {
    this.teamLabels = new Map(teams.map((t) => [t.id, t.key]));
  }

  resolveTeamId(value: string): string | undefined {
    const byKey = [...this.teamLabels.entries()].find(
      ([, key]) => key.toLowerCase() === value.toLowerCase()
    );
    if (byKey) return byKey[0];
    if (this.teamLabels.has(value)) return value;
    return undefined;
  }

  teamLabel(teamId: string): string {
    return this.teamLabels.get(teamId) ?? teamId.slice(0, 8);
  }

  setComments(issueId: string, comments: readonly InboxComment[]): void {
    if (issueId !== this.selectedId) return;
    this.comments = [...comments];
    this.commentsForId = issueId;
  }

  appendComment(issueId: string, comment: InboxComment): void {
    if (issueId !== this.selectedId || this.commentsForId !== issueId) return;
    this.comments = [...this.comments, comment];
  }

  setFilter(patch: {
    readonly status?: InboxStatus | null;
    readonly teamId?: string;
    readonly search?: string;
  }): void {
    if (patch.status !== undefined) {
      this.filterStatus = patch.status;
    }
    if (patch.teamId !== undefined) {
      this.filterTeamId = patch.teamId.length > 0 ? patch.teamId : undefined;
    }
    if (patch.search !== undefined) {
      this.filterSearch = patch.search.length > 0 ? patch.search : undefined;
    }
  }

  cycleStatusFilter(): InboxStatus | null {
    const order: readonly (InboxStatus | null)[] = [
      null,
      "triage",
      "backlog",
      "todo",
      "in_progress",
      "done",
      "canceled",
    ];
    const index = order.indexOf(this.filterStatus);
    this.filterStatus = order[(index + 1) % order.length] ?? null;
    return this.filterStatus;
  }

  setMode(mode: InboxMode): void {
    this.mode = mode;
  }

  openPicker(options: readonly InboxPickerOption[]): void {
    this.pickerOptions = [...options];
    this.pickerIndex = 0;
    this.mode = "assign";
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

  get pickerSelection(): InboxPickerOption | null {
    return this.pickerOptions[this.pickerIndex] ?? null;
  }

  closePicker(): void {
    this.pickerOptions = [];
    this.pickerIndex = 0;
    this.mode = "list";
  }

  setNotice(message: string | null): void {
    this.notice = message;
  }

  setError(message: string | null): void {
    this.lastError = message;
  }

  setLastPoll(at: number): void {
    this.lastPollAt = at;
  }

  moveSelection(delta: number): boolean {
    if (this.issues.length === 0) return false;
    const index = this.issues.findIndex((i) => i.id === this.selectedId);
    const next = Math.min(
      this.issues.length - 1,
      Math.max(0, (index < 0 ? 0 : index) + delta)
    );
    return this.selectAt(next);
  }

  selectFirst(): boolean {
    return this.selectAt(0);
  }

  selectLast(): boolean {
    return this.selectAt(this.issues.length - 1);
  }

  private selectAt(index: number): boolean {
    const next = this.issues[index];
    if (next === undefined || next.id === this.selectedId) return false;
    this.selectedId = next.id;
    this.comments = [];
    this.commentsForId = null;
    return true;
  }

  private filterLabel(): string {
    const parts: string[] = [];
    if (this.filterStatus !== null) parts.push(`status:${this.filterStatus}`);
    if (this.filterTeamId !== undefined) {
      parts.push(`team:${this.teamLabel(this.filterTeamId)}`);
    }
    if (this.filterSearch !== undefined) {
      parts.push(`search:"${this.filterSearch}"`);
    }
    return parts.length > 0 ? `[${parts.join(" ")}] ` : "";
  }

  private detailText(selected: InboxIssue, now: number): string {
    const lines: string[] = [];
    lines.push(selected.title);
    lines.push(
      `${selected.identifier} · ${selected.status} · ${selected.priority}` +
        ` · team ${this.teamLabel(selected.teamId)}` +
        (selected.assigneeId !== null
          ? ` · @${shortAssignee(selected.assigneeId)}`
          : "") +
        ` · updated ${formatAge(selected.updatedAt, now)} ago`
    );
    if (selected.prUrl !== null) {
      lines.push(
        `pr: ${shortPrRef(selected.prUrl) ?? selected.prUrl}` +
          ` · ${issuePrLine(selected)}`
      );
    }
    lines.push("");
    lines.push(selected.description ?? "(no description)");
    lines.push("");
    const commentsLoaded = this.commentsForId === selected.id;
    const comments = commentsLoaded ? this.comments : [];
    lines.push(`comments (${commentsLoaded ? String(comments.length) : "…"})`);
    for (const comment of comments) {
      const stamp = commentStamp(comment.createdAt);
      const body = comment.body.replace(/\r?\n/g, "\n  ");
      lines.push(`  ${stamp} ${shortAuthor(comment)}: ${body}`);
    }
    if (commentsLoaded && comments.length === 0) {
      lines.push("  (none)");
    }
    return lines.join("\n");
  }

  viewModel(now: number, viewportRows: number): InboxViewModel {
    const rows: InboxRow[] = this.issues.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      tone: issueTone(issue),
      priority: priorityLabel(issue.priority),
      team: this.teamLabel(issue.teamId),
      assignee: shortAssignee(issue.assigneeId),
      prLabel: prStateLabel(issue),
      prUrl: issue.prUrl,
    }));

    const selectedIndex = Math.max(
      0,
      this.issues.findIndex((i) => i.id === this.selectedId)
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
    const hint =
      this.mode === "assign"
        ? "j/k choose · enter assign · esc cancel"
        : this.mode === "detail"
          ? "j/k scroll · g/G ends · tab/esc back"
          : this.mode === "input"
            ? "enter submit · esc cancel"
            : "j/k select · tab detail · b/t/i/d/x status · a assign · c comment · o open pr · / search · f filter · r refresh · q quit";
    const statusLine =
      (this.lastError === null ? "" : `error: ${this.lastError} | `) +
      (this.notice === null ? "" : `${this.notice} | `) +
      `${this.filterLabel()}${this.issues.length} issues · updated ${polled} | ${hint}`;

    let detailTitle = "no issue selected";
    let detailText = "";
    if (this.mode === "assign") {
      detailTitle = `assign${selected !== null ? ` ${selected.identifier}` : ""}`;
    } else if (selected !== null) {
      detailTitle = `${selected.identifier} · ${selected.status}`;
      detailText = this.detailText(selected, now);
    }

    const pickerLines = this.pickerOptions.map(
      (option, index) =>
        `${index === this.pickerIndex ? ">" : " "} ${option.label}` +
        (option.description.length > 0 ? `  — ${option.description}` : "")
    );

    return {
      rows: rows.slice(this.topIndex, this.topIndex + visible),
      topIndex: this.topIndex,
      selectedIndex,
      selectedId: this.selectedId,
      detailTitle,
      detailText,
      statusLine,
      filterLabel: this.filterLabel(),
      mode: this.mode,
      pickerLines,
      pickerIndex: this.pickerIndex,
      totalCount: this.issues.length,
    };
  }
}

function issuePrLine(issue: InboxIssue): string {
  const state = issue.prState ?? "linked";
  const checks =
    issue.prCheckState !== null ? ` · checks ${issue.prCheckState}` : "";
  return `${state}${checks}`;
}

export type InboxKey = TuiKey;

export type InboxPromptOptions = TuiPromptOptions;

export type InboxView = {
  start(): void;
  render(model: InboxViewModel): void;
  onKey(handler: (key: InboxKey) => void): void;
  tableViewportRows(): number;
  scrollDetail(deltaLines: number): void;
  scrollDetailTo(position: "top" | "bottom"): void;
  promptText(options: InboxPromptOptions): void;
  destroy(): void;
};

const PRIORITY_COLORS: Record<string, string> = {
  URG: "#f87171",
  HI: "#facc15",
  MED: "#d1d5db",
  LOW: "#6b7280",
};

const TITLE_MAX = 48;

function truncateTitle(title: string): string {
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
}

async function createOpenTuiInboxView(): Promise<InboxView> {
  const { ot, renderer } = await createTui("pile inbox");
  const pane = createTwoPane({
    ot,
    renderer,
    leftTitle: "issues",
    rightTitle: "detail",
    leftWidth: "55%",
    detailWrapMode: "word",
  });

  return {
    start: () => pane.start(),
    onKey: (handler) => pane.onKey(handler),
    tableViewportRows: () => pane.tableViewportRows(),
    scrollDetail: (deltaLines) => pane.scrollDetail(deltaLines),
    scrollDetailTo: (position) => pane.scrollDetailTo(position),
    promptText: (options) => pane.promptText(options),
    render(model) {
      const header: TextChunk[][][] = [
        ["", "ID", "TITLE", "STATUS", "PRI", "TEAM", "ASSIGNEE", "PR"].map(
          (h) => [pane.cell(h, TUI.muted)]
        ),
      ];
      const body: TextChunk[][][] = model.rows.map((row, index) => {
        const selected = model.topIndex + index === model.selectedIndex;
        return [
          pane.paint(selected ? ">" : "", undefined, selected),
          pane.paint(row.identifier, TUI.link, selected),
          pane.paint(truncateTitle(row.title), undefined, selected),
          pane.paint(row.status, TONE_COLORS[row.tone], selected),
          pane.paint(row.priority, PRIORITY_COLORS[row.priority], selected),
          pane.paint(row.team, TUI.muted, selected),
          pane.paint(row.assignee, undefined, selected),
          row.prUrl === null || row.prLabel === ""
            ? pane.paint(row.prLabel, TUI.muted, selected)
            : pane.link(row.prUrl, row.prLabel, selected),
        ];
      });
      pane.setTable([...header, ...body]);

      const text =
        model.mode === "assign"
          ? [
              ...model.pickerLines,
              "",
              "j/k choose · enter assign · esc cancel",
            ].join("\n")
          : model.detailText;
      pane.setDetail(text, model.detailTitle);
      pane.setFocusedPane(model.mode === "detail" ? "detail" : null);
      pane.setStatus(model.statusLine);
      pane.requestRender();
    },
    destroy: () => pane.destroy(),
  };
}

export type InboxDeps = CliDeps & {
  readonly createInboxView?: () => InboxView | Promise<InboxView>;
  readonly now?: () => number;
};

function openInBrowser(url: string, deps: InboxDeps): void {
  const [command, args]: [string, readonly string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const spawnFn = deps.spawn;
  if (spawnFn !== undefined) {
    spawnFn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    return;
  }
  const child = spawn(command, [...args], { stdio: "ignore" });
  // xdg-open/open missing must not crash the TUI.
  child.on("error", () => undefined);
  child.unref();
}

// `pile inbox` / `pile issues` — two-pane triage inbox: issue table on the
// left, description + comments for the selected issue on the right, with
// keyboard status moves, assign, comment, and PR open.
export async function inboxCommand(
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

  const parsedInterval = Number(flagString(flags, "interval") ?? "5000");
  const intervalMs = Number.isFinite(parsedInterval)
    ? Math.max(250, parsedInterval)
    : 5000;
  const parsedLimit = Number(flagString(flags, "limit") ?? "100");
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(100, Math.max(1, Math.floor(parsedLimit)))
    : 100;

  const api = createInboxApi({
    doFetch: deps.fetch ?? fetch,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    workspace,
  });
  const now = deps.now ?? (() => Date.now());
  const model = new InboxModel();
  const view = await (deps.createInboxView !== undefined
    ? deps.createInboxView()
    : createOpenTuiInboxView());

  let stopped = false;
  let inputOpen = false;
  let resolveQuit!: () => void;
  const quit = new Promise<void>((resolve) => {
    resolveQuit = resolve;
  });

  const render = () => {
    view.render(model.viewModel(now(), view.tableViewportRows()));
  };

  const statusFlag = flagString(flags, "status");
  if (statusFlag !== undefined && isInboxStatus(statusFlag)) {
    model.setFilter({ status: statusFlag });
  }
  const searchFlag = flagString(flags, "search");
  if (searchFlag !== undefined) {
    model.setFilter({ search: searchFlag });
  }
  const teamFlag = flagString(flags, "team");

  let teamsLoaded = false;
  async function ensureTeams(): Promise<void> {
    if (teamsLoaded) return;
    teamsLoaded = true;
    try {
      model.setTeams(await api.listTeams());
    } catch {
      // team labels are cosmetic; leave raw ids
    }
  }

  let assigneesLoaded = false;
  let cachedMembers: InboxMember[] = [];
  let cachedAgents: InboxAgent[] = [];
  async function ensureAssignees(): Promise<void> {
    if (assigneesLoaded) return;
    assigneesLoaded = true;
    cachedMembers = await api.listMembers().catch(() => []);
    // agent:read is optional — tokens without it just get no agent entries.
    cachedAgents = await api.listAgents().catch(() => []);
  }

  async function refreshComments(): Promise<void> {
    const selected = model.selected;
    if (selected === null) return;
    const comments = await api
      .listComments(selected.id)
      .catch((): InboxComment[] | null => null);
    if (!stopped && comments !== null) {
      model.setComments(selected.id, comments);
    }
  }

  async function pollOnce(): Promise<void> {
    await ensureTeams();
    if (stopped) return;
    if (teamFlag !== undefined && model.filter.teamId === undefined) {
      model.setFilter({ teamId: model.resolveTeamId(teamFlag) ?? teamFlag });
    }
    try {
      const issues = await api.listIssues(model.filter, limit);
      if (stopped) return;
      model.setIssues(issues);
      model.setError(null);
    } catch (error) {
      model.setError(errorMessage(error));
      render();
      return;
    }
    await refreshComments();
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

  function moveStatus(status: InboxStatus): void {
    const selected = model.selected;
    if (selected === null || selected.status === status) return;
    void runAction(async () => {
      const updated = await api.setStatus(selected.id, status);
      if (updated !== null) model.upsertIssue(updated);
      model.setNotice(`${selected.identifier} → ${status}`);
      void poll();
      render();
    });
  }

  function assignSelected(): void {
    const selected = model.selected;
    if (selected === null) return;
    void runAction(async () => {
      await ensureAssignees();
      if (stopped || model.selected?.id !== selected.id) return;
      const options: InboxPickerOption[] = [
        { label: "unassign", description: "clear assignee", value: null },
        ...cachedMembers.map((member) => ({
          label: member.userId,
          description: member.role,
          value: member.userId as string | null,
        })),
        ...cachedAgents.map((agent) => ({
          label: agent.agentId,
          description: "agent",
          value: agent.agentId as string | null,
        })),
      ];
      model.openPicker(options);
      render();
    });
  }

  function commitAssign(): void {
    const selected = model.selected;
    const option = model.pickerSelection;
    model.closePicker();
    if (selected === null || option === null) {
      render();
      return;
    }
    const assigneeId = option.value;
    void runAction(async () => {
      const updated = await api.assign(selected.id, assigneeId);
      if (updated !== null) model.upsertIssue(updated);
      model.setNotice(
        assigneeId === null
          ? `${selected.identifier} unassigned`
          : `${selected.identifier} → @${shortAssignee(assigneeId)}`
      );
      void poll();
      render();
    });
  }

  function openInput(options: InboxPromptOptions): void {
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

  function promptComment(): void {
    const selected = model.selected;
    if (selected === null) return;
    openInput({
      title: `comment on ${selected.identifier}`,
      placeholder: "write a comment, enter to post, esc to cancel",
      onSubmit(value) {
        inputOpen = false;
        model.setMode("list");
        const body = value.trim();
        if (body.length === 0) {
          render();
          return;
        }
        void runAction(async () => {
          const comment = await api.addComment(selected.id, body);
          if (comment !== null) model.appendComment(selected.id, comment);
          model.setNotice(`comment posted on ${selected.identifier}`);
          await refreshComments();
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

  function promptSearch(): void {
    openInput({
      title: "search issues",
      placeholder: "title/description text — empty clears the filter",
      initial: model.filter.search,
      onSubmit(value) {
        inputOpen = false;
        model.setMode("list");
        model.setFilter({ search: value.trim() });
        void poll();
        render();
      },
      onCancel() {
        inputOpen = false;
        model.setMode("list");
        render();
      },
    });
  }

  function openSelectedPr(): void {
    const selected = model.selected;
    if (selected === null || selected.prUrl === null) {
      model.setNotice("no linked PR");
      render();
      return;
    }
    const url = selected.prUrl;
    void runAction(async () => {
      openInBrowser(url, deps);
      model.setNotice(`opened ${shortPrRef(url) ?? url}`);
      render();
    });
  }

  view.onKey((key) => {
    if (stopped) return;
    if (key.ctrl && key.name === "c") {
      stopped = true;
      resolveQuit();
      return;
    }
    // While a text prompt owns the keyboard, only ctrl-c is global.
    if (inputOpen) return;
    if (key.name === "q") {
      stopped = true;
      resolveQuit();
      return;
    }
    if (model.currentMode === "assign") {
      if (key.name === "escape") {
        model.closePicker();
      } else if (key.name === "j" || key.name === "down") {
        model.movePicker(1);
      } else if (key.name === "k" || key.name === "up") {
        model.movePicker(-1);
      } else if (key.name === "return" || key.name === "linefeed") {
        commitAssign();
        return;
      }
      render();
      return;
    }
    if (model.currentMode === "detail") {
      if (key.name === "escape" || key.name === "tab") {
        model.setMode("list");
      } else if (key.name === "j" || key.name === "down") {
        view.scrollDetail(3);
      } else if (key.name === "k" || key.name === "up") {
        view.scrollDetail(-3);
      } else if (key.name === "g") {
        view.scrollDetailTo(key.shift ? "bottom" : "top");
      }
      render();
      return;
    }
    if (key.name === "j" || key.name === "down") {
      if (model.moveSelection(1)) void refreshComments().then(render);
    } else if (key.name === "k" || key.name === "up") {
      if (model.moveSelection(-1)) void refreshComments().then(render);
    } else if (key.name === "g") {
      if (key.shift ? model.selectLast() : model.selectFirst()) {
        void refreshComments().then(render);
      }
    } else if (key.name === "tab") {
      model.setMode("detail");
    } else if (key.name === "b") {
      moveStatus("backlog");
    } else if (key.name === "t") {
      moveStatus("todo");
    } else if (key.name === "i") {
      moveStatus("in_progress");
    } else if (key.name === "d") {
      moveStatus("done");
    } else if (key.name === "x") {
      moveStatus("canceled");
    } else if (key.name === "a") {
      assignSelected();
      return;
    } else if (key.name === "c") {
      promptComment();
      return;
    } else if (key.name === "o") {
      openSelectedPr();
      return;
    } else if (key.name === "/") {
      promptSearch();
      return;
    } else if (key.name === "f") {
      model.cycleStatusFilter();
      void poll();
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
