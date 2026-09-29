import type { WorkspaceDO } from "../workspace/durable-object.js";

const FOLLOWUP_TYPES = new Set(["prompt.followup", "prompt.followup_failed"]);

/** PILE-226: bound follow-up prompt spam — at most one attempted
 * follow-up per lane per window, regardless of source (reviews, CI). */
export async function laneFollowupThrottled(
  stub: DurableObjectStub<WorkspaceDO>,
  sessionId: string,
  windowMs: number
): Promise<boolean> {
  const events = await stub
    .listAgentSessionEvents(sessionId, { limit: 50 })
    .catch(() => []);
  const cutoff = Date.now() - windowMs;
  return events.some(
    (e) => FOLLOWUP_TYPES.has(e.type) && Date.parse(e.createdAt ?? "") > cutoff
  );
}
