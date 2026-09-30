import { createD1 } from "../global/db.js";
import { getInstallationTokenForRepo } from "../global/github-auth.js";
import { scrubCaptureText } from "../global/redact.js";
import { organization } from "../global/schema.js";
import { processIncomingMessage } from "../global/support-channels.js";
import { replyLaneResultToTicket } from "../global/support-escalation.js";
import { VortexError } from "../platform/errors.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type {
  AgentSession,
  AgentSessionStatus,
  Issue,
} from "../types/workspace.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import { loadProviderConfig } from "./credentials.js";
import { resolveAgentEnv } from "./daytona.js";
import { followupThrottleWindowMs, laneFollowupThrottled } from "./followup.js";
import { dispatchAgent, getAgentProvider } from "./index.js";
import { getLaneDbProvider, type LaneDbRef } from "./lane-db.js";
import type {
  AgentProvider,
  AgentProviderSession,
  AgentProviderState,
} from "./provider.js";

export const DEFAULT_TIMEOUT_MINUTES = 60;
export const DEFAULT_INACTIVITY_MINUTES = 20;
export const DEFAULT_PROVISION_TIMEOUT_MINUTES = 10;
// A provider call that hangs must never stall the whole org's sweep — the
// loop is serial, so one wedged sandbox otherwise starves every session.
const DEFAULT_PROBE_TIMEOUT_MS = 90_000;
// Follow-up prompts (PILE-210) can land while a terminal session's sandbox is
// parked. Past this window the sweep destroys the sandbox and cold dispatch
// takes over.
const SANDBOX_RESUME_WINDOW_MS = 4 * 60 * 60 * 1000;
// The reaper only scans terminal sessions inside a bounded window — anything
// older was reaped already or died of natural causes.
const SANDBOX_REAP_MAX_AGE_MS = 48 * 60 * 60 * 1000;
// PILE-239 — kept sandboxes are bounded fleet capacity, not a nicety: a
// reaper bug once let them pile to max_instances and wedge every new lane.
// Past this count per provider, the oldest in-window sessions are reaped
// regardless of their remaining resume window.
const KEPT_SANDBOX_CAP_PER_PROVIDER = 5;
const TERMINAL_STATUSES = new Set<AgentSessionStatus>([
  "completed",
  "failed",
  "canceled",
]);

