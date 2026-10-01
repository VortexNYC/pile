import type { WorkerEnv } from "../platform/middleware.js";
import type { AgentSession, Issue } from "../types/workspace.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import { loadProviderConfig } from "./credentials.js";
import { resolveAgentEnv } from "./daytona.js";
import { followupThrottleWindowMs, laneFollowupThrottled } from "./followup.js";
import { getAgentProvider } from "./index.js";

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
        (e.type === "prompt.followup" ||
          e.type === "prompt.followup_skipped") &&
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
          e.type === "prompt.followup" &&
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
  } catch (err) {
    console.error("lane nudge failed", {
      sessionId: session.id,
      reason: opts.reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
