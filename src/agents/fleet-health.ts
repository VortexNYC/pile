import type { WorkspaceDO } from "../workspace/durable-object.js";

// Consecutive infra-class deaths across ALL agents — provision timeouts,
// container-spawn 503s, RPC transport resets — mean the substrate (container
// pool, provider fleet) is saturated, not that one lane is sick. While the
// breaker is open, system-generated dispatches (queue promotion, retries,
// repo triggers) stand down: pouring new spawn attempts into a saturated
// pool is how a capacity blip becomes a self-inflicted outage.
// User-initiated dispatch is not gated — a human retrying a lane is a
// deliberate choice.
export const FLEET_UNHEALTHY_STREAK = 4;

const TERMINAL = new Set(["completed", "failed", "canceled"]);

export async function fleetInfraStreak(
  stub: DurableObjectStub<WorkspaceDO>
): Promise<number> {
  const recent = await stub.listAgentSessions({ limit: 20 });
  let streak = 0;
  for (const s of recent) {
    // `created`/`waiting` are undetermined — provision hasn't concluded.
    // `running` and non-provision terminals are evidence capacity exists:
    // they break the streak.
    if (s.status === "created" || s.status === "waiting") continue;
    if (TERMINAL.has(s.status) && s.infraFailure === 1) {
      streak += 1;
    } else break;
  }
  return streak;
}

// PILE-476 — per-issue breaker. The redispatch loops (review feedback, CI
// failure, merge conflict, infra retry) re-fire while the issue's lane
// keeps dying: PILE-448 re-dispatched four times in 25 minutes, failing
// every start. Distinct from the fleet/agent breakers — those catch
// substrate outages; this catches a single-issue poison lane. Past the
// cap, automated dispatches stand down for the window and the issue gets
// one comment saying so. User-initiated dispatch is not gated.
export const ISSUE_BREAKER_FAILED_STARTS = 3;
export const ISSUE_BREAKER_WINDOW_MS = 60 * 60 * 1000;
const ISSUE_BREAKER_MARKER = "<!-- pile-issue-breaker -->";

/** Terminal sessions for `issueId` that failed at start inside the window —
 *  any `failed` outcome, plus infra-class deaths of every terminal shape
 *  (a provider/sweep stall-cancel is a failed start too). */
export async function issueFailedStartCount(
  stub: DurableObjectStub<WorkspaceDO>,
  issueId: string,
  now = Date.now()
): Promise<number> {
  const issueSessions = await stub
    .listAgentSessions({ issueId, limit: 25 })
    .catch(() => []);
  const windowStart = now - ISSUE_BREAKER_WINDOW_MS;
  return issueSessions.filter(
    (s) =>
      (s.status === "failed" ||
        (s.infraFailure === 1 && TERMINAL.has(s.status))) &&
      Date.parse(s.createdAt) > windowStart
  ).length;
}

export async function issueBreakerOpen(
  stub: DurableObjectStub<WorkspaceDO>,
  issueId: string,
  now = Date.now()
): Promise<boolean> {
  return (
    (await issueFailedStartCount(stub, issueId, now)) >=
    ISSUE_BREAKER_FAILED_STARTS
  );
}

/** One issue comment per window while the breaker is open — deduped on the
 *  marker so a breaker that stays tripped doesn't comment every pass. */
export async function noteIssueBreakerOpen(
  stub: DurableObjectStub<WorkspaceDO>,
  issueId: string,
  failedStarts: number,
  now = Date.now()
): Promise<void> {
  const comments = await stub.listComments(issueId).catch(() => []);
  const alreadyNoted = comments.some(
    (c) =>
      c.body.includes(ISSUE_BREAKER_MARKER) &&
      Date.parse(c.createdAt) > now - ISSUE_BREAKER_WINDOW_MS
  );
  if (alreadyNoted) return;
  await stub
    .createComment({
      issueId,
      body:
        `${ISSUE_BREAKER_MARKER}\n**Stopped — issue breaker open.**\n\n` +
        `${failedStarts} lane starts on this issue failed in the last hour ` +
        `(cap ${ISSUE_BREAKER_FAILED_STARTS}). Automated redispatch ` +
        "(review feedback, CI failure, merge conflict, infra retry) is " +
        "paused so a doomed lane stops burning spawn attempts. Fix what's " +
        "killing the starts, then retry the session manually.",
      externalAuthor: "pile-sweep",
      externalSource: "issue-breaker",
    })
    .catch(() => {});
}
