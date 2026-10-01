import type { WorkspaceDO } from "../workspace/durable-object.js";

// Consecutive provision-timeout deaths across ALL agents — the lane never
// got a runner because the substrate (container pool, provider fleet) is
// saturated, not because the lane was sick. While the breaker is open,
// system-generated dispatches (queue promotion, retries, repo triggers)
// stand down: pouring new spawn attempts into a saturated pool is how a
// capacity blip becomes a self-inflicted outage. User-initiated dispatch is
// not gated — a human retrying a lane is a deliberate choice.
export const FLEET_UNHEALTHY_STREAK = 4;

const TERMINAL = new Set(["completed", "failed", "canceled"]);
const PROVISION_TIMEOUT = "provision timed out";

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
    if (
      TERMINAL.has(s.status) &&
      s.infraFailure === 1 &&
      (s.result ?? "").includes(PROVISION_TIMEOUT)
    ) {
      streak += 1;
    } else break;
  }
  return streak;
}
