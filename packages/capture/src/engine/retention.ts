import {
  MAX_ACTION_EVENT_COUNT,
  MAX_CONSOLE_EVENT_COUNT,
  MAX_ERROR_EVENT_COUNT,
  MAX_EVENT_COUNT,
  MAX_NETWORK_EVENT_COUNT,
  NETWORK_DEDUP_WINDOW_MS,
} from "../constants";
import type { DebuggerEvent } from "../types";

const KIND_CAPS: Record<DebuggerEvent["kind"], number> = {
  action: MAX_ACTION_EVENT_COUNT,
  console: MAX_CONSOLE_EVENT_COUNT,
  network: MAX_NETWORK_EVENT_COUNT,
  error: MAX_ERROR_EVENT_COUNT,
};

const EVICTION_PRIORITY: DebuggerEvent["kind"][] = [
  "console",
  "action",
  "network",
  "error",
];

function countKind(events: DebuggerEvent[], kind: DebuggerEvent["kind"]) {
  let count = 0;
  for (const event of events) {
    if (event.kind === kind) {
      count += 1;
    }
  }
  return count;
}

function findOldestEventIndexByPriority(
  events: DebuggerEvent[],
  priority: DebuggerEvent["kind"][]
): number {
  for (const kind of priority) {
    const index = events.findIndex((event) => event.kind === kind);
    if (index >= 0) {
      return index;
    }
  }
  return 0;
}

export function appendEventWithRetentionPolicy(
  events: DebuggerEvent[],
  event: DebuggerEvent
): void {
  events.push(event);

  const kindCap = KIND_CAPS[event.kind];
  while (countKind(events, event.kind) > kindCap) {
    const index = events.findIndex(
      (candidate) => candidate.kind === event.kind
    );
    if (index < 0) {
      break;
    }
    events.splice(index, 1);
  }

  while (events.length > MAX_EVENT_COUNT) {
    const dropIndex = findOldestEventIndexByPriority(events, EVICTION_PRIORITY);
    events.splice(dropIndex, 1);
  }
}

export function appendNetworkEventWithDedup(
  events: DebuggerEvent[],
  event: Extract<DebuggerEvent, { kind: "network" }>
): void {
  if (isLikelyDuplicateNetworkEvent(events, event)) {
    return;
  }
  appendEventWithRetentionPolicy(events, event);
}

export function appendActionEventWithDedup(
  events: DebuggerEvent[],
  event: Extract<DebuggerEvent, { kind: "action" }>
): void {
  if (isLikelyDuplicateNavigationEvent(events, event)) {
    return;
  }
  appendEventWithRetentionPolicy(events, event);
}

function isLikelyDuplicateNetworkEvent(
  events: DebuggerEvent[],
  candidate: Extract<DebuggerEvent, { kind: "network" }>
): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.kind !== "network") {
      continue;
    }
    const isSameKey =
      event.method === candidate.method &&
      event.url === candidate.url &&
      (event.status ?? 0) === (candidate.status ?? 0);
    if (!isSameKey) {
      continue;
    }
    const delta = Math.abs(event.timestamp - candidate.timestamp);
    if (delta > NETWORK_DEDUP_WINDOW_MS) {
      return false;
    }
    return true;
  }
  return false;
}

function isLikelyDuplicateNavigationEvent(
  events: DebuggerEvent[],
  candidate: Extract<DebuggerEvent, { kind: "action" }>
): boolean {
  if (candidate.actionType !== "navigation") {
    return false;
  }
  const candidateUrl =
    typeof candidate.metadata?.url === "string" ? candidate.metadata.url : "";
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      !event ||
      event.kind !== "action" ||
      event.actionType !== "navigation"
    ) {
      continue;
    }
    const eventUrl =
      typeof event.metadata?.url === "string" ? event.metadata.url : "";
    if (eventUrl === candidateUrl) {
      return true;
    }
    return false;
  }
  return false;
}
