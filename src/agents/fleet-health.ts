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
// Per-provider variant of the same signal: one provider's fleet can be down
// while the rest spawn fine (PILE-240).
export const PROVIDER_UNHEALTHY_STREAK = 3;

// PILE-452 — the streak misses a degraded fleet: start failures interleaved
// with kept-alive successes never reach 4 in a row. A failure RATE over a
// trailing window catches the partial outage the consecutive count can't.
export const FLEET_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const FLEET_FAILURE_RATE = 0.2;

const TERMINAL = new Set(["completed", "failed", "canceled"]);

interface SessionHealthRow {
  status: string;
  infraFailure: number;
  createdAt: string;
}

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

export async function providerInfraStreak(
  stub: DurableObjectStub<WorkspaceDO>,
  agentId: string
): Promise<number> {
  const recent = await stub.listAgentSessions({ limit: 20 });
  let streak = 0;
  for (const s of recent) {
    if (s.agentId !== agentId) continue;
    // `created`/`waiting` are undetermined — provision hasn't concluded, so
    // a just-promoted lane proves nothing either way. Without this skip a
    // rewound promotion lands at the head of the recency order and masks a
    // live infra streak underneath it (PILE-260).
    if (s.status === "created" || s.status === "waiting") continue;
    // Infra-class = provider-reported substrate failure OR a sweep
    // stall-cancel (both carry infraFailure); task failures and operator
    // cancels don't count.
    if (s.infraFailure === 1 && TERMINAL.has(s.status)) streak += 1;
    else break;
  }
  return streak;
}

export interface StartFailureStats {
  /** Sessions in the window that attempted a start (parked queue holds
   *  excluded — they never reached the substrate). */
  starts: number;
  /** Of those, the ones that ended infra-failed. */
  infraFailures: number;
  /** infraFailures / starts — null when nothing started in the window. */
  rate: number | null;
}

/** Start-failure stats over the trailing FLEET_FAILURE_WINDOW_MS for a set
 *  of sessions (filtered by the caller — the endpoint passes one provider's
 *  rows, the breaker passes the fleet's). */
export function startFailureStats(
  sessions: Iterable<SessionHealthRow>,
  now = Date.now()
): StartFailureStats {
  let starts = 0;
  let infraFailures = 0;
  for (const s of sessions) {
    // `waiting` rows are parked holds or queue entries — no start attempted.
    if (s.status === "waiting") continue;
    const created = Date.parse(s.createdAt);
    if (!Number.isFinite(created)) continue;
    const age = now - created;
    if (age < 0 || age > FLEET_FAILURE_WINDOW_MS) continue;
    starts += 1;
    if (TERMINAL.has(s.status) && s.infraFailure === 1) infraFailures += 1;
  }
  return {
    starts,
    infraFailures,
    rate: starts === 0 ? null : infraFailures / starts,
  };
}

/** Whether the rate signal is red: more than FLEET_FAILURE_RATE of starts
 *  in the window died on infra. */
export function startFailureRateUnhealthy(stats: StartFailureStats): boolean {
  return stats.rate !== null && stats.rate > FLEET_FAILURE_RATE;
}