export function parseAgentTimeouts(configJson: string | null | undefined): {
  timeoutMinutes: number;
  inactivityMinutes: number;
  provisionTimeoutMinutes: number;
} {
  let timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
  let inactivityMinutes = DEFAULT_INACTIVITY_MINUTES;
  let provisionTimeoutMinutes = DEFAULT_PROVISION_TIMEOUT_MINUTES;
  if (!configJson)
    return { timeoutMinutes, inactivityMinutes, provisionTimeoutMinutes };
  try {
    const parsed: unknown = JSON.parse(configJson);
    if (typeof parsed !== "object" || parsed === null) {
      return { timeoutMinutes, inactivityMinutes, provisionTimeoutMinutes };
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.timeout === "number" && Number.isFinite(record.timeout)) {
      timeoutMinutes = record.timeout;
    }
    if (
      typeof record.inactivityTimeout === "number" &&
      Number.isFinite(record.inactivityTimeout)
    ) {
      inactivityMinutes = record.inactivityTimeout;
    }
    if (
      typeof record.provisionTimeout === "number" &&
      Number.isFinite(record.provisionTimeout)
    ) {
      provisionTimeoutMinutes = record.provisionTimeout;
    }
  } catch {
    /* invalid JSON — keep defaults */
  }
  return { timeoutMinutes, inactivityMinutes, provisionTimeoutMinutes };
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} probe timed out after ${ms}ms`)),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function progressIsStale(input: {
  now: number;
  createdAt: string;
  lastProgressAt: string | null | undefined;
  inactivityMinutes: number;
}): boolean {
  const last = Date.parse(input.lastProgressAt ?? input.createdAt);
  if (!Number.isFinite(last)) return false;
  return input.now - last >= input.inactivityMinutes * 60 * 1000;
}

export function hashAgentState(state: unknown): string {
  return JSON.stringify(state);
}

function computeLastSeen(state: AgentProviderState | null): number | null {
  if (!state?.compute || typeof state.compute !== "object") return null;
  const lastSeen = (state.compute as Record<string, unknown>).lastSeen;
  if (typeof lastSeen !== "string") return null;
  const parsed = Date.parse(lastSeen);
  return Number.isFinite(parsed) ? parsed : null;
}

async function cancelSession(
  stub: DurableObjectStub<WorkspaceDO>,
  session: AgentSession,
  provider: AgentProvider | null,
  result: string,
  probeTimeoutMs: number
): Promise<void> {
  const remoteId = session.providerSessionId ?? session.id;
  try {
    if (provider?.cancel)
      await withTimeout(provider.cancel(remoteId), probeTimeoutMs, "cancel");
  } catch (err) {
    console.error("agent session cancel failed", {
      session: session.id,
      agentId: session.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  await stub.applyAgentSessionResult(
    session.id,
    {
      status: "canceled",
      result,
      url: session.url ?? null,
      prUrl: session.prUrl ?? null,
      prState: session.prState ?? null,
    },
    undefined
  );
}

// Provider-reported task failures land in the workspace support inbox as a
// ticket keyed on the session id — dedup'd by externalTicketId, scrubbed of
// credentials, and deliberately NOT auto-escalated to an issue.
export async function ingestFailedAgentSession(
  env: WorkerEnv,
  organizationId: string,
  session: AgentSession,
  polled: AgentProviderSession
): Promise<void> {
  try {
    const db = createD1(env.D1);
    const detail = scrubCaptureText(
      [
        `Session: ${session.id}`,
        `Agent: ${session.agentId}`,
        `Provider: ${session.provider}`,
        polled.providerSessionId
          ? `Provider session: ${polled.providerSessionId}`
          : null,
        session.issueId ? `Issue: ${session.issueId}` : null,
        polled.url ? `Provider URL: ${polled.url}` : null,
        polled.infraFailure ? `Infra failure: yes` : null,
        "",
        polled.result ?? "Provider reported failure with no details.",
      ]
        .filter((line): line is string => line !== null)
        .join("\n")
    );
    await processIncomingMessage(db, organizationId, {
      channel: "api",
      externalSource: "api",
      fromEmail: "agent-sessions@pile.internal",
      fromName: "Pile Agents",
      subject: `Agent session failed: ${session.agentId} (${session.id.slice(0, 8)})`,
      text: detail,
      externalTicketId: `agent-session-${session.id}`,
      externalMessageId: `agent-session-${session.id}-failed`,
      subType: "agent-failure",
    });
  } catch (err) {
    console.error("failed-session ingest failed", {
      session: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const MAX_INFRA_RETRIES = 1;
// PILE-240 — consecutive infra failures across a provider's lanes mean the
// provider/substrate is unhealthy (devin's fleet repeatedly wedged with
// "runner never started"). Past the streak, retries stop churning lanes
// and the issue gets told plainly instead.
const PROVIDER_UNHEALTHY_STREAK = 3;

async function providerInfraStreak(
  stub: DurableObjectStub<WorkspaceDO>,
  agentId: string
): Promise<number> {
  const recent = await stub.listAgentSessions({ limit: 20 });
  let streak = 0;
  for (const s of recent) {
    if (s.agentId !== agentId) continue;
    if (s.status === "failed" && s.infraFailure === 1) streak += 1;
    else break;
  }
  return streak;
}

// Redispatch once when the compute substrate failed underneath the agent —
// sandbox error, runner dying without a result — not when the agent itself
// reported a task failure (infraFailure stays unset for those).
async function retryInfraSession(
  env: WorkerEnv,
  stub: DurableObjectStub<WorkspaceDO>,
  organizationId: string,
  session: AgentSession,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<void> {
  if ((session.retryCount ?? 0) >= MAX_INFRA_RETRIES) return;
  const streak = await providerInfraStreak(stub, session.agentId);
  if (streak >= PROVIDER_UNHEALTHY_STREAK) {
    await stub.addAgentActivity({
      sessionId: session.id,
      actorId: session.actorId,
      type: "error",
      message: `${session.agentId} unhealthy — ${streak} consecutive infra failures, redispatch paused`,
    });
    return;
  }
  try {
    const issue = await stub.getIssue(session.issueId);
    if (!issue) return;
    const providerConfig = await loadProviderConfig(env, stub, session.agentId);
    const effectiveEnv = resolveAgentEnv(env, providerConfig ?? undefined);
    const retried = await dispatchAgent(
      effectiveEnv,
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
      ctx
    );
    await stub.updateAgentSession(retried.id, {
      retryOf: session.id,
      retryCount: (session.retryCount ?? 0) + 1,
    });
    await stub.addAgentActivity({
      sessionId: session.id,
      actorId: session.actorId,
      type: "thought",
      message: `Infrastructure failure — redispatched as session ${retried.id}`,
    });
  } catch (err) {
    // CONFLICT means a live session already owns the issue — the retry is
    // redundant, not an error worth alarming on.
    const isConflict = err instanceof VortexError && err.code === "CONFLICT";
    const log = isConflict ? console.log : console.error;
    log("agent session infra retry skipped/failed", {
      session: session.id,
      agentId: session.agentId,
      conflict: isConflict,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// PILE-214/211/212/210 — sweep-time maintenance
// ---------------------------------------------------------------------------

/** A `waiting` session parked behind a blocker lane (queuedAfter) gets
 *  promoted to a real dispatch once the blocker goes terminal or vanishes. */
async function promoteQueuedSessions(
  env: WorkerEnv,
  stub: DurableObjectStub<WorkspaceDO>,
  organizationId: string,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<void> {
  const queued = await stub.listQueuedAgentSessions();
  for (const session of queued) {
    if (!session.queuedAfter) {
      await stub
        .updateAgentSession(session.id, { status: "created" })
        .catch(() => null);
      continue;
    }
    const blocker = await stub
      .getAgentSession(session.queuedAfter)
      .catch(() => null);
    if (blocker && !TERMINAL_STATUSES.has(blocker.status)) continue;
    try {
      const issue = await stub.getIssue(session.issueId);
      if (!issue) continue;
      const providerConfig = await loadProviderConfig(
        env,
        stub,
        session.agentId
      );
      const effectiveEnv = resolveAgentEnv(env, providerConfig ?? undefined);
      await dispatchAgent(
        effectiveEnv,
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
        ctx,
        { promoteSessionId: session.id }
      );
    } catch (err) {
      console.error("queued session promotion failed", {
        session: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Tear down a lane-scoped DB once the session lands terminal, then clear the
 *  ref so the reaper doesn't re-attempt. */
async function teardownLaneDbForSession(
  env: WorkerEnv,
  stub: DurableObjectStub<WorkspaceDO>,
  session: AgentSession
): Promise<void> {
  if (!session.laneDbRef) return;
  try {
    const ref = JSON.parse(session.laneDbRef) as LaneDbRef;
    const provider = getLaneDbProvider(env);
    if (provider && ref.provider === provider.name) {
      await provider.teardown(ref);
    }
    await stub.updateAgentSession(session.id, { laneDbRef: null });
  } catch (err) {
    console.error("lane-db teardown failed", {
      session: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Orphan reaper: any terminal session still holding a laneDbRef, plus
 *  kept-alive sandboxes past the resume window (pile-210). Bounded window so
 *  the sweep doesn't rescan the whole session table. */
async function reapTerminalArtifacts(
  env: WorkerEnv,
  stub: DurableObjectStub<WorkspaceDO>,
  organizationId: string,
  now: number
): Promise<void> {
  const recent = await stub.listAgentSessions({ limit: 200 });
  // PILE-239 — first pass: terminal sessions inside the resume window are
  // the kept-sandbox population per provider. Beyond the cap the oldest are
  // reaped even though their window hasn't closed.
  const inWindowByProvider = new Map<string, { id: string; at: number }[]>();
  for (const session of recent) {
    if (!TERMINAL_STATUSES.has(session.status)) continue;
    if (session.lastStateHash === "reaped") continue;
    const anchor = Date.parse(session.endedAt ?? session.updatedAt);
    if (!Number.isFinite(anchor)) continue;
    if (now - anchor < SANDBOX_RESUME_WINDOW_MS) {
      const list = inWindowByProvider.get(session.agentId) ?? [];
      list.push({ id: session.id, at: anchor });
      inWindowByProvider.set(session.agentId, list);
    }
  }
  const forceReap = new Set<string>();
  for (const list of inWindowByProvider.values()) {
    if (list.length <= KEPT_SANDBOX_CAP_PER_PROVIDER) continue;
    list.sort((a, b) => a.at - b.at);
    for (const s of list.slice(0, -KEPT_SANDBOX_CAP_PER_PROVIDER)) {
      forceReap.add(s.id);
    }
  }

  for (const session of recent) {
    if (!TERMINAL_STATUSES.has(session.status)) continue;
    if (session.lastStateHash === "reaped") continue;
    // PILE-238 — endedAt is the reaper anchor; a write path that skips it
    // (like the applyAgentSessionResult bypass did) silently leaks kept
    // sandboxes. Self-heal stale rows and log so regressions surface.
    if (!session.endedAt) {
      console.error("terminal session missing endedAt", {
        session: session.id,
        organizationId,
        status: session.status,
      });
      await stub.updateAgentSession(session.id, {
        endedAt: session.updatedAt,
      });
      continue;
    }
    await teardownLaneDbForSession(env, stub, session);
    // Anchor to the terminal transition — updatedAt churns on every write
    // (prState, laneDb teardown, this reaper's marker) and would otherwise
    // keep the sandbox inside the resume window forever.
    const updated = Date.parse(session.endedAt);
    if (
      !Number.isFinite(updated) ||
      (now - updated < SANDBOX_RESUME_WINDOW_MS &&
        !forceReap.has(session.id)) ||
      now - updated > SANDBOX_REAP_MAX_AGE_MS
    ) {
      continue;
    }
    try {
      const providerConfig = await loadProviderConfig(
        env,
        stub,
        session.agentId
      );
      const provider = getAgentProvider(
        session.agentId,
        resolveAgentEnv(env, providerConfig ?? undefined)
      );
      if (provider.cancel) {
        await provider.cancel(session.providerSessionId ?? session.id);
      }
      // Push updatedAt past the reap window so this session isn't retried
      // every sweep.
      await stub.updateAgentSession(session.id, { lastStateHash: "reaped" });
    } catch (err) {
      console.error("terminal sandbox reap failed", {
        session: session.id,
        organizationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function cronFieldMatches(field: string, value: number): boolean {
  for (const part of field.split(",")) {
    if (part === "*") return true;
    const stepMatch = /^(.+)\/(\d+)$/.exec(part);
    const base = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) continue;
    let start: number;
    let end: number;
    if (base === "*") {
      start = 0;
      end = Number.MAX_SAFE_INTEGER;
    } else {
      const range = /^(\d+)-(\d+)$/.exec(base);
      if (range) {
        start = Number(range[1]);
        end = Number(range[2]);
      } else if (/^\d+$/.test(base)) {
        // A bare number with a step ("5/10") means N-max/step; without a
        // step it's an exact match.
        start = Number(base);
        end = stepMatch ? Number.MAX_SAFE_INTEGER : start;
      } else {
        continue;
      }
    }
    if (value >= start && value <= end && (value - start) % step === 0) {
      return true;
    }
  }
  return false;
}

/** Minimal 5-field cron matcher: `m h dom mon dow`. Enough for automation
 *  schedules — no names/aliases, matches against the current UTC minute. */
export function cronMatchesNow(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [min, hour, dom, mon, dow] = fields;
  return (
    cronFieldMatches(min, date.getUTCMinutes()) &&
    cronFieldMatches(hour, date.getUTCHours()) &&
    cronFieldMatches(dom, date.getUTCDate()) &&
    cronFieldMatches(mon, date.getUTCMonth() + 1) &&
    cronFieldMatches(dow, date.getUTCDay())
  );
}

/** Fire enabled automations whose cron expression matches this minute —
 *  deduped by lastFiredAt so a matching minute fires at most once. Event
 *  automations fire from syncOpenPrSessions instead. */
async function fireDueAutomations(
  env: WorkerEnv,
  stub: DurableObjectStub<WorkspaceDO>,
  organizationId: string,
  now: Date,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<void> {
  const automations = await stub.listAgentAutomations({
    enabledOnly: true,
    triggerKind: "cron",
  });
  const minuteStart = Math.floor(now.getTime() / 60_000) * 60_000;
  for (const automation of automations) {
    if (!cronMatchesNow(automation.triggerValue, now)) continue;
    const last = automation.lastFiredAt
      ? Date.parse(automation.lastFiredAt)
      : 0;
    if (Number.isFinite(last) && last >= minuteStart) continue;
    await stub.markAgentAutomationFired(automation.id).catch(() => {});
    await fireAutomation(env, stub, organizationId, automation, ctx);
  }
}

/** Shared by cron and event triggers: dispatch a lane for the automation's
 *  issue (or a fresh issue when none is bound). */
async function fireAutomation(
  env: WorkerEnv,
  stub: DurableObjectStub<WorkspaceDO>,
  organizationId: string,
  automation: {
    id: string;
    agentId: string;
    prompt: string;
    issueId: string | null;
    teamId: string | null;
    createdBy: string | null;
    name: string;
  },
  ctx?: { waitUntil: (promise: Promise<unknown>) => void },
  context?: string
): Promise<void> {
  try {
    const issue = automation.issueId
      ? await stub.getIssue(automation.issueId)
      : null;
    const targetIssue =
      issue ??
      (await stub.createIssue(
        {
          title: `Automation: ${automation.name}`,
          description: automation.prompt,
          teamId: automation.teamId ?? undefined,
          status: "backlog",
        },
        automation.createdBy ?? undefined
      ));
    const providerConfig = await loadProviderConfig(
      env,
      stub,
      automation.agentId
    );
    const effectiveEnv = resolveAgentEnv(env, providerConfig ?? undefined);
    await dispatchAgent(
      effectiveEnv,
      automation.agentId,
      organizationId,
      targetIssue,
      {
        id: automation.createdBy ?? "automation",
        organizationId,
        type: "agent",
        permissions: [],
      },
      undefined,
      ctx,
      { instructions: context ?? automation.prompt }
    );
  } catch (err) {
    console.error("automation dispatch failed", {
      automation: automation.id,
      organizationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Event automations (PILE-211): trigger_value is the event name —
 *  pr.ci_failed, issue.assigned, issue.commented. */
async function fireEventAutomations(
  env: WorkerEnv,
  stub: DurableObjectStub<WorkspaceDO>,
  organizationId: string,
  eventName: string,
  session: AgentSession,
  context?: string,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<void> {
  const automations = await stub.listAgentAutomations({
    enabledOnly: true,
    triggerKind: "event",
  });
  for (const automation of automations) {
    if (automation.triggerValue !== eventName) continue;
    // concurrency_key = issueId — the one-active-session-per-issue guard in
    // dispatchAgent already prevents a second lane on the same issue.
    await fireAutomation(
      env,
      stub,
      organizationId,
      automation.issueId
        ? automation
        : { ...automation, issueId: session.issueId },
      ctx,
      context
    );
  }
}

export async function sweepAgentSessions(
  env: WorkerEnv,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void },
  options?: { probeTimeoutMs?: number }
): Promise<void> {
  const probeTimeoutMs = options?.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const d1 = createD1(env.D1);
  const orgs = await d1
    .select({ id: organization.id })
    .from(organization)
    .all();
  const now = Date.now();
  for (const { id } of orgs) {
    try {
      const stub = env.WORKSPACE_DURABLE_OBJECT.get(
        env.WORKSPACE_DURABLE_OBJECT.idFromName(id)
      );
      await stub.setOrganizationId(id);
      const sessions = [
        ...(await stub.listAgentSessions({ status: "running" })),
        ...(await stub.listAgentSessions({ status: "created" })),
      ];
      // Terminal sessions stop being polled, but their PRs keep moving —
      // reconcile session.prState and the issue's PR fields from GitHub so a
      // merged PR doesn't sit displayed as "open" forever.
      await syncOpenPrSessions(env, stub, id, { probeTimeoutMs });
      await promoteQueuedSessions(env, stub, id, ctx);
      await fireDueAutomations(env, stub, id, new Date(now), ctx);
      await reapTerminalArtifacts(env, stub, id, now);
      if (sessions.length === 0) continue;
      // Sessions are swept in parallel with a bounded fan-out — one session
      // whose provider probes all stall can burn ~3x probeTimeoutMs serially,
      // which would let a single wedged lane starve the whole pass.
      const SWEEP_FANOUT = 5;
      const sweepSession = async (session: (typeof sessions)[number]) => {
        const providerConfig = await loadProviderConfig(
          env,
          stub,
          session.agentId
        );
        const effectiveEnv = resolveAgentEnv(env, providerConfig ?? undefined);
        const { timeoutMinutes, inactivityMinutes, provisionTimeoutMinutes } =
          parseAgentTimeouts(providerConfig?.config);
        // Externally-registered sessions (PILE-227) have no dispatchable
        // provider — timeouts still apply, poll/cancel degrade to no-ops.
        let provider: AgentProvider | null = null;
        try {
          provider = getAgentProvider(session.agentId, effectiveEnv);
        } catch {
          provider = null;
        }
        const created = Date.parse(session.createdAt);
        // `created` sessions never started a runner — the sandbox wedged or
        // the queue is saturated. Bound provisioning separately from the run
        // clock so queue time doesn't burn the lane's runtime budget, and
        // fail it as infra so the retry path re-drives it.
        if (
          session.status === "created" &&
          Number.isFinite(created) &&
          now - created >= provisionTimeoutMinutes * 60 * 1000
        ) {
          // Process records take a few minutes to register after
          // `startProcess` resolves — a `created` status alone doesn't prove
          // provisioning failed. The "runner started" activity is written only
          // after the RPC returns, so if it's present the lane is alive and
          // the next poll will flip it to `running`.
          const events = await stub
            .listAgentSessionEvents(session.id, { limit: 100 })
            .catch(() => []);
          const runnerStarted = events.some((event) =>
            String(event.message ?? "").includes("runner started")
          );
          if (
            runnerStarted &&
            now - created < provisionTimeoutMinutes * 2 * 60 * 1000
          ) {
            return;
          }
          const provisionFailure: AgentProviderSession = {
            id: session.id,
            agentId: session.agentId,
            status: "failed",
            result: `provision timed out after ${provisionTimeoutMinutes}m (runner never started)`,
            infraFailure: true,
          };
          await stub.applyAgentSessionResult(session.id, provisionFailure);
          await ingestFailedAgentSession(env, id, session, provisionFailure);
          if (provider) await retryInfraSession(env, stub, id, session, ctx);
          return;
        }
        // The run clock starts at the first `running` transition (startedAt),
        // not at dispatch — a queued lane doesn't eat its own budget.
        const runStart = Date.parse(session.startedAt ?? session.createdAt);
        if (
          session.status !== "created" &&
          Number.isFinite(runStart) &&
          now - runStart >= timeoutMinutes * 60 * 1000
        ) {
          await cancelSession(
            stub,
            session,
            provider,
            `session timed out after ${timeoutMinutes}m`,
            probeTimeoutMs
          );
          return;
        }

        if (!provider) {
          // External session: no remote to poll. If it has stopped reporting
          // past the inactivity window, mark it canceled rather than zombie.
          if (
            progressIsStale({
              now,
              createdAt: session.createdAt,
              lastProgressAt: session.lastProgressAt,
              inactivityMinutes,
            })
          ) {
            await cancelSession(
              stub,
              session,
              null,
              `external session silent for ${inactivityMinutes}m`,
              probeTimeoutMs
            );
          }
          return;
        }
        const remoteId = session.providerSessionId ?? session.id;
        let stillAlive = false;
        try {
          const polled = await withTimeout(
            provider.poll(remoteId),
            probeTimeoutMs,
            "poll"
          );
          if (
            polled.status === "completed" ||
            polled.status === "failed" ||
            polled.status === "canceled"
          ) {
            await stub.applyAgentSessionResult(session.id, polled);
            await teardownLaneDbForSession(env, stub, session);
            // PILE-223 — escalated tickets get the lane's result posted
            // back to the customer thread.
            if (polled.status === "completed" || polled.status === "failed") {
              await replyLaneResultToTicket(
                env,
                d1,
                id,
                session.issueId,
                session.id,
                polled.result
              );
            }
            if (polled.status === "failed") {
              await ingestFailedAgentSession(env, id, session, polled);
              if (polled.infraFailure) {
                await retryInfraSession(env, stub, id, session, ctx);
              }
            }
            return;
          }
          if (
            polled.status !== session.status ||
            polled.result !== session.result ||
            polled.url !== session.url ||
            polled.prUrl !== session.prUrl
          ) {
            stillAlive = true;
            await stub.applyAgentSessionResult(session.id, polled);
          }

          // PILE-229: a provider that parks the lane "blocked"/waiting is the
          // lane asking a human — surface it as an elicitation so the
          // needs_input event + notification fire. Deduped by the status
          // transition itself (only fires on entry into waiting). Queued lanes
          // parked behind a blocker (queuedAfter) are not elicitations.
          if (
            polled.status === "waiting" &&
            session.status !== "waiting" &&
            !session.queuedAfter
          ) {
            // VTX-209: carry the actual question when the provider exposes a
            // message API — a bare "waiting_for_user" forces humans to open
            // the provider's dashboard, which is the thing Pile replaces.
            const question = provider.latestElicitation
              ? await provider.latestElicitation(remoteId).catch(() => null)
              : null;
            await stub
              .addAgentActivity({
                sessionId: session.id,
                type: "elicitation",
                message:
                  question ??
                  polled.result ??
                  "Lane is blocked and waiting for input",
              })
              .catch(() => null);
          }

          if (polled.status === "running" && session.startedAt === null) {
            await stub.updateAgentSession(session.id, {
              startedAt: new Date(now).toISOString(),
            });
          }

          if (
            !progressIsStale({
              now,
              createdAt: session.createdAt,
              lastProgressAt: session.lastProgressAt,
              inactivityMinutes,
            })
          ) {
            return;
          }

          if (provider.getState) {
            const state = await withTimeout(
              provider.getState(remoteId, session.id),
              probeTimeoutMs,
              "getState"
            );
            const lastSeen = computeLastSeen(state);
            if (
              lastSeen !== null &&
              now - lastSeen < inactivityMinutes * 60 * 1000
            ) {
              stillAlive = true;
            }
            const hash = hashAgentState(state);
            if (hash !== session.lastStateHash) {
              stillAlive = true;
              await stub.updateAgentSession(session.id, {
                lastProgressAt: new Date(now).toISOString(),
                lastStateHash: hash,
              });
            }
          }
        } catch (err) {
          console.error("agent inactivity probe failed", {
            session: session.id,
            agentId: session.agentId,
            error: err instanceof Error ? err.message : String(err),
          });
          // A blip is not silence. Max-runtime still bounds the run.
          return;
        }

        if (stillAlive) return;
        await cancelSession(
          stub,
          session,
          provider,
          `session inactive for ${inactivityMinutes}m`,
          probeTimeoutMs
        );
      };
      for (let i = 0; i < sessions.length; i += SWEEP_FANOUT) {
        await Promise.allSettled(
          sessions.slice(i, i + SWEEP_FANOUT).map(sweepSession)
        );
      }
    } catch (err) {
      console.error("agent session sweep failed", {
        organizationId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

const GITHUB_PR_URL_RE =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

async function githubApiGet(
  ghFetch: typeof fetch,
  token: string,
  path: string
): Promise<unknown> {
  const res = await ghFetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pile-agent-sweep",
    },
  });
  if (!res.ok) {
    throw new Error(`github GET ${path} -> ${res.status}`);
  }
  return res.json();
}

export function prStateFromPull(pr: Record<string, unknown>): string {
  if (typeof pr.merged_at === "string") return "merged";
  if (pr.draft === true) return "draft";
  if (pr.state === "closed") return "closed";
  return "open";
}

export function summarizeCheckRuns(
  runs: Array<{ status?: string; conclusion?: string | null }> | undefined
): string | null {
  if (!runs || runs.length === 0) return null;
  if (
    runs.some((r) => r.conclusion === "failure" || r.conclusion === "cancelled")
  )
    return "failing";
  if (
    runs.some(
      (r) =>
        r.status !== "completed" ||
        r.conclusion === "action_required" ||
        r.conclusion === "timed_out"
    )
  )
    return "pending";
  return "passing";
}

interface PrSyncDeps {
  tokenForRepo?: (
    env: WorkerEnv,
    owner: string,
    name: string
  ) => Promise<string | undefined>;
  fetch?: typeof fetch;
  probeTimeoutMs?: number;
}

// Shared lane nudge path (CI failures, merge conflicts): provider sendPrompt
// through the workspace-configured throttle, with an audit event either way.
async function nudgeLane(
  env: WorkerEnv,
  stub: DurableObjectStub<WorkspaceDO>,
  organizationId: string,
  session: AgentSession,
  issue: Issue | undefined,
  prUrl: string,
  opts: { prompt: string; reason: string }
): Promise<void> {
  // completed is included: reviews/CI land after the lane finishes, and
  // kept-sandbox providers (devin-cli) resume on the follow-up — that
  // resume is the whole review→lane loop. Providers without sendPrompt
  // bail below.
  if (
    !issue ||
    (session.status !== "running" &&
      session.status !== "waiting" &&
      session.status !== "completed")
  )
    return;
  try {
    const providerConfig = await loadProviderConfig(env, stub, session.agentId);
    const provider = getAgentProvider(
      session.agentId,
      resolveAgentEnv(env, providerConfig ?? undefined)
    );
    if (!provider.sendPrompt) return;
    const windowMs = followupThrottleWindowMs(providerConfig?.config);
    if (await laneFollowupThrottled(stub, session.id, windowMs)) {
      await stub
        .addAgentSessionEvent({
          sessionId: session.id,
          type: "prompt.followup_skipped",
          message: `${opts.reason} follow-up throttled (recent nudge within window)`,
          payload: { issueId: issue.id, prUrl },
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
        payload: { issueId: issue.id, prUrl },
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

// Reconcile terminal sessions' PR state + the issue's PR fields from GitHub.
// Sessions leave the running/created poll list at terminal, so without this
// their prState freezes at whatever the runner last reported ("open").
export async function syncOpenPrSessions(
  env: WorkerEnv,
  stub: DurableObjectStub<WorkspaceDO>,
  organizationId: string,
  deps: PrSyncDeps = {}
): Promise<void> {
  const tokenForRepo = deps.tokenForRepo ?? getInstallationTokenForRepo;
  const ghFetch = deps.fetch ?? fetch;
  const probeTimeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const sessions = await stub.listAgentSessions({ openPr: true, limit: 50 });
  for (const session of sessions) {
    const prUrl = session.prUrl;
    if (!prUrl) continue;
    const match = GITHUB_PR_URL_RE.exec(prUrl);
    if (!match) continue;
    const [, owner, repo, num] = match;
    try {
      const token = await tokenForRepo(env, owner, repo);
      if (!token) continue;
      const pr = (await withTimeout(
        githubApiGet(ghFetch, token, `/repos/${owner}/${repo}/pulls/${num}`),
        probeTimeoutMs,
        "github-pr"
      )) as Record<string, unknown>;
      const state = prStateFromPull(pr);
      const head = pr.head as Record<string, unknown> | undefined;
      const headSha = typeof head?.sha === "string" ? head.sha : null;

      let checkState: string | null = null;
      let checkRuns: Array<{
        name?: string;
        status?: string;
        conclusion?: string | null;
        details_url?: string;
      }> = [];
      if (headSha) {
        const checks = (await withTimeout(
          githubApiGet(
            ghFetch,
            token,
            `/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`
          ),
          probeTimeoutMs,
          "github-checks"
        )) as { check_runs?: typeof checkRuns };
        checkRuns = checks.check_runs ?? [];
        checkState = summarizeCheckRuns(checkRuns);
      }
      const failingChecks = checkRuns.filter(
        (c) =>
          c.status === "completed" &&
          c.conclusion &&
          c.conclusion !== "success" &&
          c.conclusion !== "skipped" &&
          c.conclusion !== "neutral"
      );

      const issue = await stub.getIssue(session.issueId);

      // SCM-observer events (PILE-209): orchestrators read PR transitions as
      // session events, not just refreshed fields.
      const priorCheckState = issue?.prCheckState ?? null;
      if (state !== session.prState && state !== "open") {
        await stub
          .addAgentSessionEvent({
            sessionId: session.id,
            type: `pr.${state}`,
            message: `PR ${prUrl} is now ${state}`,
            payload: { prUrl, prState: state, headSha },
          })
          .catch(() => {});
      }
      if (checkState === "failing" && priorCheckState !== "failing") {
        await stub
          .addAgentSessionEvent({
            sessionId: session.id,
            type: "pr.ci_failed",
            message: `CI failing on ${prUrl}`,
            payload: {
              prUrl,
              headSha,
              checkState,
              failingChecks: failingChecks.map((c) => c.name ?? "unknown"),
            },
          })
          .catch(() => {});
        const failingList = failingChecks
          .map(
            (c) =>
              `- ${c.name ?? "unknown"}${c.details_url ? ` (${c.details_url})` : ""}`
          )
          .join("\n");
        const ciPrompt =
          `CI is failing on ${prUrl}${headSha ? ` (sha ${headSha})` : ""}.\n` +
          (failingList ? `Failing checks:\n${failingList}\n` : "") +
          "Fetch the failing check runs, fix, and push.";
        await fireEventAutomations(
          env,
          stub,
          organizationId,
          "pr.ci_failed",
          session,
          ciPrompt
        );
        await nudgeLane(env, stub, organizationId, session, issue, prUrl, {
          prompt: ciPrompt,
          reason: "CI failure",
        });
      }
      // PILE-230: merge-conflict awareness. GitHub reports mergeable:false once
      // it has computed mergeability (null = still computing; skip those).
      // Deduped per headSha via the pr.conflict event, same pattern as
      // pr.review_requested below.
      if (state === "open" && pr.mergeable === false && issue) {
        const seen = await stub
          .listAgentSessionEvents(session.id, { limit: 100 })
          .catch(() => []);
        const alreadyNoted = seen.some(
          (e) =>
            e.type === "pr.conflict" &&
            typeof e.payload === "string" &&
            e.payload.includes(headSha ?? "")
        );
        if (!alreadyNoted) {
          await stub
            .addAgentSessionEvent({
              sessionId: session.id,
              type: "pr.conflict",
              message: `PR ${prUrl} has merge conflicts`,
              payload: { prUrl, headSha },
            })
            .catch(() => {});
          await fireEventAutomations(
            env,
            stub,
            organizationId,
            "pr.conflict",
            session,
            `PR ${prUrl} has merge conflicts. Rebase or merge the base branch and resolve.`
          );
          await nudgeLane(env, stub, organizationId, session, issue, prUrl, {
            prompt:
              `PR ${prUrl} has merge conflicts with the base branch.\n` +
              "Rebase (or merge the base branch), resolve the conflicts, and push.",
            reason: "merge conflict",
          });
        }
      }
      // PILE-224 — the review→lane round trip: a submitted GitHub review is
      // agent-facing work, not just a status. Each new review emits one
      // deduped pr.review event; reviews that carry feedback (changes
      // requested or a body) nudge the lane so the agent can act on it.
      if (state === "open") {
        const reviews = (await withTimeout(
          githubApiGet(
            ghFetch,
            token,
            `/repos/${owner}/${repo}/pulls/${num}/reviews?per_page=100`
          ),
          probeTimeoutMs,
          "github-reviews"
        ).catch(() => null)) as Array<{
          id?: number;
          state?: string;
          body?: string;
          user?: { login?: string };
        }> | null;
        if (reviews && reviews.length > 0) {
          const seen = await stub
            .listAgentSessionEvents(session.id, { limit: 100 })
            .catch(() => []);
          for (const review of reviews) {
            if (typeof review.id !== "number") continue;
            const marker = `review-${review.id}`;
            if (
              seen.some(
                (e) =>
                  e.type === "pr.review" &&
                  typeof e.payload === "string" &&
                  e.payload.includes(marker)
              )
            ) {
              continue;
            }
            const reviewState = (review.state ?? "").toUpperCase();
            const reviewer = review.user?.login ?? "reviewer";
            const body = (review.body ?? "").trim();
            await stub
              .addAgentSessionEvent({
                sessionId: session.id,
                type: "pr.review",
                message: `${reviewer} reviewed ${prUrl}: ${reviewState.toLowerCase()}`,
                payload: {
                  prUrl,
                  headSha,
                  reviewId: marker,
                  state: reviewState,
                  reviewer,
                },
              })
              .catch(() => {});
            const actionable =
              reviewState === "CHANGES_REQUESTED" || body.length > 0;
            if (!actionable) continue;
            const reviewPrompt =
              `${reviewer} reviewed ${prUrl} (${reviewState.toLowerCase()}).\n` +
              (body ? `Review:\n${body}\n` : "") +
              "Read the review comments on the PR, address the feedback, and push.";
            await fireEventAutomations(
              env,
              stub,
              organizationId,
              "pr.review",
              session,
              reviewPrompt
            );
            await nudgeLane(env, stub, organizationId, session, issue, prUrl, {
              prompt: reviewPrompt,
              reason: "review feedback",
            });
          }
        }
      }

      const reviewers = pr.requested_reviewers;
      if (
        Array.isArray(reviewers) &&
        reviewers.length > 0 &&
        state === "open"
      ) {
        const seen = await stub
          .listAgentSessionEvents(session.id, { limit: 100 })
          .catch(() => []);
        const alreadyNoted = seen.some(
          (e) =>
            e.type === "pr.review_requested" &&
            typeof e.payload === "string" &&
            e.payload.includes(headSha ?? "")
        );
        if (!alreadyNoted) {
          await stub
            .addAgentSessionEvent({
              sessionId: session.id,
              type: "pr.review_requested",
              message: `Review requested on ${prUrl}`,
              payload: { prUrl, headSha, reviewers: reviewers.length },
            })
            .catch(() => {});
        }
      }

      if (state !== session.prState) {
        await stub.updateAgentSession(session.id, { prState: state });
      }
      if (
        issue &&
        (issue.prState !== state ||
          issue.prUrl !== prUrl ||
          (checkState !== null && issue.prCheckState !== checkState))
      ) {
        await stub.reconcileIssuePr(
          session.issueId,
          prUrl,
          state,
          checkState ?? issue.prCheckState,
          "agent-sweep"
        );
      }
    } catch (err) {
      console.error("open-PR sync failed", {
        session: session.id,
        prUrl,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
