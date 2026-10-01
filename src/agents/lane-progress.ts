import { z } from "zod";

import type { AgentSession, AgentSessionStatus } from "../types/workspace.js";

/** One live comment per lane on its issue (PILE-290): created when the lane
 *  starts running, edited in place as it reports steps, frozen on terminal. */
export const LANE_PROGRESS_SUFFIX = ":progress";

/** Chatty activity types (narration) refresh the comment at most this often;
 *  status changes, actions, errors, and task-list reports refresh at once. */
export const LANE_PROGRESS_THROTTLE_MS = 30 * 1000;

/** Session writes that change nothing visible (a poll echoing the same
 *  state) still refresh elapsed/ETA, but no more often than this. */
export const LANE_PROGRESS_HEARTBEAT_MS = 5 * 60 * 1000;

export const laneTodoSchema = z.object({
  content: z.string().min(1).max(500),
  status: z.enum(["pending", "in_progress", "completed"]),
});

export const laneTodosSchema = z.array(laneTodoSchema).max(50);

export type LaneTodo = z.infer<typeof laneTodoSchema>;

export function laneProgressExternalId(sessionId: string): string {
  return `${sessionId}${LANE_PROGRESS_SUFFIX}`;
}

const STEP_ACTIVITY_TYPES = new Set([
  "thought",
  "response",
  "error",
  "elicitation",
  "action",
]);

interface ActivityLike {
  type: string;
  message: string;
  payload: string | null;
}

function parsePayload(payload: string | null): unknown {
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** Newest-first activities → current step + latest reported task list. */
export function laneProgressFromActivities(activities: ActivityLike[]): {
  step: string | null;
  todos: LaneTodo[] | null;
} {
  let step: string | null = null;
  let todos: LaneTodo[] | null = null;
  for (const activity of activities) {
    if (todos === null) {
      const payload = parsePayload(activity.payload);
      if (payload !== null && typeof payload === "object") {
        const parsed = laneTodosSchema.safeParse(
          (payload as Record<string, unknown>).todos
        );
        if (parsed.success) todos = parsed.data;
      }
    }
    if (step === null && STEP_ACTIVITY_TYPES.has(activity.type)) {
      const line = activity.message.trim().split("\n")[0]?.trim() ?? "";
      if (line) step = line.length > 200 ? `${line.slice(0, 199)}…` : line;
    }
    if (step !== null && todos !== null) break;
  }
  return { step, todos };
}

/** Median wall time of recent completed lanes — the "typical lane" ETA
 *  baseline. Null when there is no usable history. */
export function typicalLaneDurationMs(
  rows: Array<{
    startedAt: string | null;
    createdAt: string;
    endedAt: string | null;
  }>
): { ms: number; samples: number } | null {
  const durations = rows
    .map((row) => {
      if (!row.endedAt) return NaN;
      return (
        Date.parse(row.endedAt) - Date.parse(row.startedAt ?? row.createdAt)
      );
    })
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .toSorted((a, b) => a - b);
  if (durations.length === 0) return null;
  const mid = Math.floor(durations.length / 2);
  const upper = durations[mid] ?? 0;
  const ms =
    durations.length % 2 === 0
      ? Math.round(((durations[mid - 1] ?? upper) + upper) / 2)
      : upper;
  return { ms, samples: durations.length };
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

function formatClock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

const HEADLINE: Record<AgentSessionStatus, string> = {
  created: "is starting",
  running: "is on it",
  waiting: "is waiting",
  completed: "completed",
  failed: "failed",
  canceled: "was canceled",
};

const TERMINAL = new Set<AgentSessionStatus>([
  "completed",
  "failed",
  "canceled",
]);

export interface LaneProgressInput {
  session: Pick<
    AgentSession,
    | "id"
    | "organizationId"
    | "agentId"
    | "status"
    | "url"
    | "prUrl"
    | "branch"
    | "createdAt"
    | "startedAt"
    | "endedAt"
  >;
  step: string | null;
  todos: LaneTodo[] | null;
  typical: { ms: number; samples: number } | null;
  /** Pile API origin — used for the session link when the provider has no
   *  UI url of its own. */
  apiBaseUrl?: string | null;
  now: number;
}

export function renderLaneProgressComment(input: LaneProgressInput): string {
  const { session, step, todos, typical, now } = input;
  const status = session.status as AgentSessionStatus;
  const terminal = TERMINAL.has(status);
  const started = Date.parse(session.startedAt ?? session.createdAt);
  const ended = terminal && session.endedAt ? Date.parse(session.endedAt) : now;
  const elapsed = Number.isFinite(started) ? ended - started : null;

  const headline =
    terminal && elapsed !== null
      ? `**Agent ${session.agentId} ${HEADLINE[status]}** after ${formatDuration(elapsed)}`
      : `**Agent ${session.agentId} ${HEADLINE[status]}**`;

  const pileSessionUrl = input.apiBaseUrl
    ? `${input.apiBaseUrl.replace(/\/$/, "")}/workspaces/${session.organizationId}/agent/sessions/${session.id}`
    : null;
  const link = session.url ?? pileSessionUrl;
  const lines: string[] = [headline, ""];
  lines.push(
    `- Session: ${link ? `[${session.id}](${link})` : `\`${session.id}\``}` +
      ` · \`pile agent sessions watch ${session.id} --workspace ${session.organizationId}\``
  );
  if (step) lines.push(`- ${terminal ? "Last step" : "Current step"}: ${step}`);
  if (Number.isFinite(started)) {
    lines.push(
      terminal
        ? `- Started ${formatClock(started)} · ended ${formatClock(ended)}`
        : `- Started ${formatClock(started)} · updated ${formatClock(now)} (${formatDuration(ended - started)} elapsed)`
    );
  }
  if (!terminal) {
    if (!typical) {
      lines.push(
        `- ETA: no completed ${session.agentId} lanes to estimate from yet`
      );
    } else if (Number.isFinite(started)) {
      const eta = started + typical.ms;
      const basis = `typical ${session.agentId} lane ≈ ${formatDuration(typical.ms)}, median of last ${typical.samples}`;
      lines.push(
        eta > now
          ? `- ETA: ~${formatClock(eta)} (${basis})`
          : `- ETA: past typical (${basis})`
      );
    }
  }
  if (session.branch) lines.push(`- Branch: \`${session.branch}\``);
  if (session.prUrl) lines.push(`- PR: ${session.prUrl}`);
  if (todos && todos.length > 0) {
    lines.push("", "**Tasks**");
    for (const todo of todos) {
      const mark = todo.status === "completed" ? "x" : " ";
      const suffix = todo.status === "in_progress" ? " _(in progress)_" : "";
      lines.push(`- [${mark}] ${todo.content.split("\n")[0]}${suffix}`);
    }
  }
  return lines.join("\n");
}

/** Message for a step/todos self-report: the explicit step, else the
 *  in-progress task, else a generic marker. */
export function laneReportStepMessage(
  step: string | undefined,
  todos: LaneTodo[] | undefined
): string {
  if (step?.trim()) return step.trim();
  const active = todos?.find((t) => t.status === "in_progress");
  return active?.content ?? "Task list updated";
}
