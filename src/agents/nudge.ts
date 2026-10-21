import { createD1 } from "../global/db.js";
import { VortexError } from "../platform/errors.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { AgentSession, Issue } from "../types/workspace.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import { loadProviderConfig } from "./credentials.js";
import { resolveAgentEnv } from "./daytona.js";
import {
  FLEET_UNHEALTHY_STREAK,
  fleetInfraStreak,
  PROVIDER_UNHEALTHY_STREAK,
  providerInfraStreak,
} from "./fleet-health.js";
import { followupThrottleWindowMs, laneFollowupThrottled } from "./followup.js";
import {
  dispatchAgent,
  failedDispatchSessionId,
  getAgentProvider,
  inheritTeamDefaultRepo,
} from "./index.js";

const DELIVERED_TYPES = new Set(["prompt.followup", "prompt.redispatch"]);

// PILE-270 — retry budget. Every automated remediation path funnels through
// nudgeLane, so this is the safety valve: past either cap the lane stops
// burning provider spend and the issue goes to a human.
export const MAX_NUDGES_PER_HEAD_SHA = 3;
export const MAX_NUDGES_PER_LANE = 5;
// PILE-452 — automatic cold redispatches (dead kept sandbox) get a tighter
// budget than nudges: each one is a full provider spawn, and during a
// substrate outage the sweep was re-failing them every 5 minutes. Two
// attempts with exponential backoff, then the lane escalates through the
// normal nudge budget instead.
export const MAX_LANE_REDISPATCHES = 2;
const REDISPATCH_BACKOFF_BASE_MS = 5 * 60 * 1000;

/** Delay before the next automatic redispatch, given how many already ran:
 *  ~5m after the first, ~10m after the second (though the cap stops there).
 *  ±25% jitter — lanes that failed together must not retry together: a
 *  synchronized wave into a sick Daytona just re-fails in lockstep.
 *  `rand` is injectable so tests stay deterministic. */
export function redispatchBackoffMs(
  priorAttempts: number,
  rand: () => number = Math.random
): number {
  if (priorAttempts <= 0) return 0;
  const base = REDISPATCH_BACKOFF_BASE_MS * 2 ** (priorAttempts - 1);
  return Math.round(base * (0.75 + rand() * 0.5));
}
// A lane's budget follows nudge redispatches (prompt.redispatch → retryOf),
// so a cold-dispatched successor doesn't start from zero. Human retries
// break the chain and get a fresh budget.
const LANE_CHAIN_MAX_DEPTH = 10;

export interface NudgeOptions {
  /** A thunk defers expensive prompt context until delivery is attempted. */
  prompt: string | (() => Promise<string>);
  reason: string;
  dedupeKey?: string;
  headSha?: string | null;
}

export interface LaneResolutionOptions {
  /** Side-lane purposes that never own the issue's PR (e.g. review). */
  excludePurpose?: string;
  limit?: number;
}

// Resolve the lane for an issue: a live session first, else the most
// recent completed one — kept-sandbox providers resume completed lanes on
// the follow-up. Returns null when the issue never had a lane.
// PILE-249 — dead lanes still resolve: a review on a failed/canceled
// lane's PR gets its detection event plus a prompt.followup_skipped
// record from nudgeLane instead of silence.
export async function resolveLaneForIssue(
  stub: DurableObjectStub<WorkspaceDO>,
  issueId: string,
  opts: LaneResolutionOptions = {}
): Promise<AgentSession | null> {
  const sessions = await stub
    .listAgentSessions({ issueId, limit: opts.limit ?? 20 })
    .catch(() => []);
  const lanes =
    opts.excludePurpose === undefined
      ? sessions
      : sessions.filter((s) => s.purpose !== opts.excludePurpose);
  return (
    lanes.find((s) => s.status === "running" || s.status === "waiting") ??
    lanes.find((s) => s.status === "completed") ??
    lanes.find((s) => s.status === "failed" || s.status === "canceled") ??
    null
  );
}

type SessionEvent = Awaited<
  ReturnType<WorkspaceDO["listAgentSessionEvents"]>
>[number];

interface NudgeRound {
  sessionId: string;
  message: string;
  headSha: string | null;
}

