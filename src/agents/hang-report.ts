import { scrubCaptureText } from "../global/redact.js";
import type { AgentSession } from "../types/workspace.js";
import type { AgentProviderState } from "./provider.js";

export type HangReason = "timeout" | "inactive" | "external_silent";

interface HangTrailEntry {
  type: string;
  message: string;
  createdAt: string;
}

/** Evidence captured at the moment the sweep kills a lane: where it died,
 *  how long each phase ran, and what the runner looked like — so a retry or
 *  a human can pick up from the failure point instead of a bare "stalled". */
export interface HangReport {
  reason: HangReason;
  detectedAt: string;
  status: AgentSession["status"];
  providerSessionId: string | null;
  retryCount: number;
  phases: {
    queuedMs: number | null;
    runningMs: number | null;
    silentMs: number | null;
    totalMs: number | null;
  };
  lastActivity: HangTrailEntry | null;
  lastEvent: HangTrailEntry | null;
  process: {
    runner: string | null;
    lastSeenAt: string | null;
    logTail: string | null;
  } | null;
}

const MESSAGE_MAX = 500;
const LOG_TAIL_MAX = 2000;
const RUNNER_STATE_MAX = 1000;

function msBetween(from: string | null | undefined, to: number): number | null {
  if (!from) return null;
  const start = Date.parse(from);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, to - start);
}

function clip(text: string, max: number, fromEnd = false): string {
  if (text.length <= max) return text;
  return fromEnd ? `…${text.slice(-max)}` : `${text.slice(0, max)}…`;
}

function trailEntry(
  entry: { type: string; message: string | null; createdAt: string } | null
): HangTrailEntry | null {
  if (!entry) return null;
  return {
    type: entry.type,
    message: clip(scrubCaptureText(entry.message ?? ""), MESSAGE_MAX),
    createdAt: entry.createdAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function summarizeProcess(
  state: AgentProviderState | null
): HangReport["process"] {
  if (!state) return null;
  const provider = isRecord(state.provider) ? state.provider : null;
  const compute = isRecord(state.compute) ? state.compute : null;
  const logs = provider?.logs;
  const runner = provider && "state" in provider ? provider.state : null;
  return {
    runner:
      runner === null || runner === undefined
        ? null
        : clip(scrubCaptureText(JSON.stringify(runner)), RUNNER_STATE_MAX),
    lastSeenAt: typeof compute?.lastSeen === "string" ? compute.lastSeen : null,
    logTail:
      typeof logs === "string" && logs.trim()
        ? clip(scrubCaptureText(logs.trimEnd()), LOG_TAIL_MAX, true)
        : null,
  };
}

export function buildHangReport(input: {
  session: Pick<
    AgentSession,
    | "status"
    | "createdAt"
    | "startedAt"
    | "lastProgressAt"
    | "providerSessionId"
    | "retryCount"
  >;
  reason: HangReason;
  now: number;
  lastActivity: {
    type: string;
    message: string | null;
    createdAt: string;
  } | null;
  lastEvent: { type: string; message: string | null; createdAt: string } | null;
  state: AgentProviderState | null;
}): HangReport {
  const { session, now } = input;
  const started = session.startedAt ? Date.parse(session.startedAt) : NaN;
  return {
    reason: input.reason,
    detectedAt: new Date(now).toISOString(),
    status: session.status,
    providerSessionId: session.providerSessionId ?? null,
    retryCount: session.retryCount ?? 0,
    phases: {
      queuedMs: Number.isFinite(started)
        ? msBetween(session.createdAt, started)
        : msBetween(session.createdAt, now),
      runningMs: msBetween(session.startedAt, now),
      silentMs: msBetween(session.lastProgressAt ?? session.createdAt, now),
      totalMs: msBetween(session.createdAt, now),
    },
    lastActivity: trailEntry(input.lastActivity),
    lastEvent: trailEntry(input.lastEvent),
    process: summarizeProcess(input.state),
  };
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "n/a";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function lastLines(text: string, count: number): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-count)
    .join("\n");
}

/** Human-facing digest of a hang report — appended to the cancel reason so
 *  the issue annotation shows where the lane died. */
export function formatHangReport(report: HangReport): string {
  const { phases } = report;
  const lines = [
    `Hang report (${report.reason}):`,
    `- phases: queued ${formatDuration(phases.queuedMs)}, running ${formatDuration(phases.runningMs)}, silent ${formatDuration(phases.silentMs)}`,
  ];
  if (report.lastActivity) {
    lines.push(
      `- last activity: [${report.lastActivity.type}] ${clip(report.lastActivity.message, 200)} (${report.lastActivity.createdAt})`
    );
  } else {
    lines.push("- last activity: none recorded");
  }
  if (report.lastEvent) {
    lines.push(
      `- last event: [${report.lastEvent.type}] ${clip(report.lastEvent.message, 200)} (${report.lastEvent.createdAt})`
    );
  }
  if (report.process?.lastSeenAt) {
    lines.push(`- compute last seen: ${report.process.lastSeenAt}`);
  }
  if (report.process?.logTail) {
    lines.push(
      "- log tail:",
      "```",
      lastLines(report.process.logTail, 5),
      "```"
    );
  }
  return lines.join("\n");
}
