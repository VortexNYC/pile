import type { WorkspaceDO } from "../workspace/durable-object.js";

const FOLLOWUP_TYPES = new Set(["prompt.followup", "prompt.followup_failed"]);

const DEFAULT_FOLLOWUP_THROTTLE_MINUTES = 5;

/** Follow-up prompt window from the workspace's provider config
 * (`followupThrottleMinutes`); falls back to 5m. A value of 0 disables
 * throttling entirely. */
export function followupThrottleWindowMs(
  configJson: string | null | undefined
): number {
  if (!configJson) return DEFAULT_FOLLOWUP_THROTTLE_MINUTES * 60 * 1000;
  try {
    const parsed: unknown = JSON.parse(configJson);
    if (typeof parsed !== "object" || parsed === null) {
      return DEFAULT_FOLLOWUP_THROTTLE_MINUTES * 60 * 1000;
    }
    const value = (parsed as Record<string, unknown>).followupThrottleMinutes;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value * 60 * 1000;
    }
  } catch {
    /* invalid JSON — keep default */
  }
  return DEFAULT_FOLLOWUP_THROTTLE_MINUTES * 60 * 1000;
}

/** PILE-226: bound follow-up prompt spam — at most one attempted
 * follow-up per lane per window, regardless of source (reviews, CI,
 * comments). The window comes from the lane's provider config so each
 * workspace tunes its own bound. */
export async function laneFollowupThrottled(
  stub: DurableObjectStub<WorkspaceDO>,
  sessionId: string,
  windowMs: number
): Promise<boolean> {
  if (windowMs <= 0) return false;
  const events = await stub
    .listAgentSessionEvents(sessionId, { limit: 50, order: "desc" })
    .catch(() => []);
  const cutoff = Date.now() - windowMs;
  return events.some(
    (e) => FOLLOWUP_TYPES.has(e.type) && Date.parse(e.createdAt ?? "") > cutoff
  );
}
