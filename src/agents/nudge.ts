import { VortexError } from "../platform/errors.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { AgentSession, Issue } from "../types/workspace.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import { loadProviderConfig } from "./credentials.js";
import { resolveAgentEnv } from "./daytona.js";
import { followupThrottleWindowMs, laneFollowupThrottled } from "./followup.js";
import { dispatchAgent, getAgentProvider } from "./index.js";

const DELIVERED_TYPES = new Set(["prompt.followup", "prompt.redispatch"]);

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
  opts: { prompt: string; reason: string; dedupeKey?: string }
): Promise<void> {
  const dedupeKey = opts.dedupeKey;
  const seen = dedupeKey
    ? await stub
        .listAgentSessionEvents(session.id, { limit: 100, order: "desc" })
        .catch(() => [])
    : [];
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
        opts,
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
      opts.prompt,
      issue,
      gitIdentity
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
        opts,
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
  opts: { prompt: string; reason: string; dedupeKey?: string },
  cause: string,
  skipNoted: boolean
): Promise<void> {
  const payload = {
    issueId: issue.id,
    prUrl,
    ...(opts.dedupeKey ? { key: opts.dedupeKey } : {}),
  };
  try {
    const providerConfig = await loadProviderConfig(env, stub, session.agentId);
    const dispatched = await dispatchAgent(
      resolveAgentEnv(env, providerConfig ?? undefined),
      session.agentId,
      organizationId,
      issue,
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
