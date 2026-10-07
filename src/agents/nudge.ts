import { createD1 } from "../global/db.js";
import { VortexError } from "../platform/errors.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { AgentSession, Issue } from "../types/workspace.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import { loadProviderConfig } from "./credentials.js";
import { resolveAgentEnv } from "./daytona.js";
import { followupThrottleWindowMs, laneFollowupThrottled } from "./followup.js";
import {
  dispatchAgent,
  getAgentProvider,
  inheritTeamDefaultRepo,
} from "./index.js";

const DELIVERED_TYPES = new Set(["prompt.followup", "prompt.redispatch"]);

// PILE-270 — retry budget. Every automated remediation path funnels through
// nudgeLane, so this is the safety valve: past either cap the lane stops
// burning provider spend and the issue goes to a human.
export const MAX_NUDGES_PER_HEAD_SHA = 3;
export const MAX_NUDGES_PER_LANE = 5;
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

/** Delivered PR nudges across the lane's redispatch chain, plus whether the
 *  chain was already escalated. Human follow-ups (`/prompt`, issue comments)
 *  carry no prUrl and don't spend the budget. */
async function laneNudgeHistory(
  stub: DurableObjectStub<WorkspaceDO>,
  session: AgentSession,
  sessionEvents: SessionEvent[]
): Promise<{ rounds: NudgeRound[]; escalated: boolean }> {
  const rounds: NudgeRound[] = [];
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
  return { rounds, escalated };
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
  if (
    !issue ||
    (session.status !== "running" &&
      session.status !== "waiting" &&
      session.status !== "completed")
  ) {
    await skip(
      `lane is ${session.status} — retry the session for a cold dispatch`
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
        skipNoted
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
        skipNoted
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
  skipNoted: boolean
): Promise<void> {
  const payload = {
    issueId: issue.id,
    prUrl,
    ...(opts.headSha ? { headSha: opts.headSha } : {}),
    ...(opts.dedupeKey ? { key: opts.dedupeKey } : {}),
  };
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
      { instructions: opts.prompt }
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
    // CONFLICT: another live lane already owns the issue — it sees the PR
    // state itself, so this is a skip, not a failure.
    const isConflict = err instanceof VortexError && err.code === "CONFLICT";
    if (isConflict && skipNoted) return;
    await stub
      .addAgentSessionEvent({
        sessionId: session.id,
        type: isConflict ? "prompt.followup_skipped" : "prompt.followup_failed",
        message: isConflict
          ? `${opts.reason} redispatch skipped (${cause}): another lane owns the issue`
          : `${opts.reason} redispatch failed (${cause}): ${err instanceof Error ? err.message : String(err)}`,
        payload,
      })
      .catch(() => {});
  }
}