function eventPayload(e: SessionEvent): Record<string, unknown> | null {
  if (typeof e.payload !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(e.payload);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export interface LaneRedispatchStats {
  /** prompt.redispatch attempts on the lane's chain — failures count too
   *  (the event lands with dispatchFailed:true, PILE-452). */
  count: number;
  /** Newest attempt's event time — the backoff anchor. */
  lastAt: number | null;
}

/** Delivered PR nudges across the lane's redispatch chain, plus whether the
 *  chain was already escalated and the redispatch tally for the cap/backoff
 *  gate. Human follow-ups (`/prompt`, issue comments) carry no prUrl and
 *  don't spend the budget. */
async function laneNudgeHistory(
  stub: DurableObjectStub<WorkspaceDO>,
  session: AgentSession,
  sessionEvents: SessionEvent[]
): Promise<{
  rounds: NudgeRound[];
  escalated: boolean;
  redispatches: LaneRedispatchStats;
}> {
  const rounds: NudgeRound[] = [];
  const redispatches: LaneRedispatchStats = { count: 0, lastAt: null };
  let escalated = false;
  let currentId = session.id;
  let events = sessionEvents;
  let parentId = session.retryOf;
  for (let depth = 0; ; depth++) {
    for (const e of events) {
      if (e.type === "issue.escalated") escalated = true;
      if (!DELIVERED_TYPES.has(e.type)) continue;
      const payload = eventPayload(e);
      if (!payload || !("prUrl" in payload)) continue;
      rounds.push({
        sessionId: currentId,
        message: e.message,
        headSha: typeof payload.headSha === "string" ? payload.headSha : null,
      });
      if (e.type === "prompt.redispatch") {
        redispatches.count += 1;
        const at = Date.parse(e.createdAt);
        if (
          Number.isFinite(at) &&
          (redispatches.lastAt === null || at > redispatches.lastAt)
        ) {
          redispatches.lastAt = at;
        }
      }
    }
    if (!parentId || depth >= LANE_CHAIN_MAX_DEPTH) break;
    const parentEvents = await stub
      .listAgentSessionEvents(parentId, { limit: 200, order: "desc" })
      .catch(() => []);
    const childId = currentId;
    const linked = parentEvents.some(
      (e) =>
        e.type === "prompt.redispatch" &&
        eventPayload(e)?.redispatchedAs === childId
    );
    if (!linked) break;
    const parent = await stub.getAgentSession(parentId).catch(() => undefined);
    currentId = parentId;
    events = parentEvents;
    parentId = parent?.retryOf ?? null;
  }
  return { rounds, escalated, redispatches };
}

function nudgeBudgetExhausted(
  rounds: NudgeRound[],
  headSha: string | null | undefined
): string | null {
  if (headSha) {
    const onSha = rounds.filter((r) => r.headSha === headSha).length;
    if (onSha >= MAX_NUDGES_PER_HEAD_SHA) {
      return `${onSha} nudge rounds on sha ${headSha} (cap ${MAX_NUDGES_PER_HEAD_SHA})`;
    }
  }
  if (rounds.length >= MAX_NUDGES_PER_LANE) {
    return `${rounds.length} nudge rounds on this lane (cap ${MAX_NUDGES_PER_LANE})`;
  }
  return null;
}

/** Hand the issue to a human: one issue.escalated event (the dedupe marker,
 *  written first so a failed comment/status write never re-fires it), an
 *  issue comment with what failed and what was tried, and a move to triage. */
async function escalateLane(
  stub: DurableObjectStub<WorkspaceDO>,
  session: AgentSession,
  issue: Issue,
  prUrl: string,
  opts: NudgeOptions,
  why: string,
  rounds: NudgeRound[]
): Promise<void> {
  const headSha = opts.headSha ?? null;
  try {
    await stub.addAgentSessionEvent({
      sessionId: session.id,
      type: "issue.escalated",
      message: `${opts.reason} nudge budget exhausted (${why}) — escalated to triage`,
      payload: {
        issueId: issue.id,
        prUrl,
        ...(headSha ? { headSha } : {}),
        reason: opts.reason,
        rounds: rounds.length,
        key: `escalated-${session.id}`,
      },
    });
  } catch (err) {
    console.error("lane escalation event failed", {
      sessionId: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const tried = rounds.length
    ? rounds
        .toReversed()
        .map(
          (r) =>
            `- ${r.message}${r.headSha ? ` (sha \`${r.headSha}\`)` : ""}${r.sessionId === session.id ? "" : ` — session \`${r.sessionId}\``}`
        )
        .join("\n")
    : "- (no delivered nudges recorded)";
  const body =
    `**Escalated — automated remediation exhausted.**\n\n` +
    `Lane \`${session.agentId}\` (session \`${session.id}\`) hit its nudge budget on ${prUrl}: ${why}.\n\n` +
    `**What failed:** ${opts.reason}${headSha ? ` at \`${headSha}\`` : ""}.\n\n` +
    `**What was tried:**\n${tried}\n\n` +
    "Automated nudges are stopped for this lane. Unblock it, then retry the session for a fresh budget.";
  await stub
    .createComment({ issueId: issue.id, body })
    .catch((err: unknown) => {
      console.error("lane escalation comment failed", {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  if (
    issue.status !== "triage" &&
    issue.status !== "done" &&
    issue.status !== "canceled"
  ) {
    await stub
      .updateIssue(issue.id, { status: "triage" }, "agent-escalation")
      .catch((err: unknown) => {
        console.error("lane escalation status move failed", {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}

// THE lane nudge path — one implementation shared by the sweep (poll
// backstop) and the GitHub webhook (fast path). sendPrompt through the
// workspace-configured throttle, with an audit event either way.
// PILE-249 — every nudge leaves a trace: prompt.followup on delivery,
// prompt.followup_failed when the provider rejects, and
// prompt.followup_skipped when there's nowhere to deliver. A silent drop
// is what made dead lanes invisible.
export async function nudgeLane(
  env: WorkerEnv,
  stub: DurableObjectStub<WorkspaceDO>,
  organizationId: string,
  session: AgentSession,
  issue: Issue | undefined,
  prUrl: string,
  opts: NudgeOptions
): Promise<void> {
  const dedupeKey = opts.dedupeKey;
  const seen = await stub
    .listAgentSessionEvents(session.id, { limit: 200, order: "desc" })
    .catch(() => []);
  const skipNoted =
    dedupeKey !== undefined &&
    seen.some(
      (e) =>
        (DELIVERED_TYPES.has(e.type) || e.type === "prompt.followup_skipped") &&
        typeof e.payload === "string" &&
        e.payload.includes(dedupeKey)
    );
  // One audit record per unit of work — without the dedupeKey guard a dead
  // lane would log a skip on every sweep tick.
  const skip = async (why: string): Promise<void> => {
    if (skipNoted) return;
    await stub
      .addAgentSessionEvent({
        sessionId: session.id,
        type: "prompt.followup_skipped",
        message: `${opts.reason} follow-up skipped: ${why}`,
        payload: {
          ...(issue ? { issueId: issue.id } : {}),
          prUrl,
          ...(dedupeKey ? { key: dedupeKey } : {}),
        },
      })
      .catch(() => {});
  };

  // completed is included: reviews/CI land after the lane finishes, and
  // kept-sandbox providers (devin-cli) resume on the follow-up — that
  // resume is the whole review→lane loop. Anything deader is a skip record
  // pointing at /retry; providers without sendPrompt bail below.
  // PILE-452 — a done/canceled issue takes no nudges at all: the sweep was
  // cold-starting lanes on settled work every pass.
  const issueSettled = issue?.status === "done" || issue?.status === "canceled";
  if (
    !issue ||
    issueSettled ||
    (session.status !== "running" &&
      session.status !== "waiting" &&
      session.status !== "completed")
  ) {
    await skip(
      issueSettled
        ? `issue is ${issue.status} — no follow-up to deliver`
        : `lane is ${session.status} — retry the session for a cold dispatch`
    );
    return;
  }
  try {
    const providerConfig = await loadProviderConfig(env, stub, session.agentId);
    const provider = getAgentProvider(
      session.agentId,
      resolveAgentEnv(env, providerConfig ?? undefined)
    );
    if (!provider.sendPrompt) {
      await skip(
        `provider ${session.agentId} has no follow-up channel — retry the session for a cold dispatch`
      );
      return;
    }
    // Dedupe on DELIVERY, not detection: detection events (pr.ci_failed,
    // pr.review) fire once, but a nudge rejected while the sandbox is busy
    // must be retried on later sweeps or the lane never hears about it.
    if (dedupeKey) {
      const alreadyDelivered = seen.some(
        (e) =>
          DELIVERED_TYPES.has(e.type) &&
          typeof e.payload === "string" &&
          e.payload.includes(dedupeKey)
      );
      if (alreadyDelivered) return;
    }
    const history = await laneNudgeHistory(stub, session, seen);
    if (history.escalated) return;
    const exhausted = nudgeBudgetExhausted(history.rounds, opts.headSha);
    if (exhausted) {
      await escalateLane(
        stub,
        session,
        issue,
        prUrl,
        opts,
        exhausted,
        history.rounds
      );
      return;
    }
    const windowMs = followupThrottleWindowMs(providerConfig?.config);
    if (await laneFollowupThrottled(stub, session.id, windowMs)) {
      await stub
        .addAgentSessionEvent({
          sessionId: session.id,
          type: "prompt.followup_skipped",
          message: `${opts.reason} follow-up throttled (recent nudge within window)`,
          payload: {
            issueId: issue.id,
            prUrl,
            ...(dedupeKey ? { key: dedupeKey } : {}),
          },
        })
        .catch(() => {});
      return;
    }
    // Resolved only once delivery is actually attempted — lazy prompts
    // (review range diffs) cost a GitHub call per build.
    const resolved = {
      ...opts,
      prompt:
        typeof opts.prompt === "string" ? opts.prompt : await opts.prompt(),
    };
    // A reaped kept sandbox can't take a follow-up — go straight to the
    // cold dispatch instead of probing a sandbox we know is gone.
    if (session.status === "completed" && session.lastStateHash === "reaped") {
      await redispatchCompletedLane(
        env,
        stub,
        organizationId,
        session,
        issue,
        prUrl,
        resolved,
        "kept sandbox reaped",
        skipNoted,
        history.redispatches
      );
      return;
    }
    const gitIdentity = issue.repo
      ? ((await stub.getGitIdentityByRepo(issue.repo)) ?? null)
      : null;
    const delivered = await provider.sendPrompt(
      session.providerSessionId ?? session.id,
      resolved.prompt,
      issue,
      gitIdentity,
      {
        organizationId,
        backupRef: session.sandboxBackupRef ?? null,
      }
    );
    await stub
      .addAgentSessionEvent({
        sessionId: session.id,
        type: delivered ? "prompt.followup" : "prompt.followup_failed",
        message: delivered
          ? `${opts.reason} delivered as follow-up prompt`
          : `${opts.reason} follow-up prompt rejected by provider`,
        payload: {
          issueId: issue.id,
          prUrl,
          ...(opts.headSha ? { headSha: opts.headSha } : {}),
          ...(opts.dedupeKey ? { key: opts.dedupeKey } : {}),
        },
      })
      .catch(() => {});
    // Resume bookkeeping mirrors the /prompt endpoint: a delivered follow-up
    // on a completed lane flips it back to running so the poll loop picks up
    // the follow-up run's result (and re-records endedAt when it re-ends).
    if (delivered && session.status === "completed") {
      await stub
        .applyAgentSessionResult(session.id, {
          status: "running",
          result: null,
        })
        .catch(() => {});
    }
    // A completed lane's sandbox is idle, so a rejection means it's gone
    // (reaped/expired), not busy — retrying sendPrompt on later sweeps would
    // dead-end forever. Cold-dispatch a fresh lane with the nudge instead.
    if (!delivered && session.status === "completed") {
      await redispatchCompletedLane(
        env,
        stub,
        organizationId,
        session,
        issue,
        prUrl,
        resolved,
        "kept sandbox unavailable",
        skipNoted,
        history.redispatches
      );
    }
  } catch (err) {
    console.error("lane nudge failed", {
      sessionId: session.id,
      reason: opts.reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function redispatchCompletedLane(
  env: WorkerEnv,
  stub: DurableObjectStub<WorkspaceDO>,
  organizationId: string,
  session: AgentSession,
  issue: Issue,
  prUrl: string,
  opts: NudgeOptions & { prompt: string },
  cause: string,
  skipNoted: boolean,
  redispatches: LaneRedispatchStats
): Promise<void> {
  const payload = {
    issueId: issue.id,
    prUrl,
    ...(opts.headSha ? { headSha: opts.headSha } : {}),
    ...(opts.dedupeKey ? { key: opts.dedupeKey } : {}),
  };
  // One skip record per detection key — matches the nudgeLane dedupe: the
  // gate re-evaluates every pass, but the event log stays quiet.
  const noteSkip = async (why: string): Promise<void> => {
    if (skipNoted) return;
    await stub
      .addAgentSessionEvent({
        sessionId: session.id,
        type: "prompt.followup_skipped",
        message: `${opts.reason} redispatch skipped (${cause}): ${why}`,
        payload,
      })
      .catch(() => {});
  };

  // PILE-452 — a paused agent type takes no system-initiated sessions: a
  // parked `waiting` row would still leak a lane the operator froze
  // (session f1ba0869 was created mid-pause this way). The dispatch below
  // also passes onPaused:"fail" so a pause landing in the gap — or one
  // created by the inline spend-cap check — can't park either.
  const pause = await stub.getAgentPause(session.agentId).catch(() => null);
  if (pause) {
    await noteSkip(
      `agent type "${session.agentId}" is paused${pause.reason ? `: ${pause.reason}` : ""}`
    );
    return;
  }

  // The redispatch spends one of the lane's two automatic attempts — count
  // is chain-wide (prompt.redispatch events, failures included), backoff is
  // exponential off the newest attempt.
  if (redispatches.count >= MAX_LANE_REDISPATCHES) {
    await noteSkip(
      `${redispatches.count} automatic redispatches used (cap ${MAX_LANE_REDISPATCHES})`
    );
    return;
  }
  const backoffMs = redispatchBackoffMs(redispatches.count);
  if (
    redispatches.lastAt !== null &&
    Date.now() - redispatches.lastAt < backoffMs
  ) {
    // Inside the backoff window — no record, the next pass re-evaluates.
    return;
  }

  // Fleet breakers — a cold redispatch is system-initiated even though the
  // session row carries the lane owner's actor: when the substrate is red,
  // stand down instead of re-failing a spawn every sweep pass.
  if (
    (await fleetInfraStreak(stub).catch(() => 0)) >= FLEET_UNHEALTHY_STREAK ||
    (await providerInfraStreak(stub, session.agentId).catch(() => 0)) >=
      PROVIDER_UNHEALTHY_STREAK
  ) {
    await noteSkip("fleet unhealthy — consecutive infra-failure lanes");
    return;
  }

  try {
    const providerConfig = await loadProviderConfig(env, stub, session.agentId);
    // PILE-321 — a cold redispatch is a fresh dispatch: a repo-less issue
    // inherits the team's defaultRepo, same as the retry endpoint.
    const target = await inheritTeamDefaultRepo(
      createD1(env.D1),
      stub,
      organizationId,
      issue,
      session.actorId
    );
    const dispatched = await dispatchAgent(
      resolveAgentEnv(env, providerConfig ?? undefined),
      session.agentId,
      organizationId,
      target,
      {
        id: session.actorId,
        organizationId,
        type: session.actorType,
        permissions: [],
      },
      undefined,
      undefined,
      // PILE-423 — a cold redispatch keeps the dead lane's step scope so
      // the same step-scoped guidance resolves on the retry.
      {
        instructions: opts.prompt,
        stepKey: session.stepKey ?? undefined,
        onPaused: "fail",
      }
    );
    await stub
      .updateAgentSession(dispatched.id, { retryOf: session.id })
      .catch(() => null);
    await stub
      .addAgentSessionEvent({
        sessionId: session.id,
        type: "prompt.redispatch",
        message: `${opts.reason} redispatched as session ${dispatched.id} (${cause})`,
        payload: { ...payload, redispatchedAs: dispatched.id },
      })
      .catch(() => {});
  } catch (err) {
    const failedChildId = failedDispatchSessionId(err);
    if (failedChildId) {
      // The dispatch created a row then died (e.g. Daytona start failure):
      // link the corpse and record the attempt so the cap/backoff see it
      // and the chain stays visible — today only successful redispatches
      // landed here, which is what made the retry loop invisible.
      await stub
        .updateAgentSession(failedChildId, { retryOf: session.id })
        .catch(() => null);
      await stub
        .addAgentSessionEvent({
          sessionId: session.id,
          type: "prompt.redispatch",
          message: `${opts.reason} redispatched as session ${failedChildId} (${cause}) — dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
          payload: {
            ...payload,
            redispatchedAs: failedChildId,
            dispatchFailed: true,
          },
        })
        .catch(() => {});
      return;
    }
    // CONFLICT: another live lane already owns the issue — it sees the PR
    // state itself, so this is a skip, not a failure. AGENT_PAUSED is the
    // same class: the hold landed between our check and dispatchAgent's.
    const isConflict = err instanceof VortexError && err.code === "CONFLICT";
    const isPaused = err instanceof VortexError && err.code === "AGENT_PAUSED";
    if ((isConflict || isPaused) && skipNoted) return;
    await stub
      .addAgentSessionEvent({
        sessionId: session.id,
        type:
          isConflict || isPaused
            ? "prompt.followup_skipped"
            : "prompt.followup_failed",
        message: isConflict
          ? `${opts.reason} redispatch skipped (${cause}): another lane owns the issue`
          : isPaused
            ? `${opts.reason} redispatch skipped (${cause}): ${err.message}`
            : `${opts.reason} redispatch failed (${cause}): ${err instanceof Error ? err.message : String(err)}`,
        payload,
      })
      .catch(() => {});
  }
}
