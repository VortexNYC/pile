import { eq } from "drizzle-orm";
import { z } from "zod";

import { createD1, type D1Client } from "../global/db.js";
import {
  DEFAULT_LANE_PERMISSIONS,
  fetchLanePermissions,
} from "../global/pile-repo-config.js";
import { organization } from "../global/schema.js";
import { getTeamById } from "../global/teams.js";
import { createAuth } from "../platform/auth.js";
import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { WorkerEnv } from "../platform/middleware.js";
import {
  CONCURRENT_LANES_PAUSE_PREFIX,
  DEFAULT_GIT_IDENTITY_REPO,
  type AgentSession,
  type Issue,
} from "../types/workspace.js";
import { isDynamicMemoryFact } from "../workspace/data/index.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import {
  parseEffortModels,
  resolveDispatchEffort,
  type DispatchEffort,
} from "./budget.js";
import { CfAgentProvider } from "./cf-agent.js";
import { ClaudeCliAgentProvider } from "./claude-cli.js";
import { CodexCliAgentProvider } from "./codex-cli.js";
import { CodexAgentProvider } from "./codex.js";
import {
  computeBackend,
  isComputeInfraError,
  type ComputeBackend,
} from "./compute.js";
import { loadProviderConfig } from "./credentials.js";
import { CursorCliAgentProvider } from "./cursor-cli.js";
import { CursorAgentProvider } from "./cursor.js";
import { resolveAgentEnv } from "./daytona.js";
import {
  checkDispatchDedupe,
  type DedupeContinuation,
  type DedupeDeps,
  type DedupeResult,
} from "./dedupe.js";
import { DevinCliAgentProvider } from "./devin-cli.js";
import { DevinAgentProvider } from "./devin.js";
import { guidanceRefs, renderGuidancePacks } from "./guidance.js";
import {
  getLaneDbProvider,
  laneDbConfigForRepo,
  type LaneDbConfig,
} from "./lane-db.js";
import { buildResultSchemaInstructions, sessionLabel } from "./lane-result.js";
import type { AgentProvider } from "./provider.js";
import {
  validateSecondaryRepos,
  type SecondaryRepo,
} from "./secondary-repos.js";
import { describeCapBreach, SPEND_CAP_ACTOR } from "./spend.js";

// Workspace-wide ceiling on live lanes — the container apps are bounded
// (max_instances) and one lane's provisioning wedge otherwise starves all.
const MAX_ACTIVE_LANES_PER_WORKSPACE = 25;

/** VTX-648 — review lanes (`purpose === "review"`) get at most half of an
 *  agent's concurrency ceiling so PR review bursts can never starve
 *  implementation lanes (`purpose === null`). */
export function reviewConcurrencyCap(cap: number): number {
  return Math.max(1, Math.floor(cap / 2));
}

const providers: Record<string, (env: WorkerEnv) => AgentProvider> = {
  devin: (env) => new DevinAgentProvider(env),
  codex: (env) => new CodexAgentProvider(env),
  "codex-cli": (env) => new CodexCliAgentProvider(env),
  "devin-cli": (env) => new DevinCliAgentProvider(env),
  "cursor-cli": (env) => new CursorCliAgentProvider(env),
  "claude-cli": (env) => new ClaudeCliAgentProvider(env),
  "cf-agent": (env) => new CfAgentProvider(env, "cf-agent"),
  cursor: (env) => new CursorAgentProvider(env),
  flue: (env) => new CfAgentProvider(env, "flue"),
};

function parseAgentProviderTeamIds(
  teamIds: string | null | undefined
): string[] | null {
  if (teamIds === null || teamIds === undefined || teamIds === "") {
    return null;
  }
  try {
    const value: unknown = JSON.parse(teamIds);
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      return value;
    }
  } catch {
    // fall through to config error
  }
  throw new VortexError({
    code: "CONFIG_ERROR",
    status: 500,
    message: "Invalid agent provider teamIds configuration",
  });
}

export function getAgentProvider(
  agentId: string,
  env: WorkerEnv
): AgentProvider {
  const factory = providers[agentId];
  if (!factory) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: `Unknown agent provider: ${agentId}`,
    });
  }
  return factory(env);
}

export function registerAgentProvider(
  agentId: string,
  factory: (env: WorkerEnv) => AgentProvider
) {
  providers[agentId] = factory;
}

/** Whether a provider id resolves — registry entries plus runtime-registered
 *  lanes (tests, plugins). Used to validate providerAgentId at write time
 *  (PILE-437) so a typo fails at registration, not at dispatch. */
export function hasAgentProvider(agentId: string): boolean {
  return agentId in providers;
}

/** Whether a provider parks its sandbox after a terminal result for
 *  follow-up resumes — the population the kept-sandbox cap reaps and
 *  fleet-health counts (PILE-253). Capability is descriptor-level, so the
 *  raw env is enough; unknown/external providers report false. */
export function providerKeepsTerminalSandbox(
  agentId: string,
  env: WorkerEnv
): boolean {
  try {
    return getAgentProvider(agentId, env).keepsTerminalSandbox === true;
  } catch {
    return false;
  }
}

/** Org metadata → laneDb config for a repo (organization.metadata.laneDb
 *  keyed by "owner/name"). */
async function laneDbConfigForOrgRepo(
  env: WorkerEnv,
  organizationId: string,
  repo: string
): Promise<LaneDbConfig | null> {
  const d1 = createD1(env.D1);
  const row = await d1
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .get();
  let parsed: Record<string, unknown> | null = null;
  try {
    const value: unknown = JSON.parse(row?.metadata ?? "");
    if (typeof value === "object" && value !== null) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }
  return laneDbConfigForRepo(parsed, repo);
}

/** PILE-321 — dispatch-time repo resolution: a repo-less issue inherits its
 *  team's defaultRepo (the same fallback issue create applies). The resolved
 *  repo is persisted on the issue so lane-token minting, dedupe, and
 *  redispatches all see the repo the lane actually works. Callers that take
 *  a `repo` body field skip this when it was sent — explicit null still
 *  forces a repo-less lane. */
export async function inheritTeamDefaultRepo(
  db: D1Client,
  stub: DurableObjectStub<WorkspaceDO>,
  organizationId: string,
  issue: Issue,
  actorId: string
): Promise<Issue> {
  if (issue.repo || !issue.teamId) return issue;
  const defaultRepo = (await getTeamById(db, issue.teamId, organizationId))
    ?.defaultRepo;
  if (!defaultRepo) return issue;
  return (
    (await stub.updateIssue(issue.id, { repo: defaultRepo }, actorId)) ?? {
      ...issue,
      repo: defaultRepo,
    }
  );
}

/** PILE-446 — audit marker for a continuation dispatch: the lane resumes an
 *  open covering PR's head branch because its original session ended. Written
 *  on whichever session row carries the run (fresh, parked, or promoted). */
async function noteContinuation(
  stub: DurableObjectStub<WorkspaceDO>,
  sessionId: string,
  continuation: DedupeContinuation
): Promise<void> {
  await stub
    .addAgentSessionEvent({
      sessionId,
      type: "lane.continuation",
      message: `Continuing open PR ${continuation.prUrl} on branch ${continuation.headRef} — covering session ended`,
      payload: { ...continuation },
    })
    .catch(() => {});
}

export async function dispatchAgent(
  env: WorkerEnv,
  agentId: string,
  organizationId: string,
  issue: Issue,
  actor: WorkspaceIdentity,
  model?: string,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void },
  options?: {
    instructions?: string;
    /** Spawned-lane linkage: children carry their parent's session id and
     *  spawnDepth+1 so caps and `child.terminal` events work (PILE-211). */
    parentSessionId?: string;
    spawnDepth?: number;
    /** Extra runner env from lane provisioning (e.g. PlanetScale branch URLs). */
    extraEnv?: Record<string, string>;
    // `.pile/config.json` env allowlist — caller-supplied extraEnv keys
    // outside the list are dropped (infra env like laneDb is exempt).
    envAllowlist?: string[];
    /** Promote a parked `waiting` session instead of creating a fresh row —
     *  the sweep calls this when the queuedAfter blocker goes terminal. */
    promoteSessionId?: string;
    /** Lane purpose — "preflight" marks planner-critique sessions (VTX-209). */
    purpose?: string;
    /** Preflight critiques must not park behind dedupe coverage — they run
     *  repo-less and only produce a report. */
    skipQueue?: boolean;
    /** Explicit sequencing (PILE-245 batch dispatch): park the new session in
     *  `waiting` behind this session id; the sweep promotes it once the
     *  blocker goes terminal. Wins over the dedupe-derived queueAfter. */
    queueAfter?: string;
    /** Side lanes (PILE-273 review) run alongside the issue's working lane
     *  instead of conflicting with it. */
    concurrent?: boolean;
    /** Sibling repos cloned into the lane next to issue.repo (PILE-294).
     *  Persisted on the session row; promote/retry callers pass the stored
     *  set back in. */
    secondaryRepos?: SecondaryRepo[];
    /** PILE-293 — model tier; defaults from the issue's priority. Picks the
     *  model via provider config `effortModels` when no model is given. */
    effort?: DispatchEffort;
    /** PILE-293 — wall-clock run budget in minutes, enforced by the sweep
     *  in place of the provider timeout. */
    maxDurationMinutes?: number;
    /** Serialized draft-07 JSON Schema (see `resolveResultSchema`) the
     *  lane's final output is validated against (PILE-289). */
    resultSchema?: string;
    /** PILE-423 — pipeline sub-step key this lane works (e.g. "outreach").
     *  Step-scoped guidance packs resolve against it; persisted on the
     *  session so promotion/retries keep the same scope. */
    stepKey?: string;
    /** Resolved agent_type registry entry the lane runs as — providers
     *  with profile support hydrate the agent from this at dispatch. */
    agentProfile?: {
      slug: string;
      name: string;
      jobSpec?: string | null;
      toolScope?: string | null;
    };
    /** Durable conversation key for provider-side memory — the drainer
     *  passes `{merchantId}-{agentSlug}` so per-merchant context survives
     *  across dispatches. */
    conversationKey?: string;
    /** Dedupe GitHub/auth overrides — tests inject stubs; production
     *  callers leave this unset so real installation tokens apply. */
    dedupeDeps?: DedupeDeps;
    /** PILE-452 — what a paused agent type does to this dispatch. "hold"
     *  (default) parks a `waiting` + `paused` row per PILE-420 — right for
     *  explicit user dispatch. "fail" throws AGENT_PAUSED instead:
     *  system-initiated dispatches (sweep redispatch, retries, triggers)
     *  must not leak held rows while the agent type is frozen. */
    onPaused?: "hold" | "fail";
  }
): Promise<AgentSession> {
  const label = sessionLabel(issue, agentId, options?.purpose);
  const resultSchema = options?.resultSchema ?? null;
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
  await stub.setOrganizationId(organizationId);

  const storedConfig = await stub.getAgentProviderConfig(agentId);
  const allowedTeamIds = parseAgentProviderTeamIds(storedConfig?.teamIds);
  if (allowedTeamIds && !allowedTeamIds.includes(issue.teamId)) {
    throw new VortexError({
      code: "FORBIDDEN",
      status: 403,
      message: `Agent provider ${agentId} is not enabled for this team`,
    });
  }

  // BYOK: overlay the workspace's stored provider credentials/model onto the
  // deployment env before constructing the provider. Fields the workspace
  // hasn't set fall back to env, so self-host defaults still work.
  const providerConfig = await loadProviderConfig(env, stub, agentId);
  if (isProviderDisabled(providerConfig?.config)) {
    throw new VortexError({
      code: "CONFIG_ERROR",
      status: 409,
      message: `Agent provider ${agentId} is disabled for this workspace`,
    });
  }
  // A promoted session keeps the budget it was queued with.
  const promoteTarget = options?.promoteSessionId
    ? await stub.getAgentSession(options.promoteSessionId)
    : null;
  const effort = resolveDispatchEffort(
    options?.effort ?? promoteTarget?.effort,
    issue
  );
  const maxDurationMinutes =
    options?.maxDurationMinutes ?? promoteTarget?.maxDurationMinutes ?? null;
  const resolvedModel =
    model ?? parseEffortModels(providerConfig?.config)?.[effort];
  const provider = getAgentProvider(
    agentId,
    resolveAgentEnv(env, providerConfig ?? undefined)
  );

  const secondaryRepos = validateSecondaryRepos(
    issue.repo,
    options?.secondaryRepos
  );
  if (secondaryRepos.length > 0 && !provider.supportsSecondaryRepos) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: `Agent provider ${agentId} does not support secondaryRepos`,
    });
  }
  const storedSecondaryRepos =
    secondaryRepos.length > 0 ? JSON.stringify(secondaryRepos) : null;

  const gitIdentity = issue.repo
    ? ((await stub.getGitIdentityByRepo(issue.repo)) ??
      (await stub.getGitIdentityByRepo(DEFAULT_GIT_IDENTITY_REPO)) ??
      null)
    : null;

  const active = await stub.getActiveAgentSessionForIssue(issue.id);
  if (
    active &&
    !options?.concurrent &&
    active.session.id !== options?.promoteSessionId
  ) {
    throw new VortexError({
      code: "CONFLICT",
      status: 409,
      message: `An active agent session (${active.session.id}) already exists for this issue`,
    });
  }

  // PILE-214 — pre-dispatch dedupe. Skipped on promote: the parked session
  // already passed (or was deliberately queued by) this gate. Fails open —
  // a GitHub outage must not stop dispatch — but the skip is surfaced as a
  // session event so coverage gaps are auditable.
  let dedupeAdvisory: DedupeResult | null = null;
  let dedupeError: string | null = null;
  let continuation: DedupeContinuation | null = null;
  if (options?.promoteSessionId) {
    if (!promoteTarget || promoteTarget.status !== "waiting") {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Queued session not found or no longer waiting",
      });
    }
    // VTX-643 / VTX-648 — a queue/pause promotion must still respect the
    // provider's maxConcurrentLanes cap (and the review sub-cap for review
    // lanes): if at cap, hold the promoted row in `waiting` + `paused`.
    const cap = provider.maxConcurrentLanes;
    if (cap != null) {
      const liveRows = (await stub.listAgentSessions({ limit: 200 })).filter(
        (s) =>
          s.agentId === agentId &&
          s.id !== options.promoteSessionId &&
          !["completed", "failed", "canceled"].includes(s.status) &&
          s.paused !== 1 &&
          !(s.status === "waiting" && s.providerSessionId == null)
      );
      const liveForAgent = liveRows.length;
      const promotedPurpose = options.purpose ?? promoteTarget.purpose;
      const reviewCap = reviewConcurrencyCap(cap);
      const liveReviewForAgent =
        promotedPurpose === "review"
          ? liveRows.filter((s) => s.purpose === "review").length
          : 0;
      if (
        liveForAgent >= cap ||
        (promotedPurpose === "review" && liveReviewForAgent >= reviewCap)
      ) {
        const reason =
          liveForAgent >= cap
            ? `${CONCURRENT_LANES_PAUSE_PREFIX}${agentId} at ${cap} live lanes`
            : `${CONCURRENT_LANES_PAUSE_PREFIX}${agentId} at ${reviewCap} review lanes`;
        if (liveForAgent >= cap) {
          await stub.pauseAgentType(agentId, {
            reason,
            actorId: "system",
            actorType: "system",
          });
        }
        const parked = (await stub.updateAgentSession(
          options.promoteSessionId,
          {
            status: "waiting",
            paused: 1,
          }
        )) ?? {
          ...promoteTarget,
          status: "waiting" as const,
          paused: 1,
        };
        await stub
          .addAgentSessionEvent({
            sessionId: parked.id,
            type: "agent.paused",
            message: `Dispatch held — agent type "${agentId}" is paused: ${reason}`,
            payload: {
              agentId,
              reason,
              pausedBy: "system",
            },
          })
          .catch(() => {});
        return parked;
      }
    }
  } else {
    const dedupe = await checkDispatchDedupe(
      env,
      stub,
      issue,
      options?.dedupeDeps
    ).catch((err) => {
      dedupeError = err instanceof Error ? err.message : String(err);
      return null;
    });
    // VTX-621 — a merged lane PR covering a finished issue makes the
    // dispatch a stray (stale retry, trigger on a closed ticket). Refuse
    // outright; CONFLICT reads as redundant, not an error. A reopened
    // issue (back to an active status) dispatches normally — the merged
    // PR is history and the lane opens a fresh one (PILE-257).
    if (
      dedupe?.merged &&
      (issue.status === "done" || issue.status === "canceled")
    ) {
      throw new VortexError({
        code: "CONFLICT",
        status: 409,
        message: `Issue already covered by merged PR ${dedupe.merged.prUrl} — refusing stale dispatch`,
      });
    }
    continuation = dedupe?.continuation ?? null;
    if (continuation && issue.branch !== continuation.headRef) {
      // PILE-446 — an open PR covering this issue with no live session makes
      // this dispatch a continuation: the lane resumes the PR's head branch
      // instead of a fresh `issue-<id>` fork. Persisted so queued/paused
      // promotions and retries see the same target (updateIssue can fail on
      // a repo+branch collision — the in-memory override still applies).
      const repointed = await stub
        .updateIssue(issue.id, { branch: continuation.headRef }, actor.id)
        .catch(() => undefined);
      issue = repointed ?? { ...issue, branch: continuation.headRef };
    }
    const queueAfter = options?.queueAfter ?? dedupe?.queueAfter;
    if (queueAfter && !options?.skipQueue) {
      const queued = await stub.createAgentSession({
        issueId: issue.id,
        agentId,
        provider: agentId,
        actorId: actor.id,
        actorType: actor.type,
        status: "waiting",
        queuedAfter: queueAfter,
        parentSessionId: options?.parentSessionId ?? null,
        spawnDepth: options?.spawnDepth ?? 0,
        purpose: options?.purpose ?? null,
        secondaryRepos: storedSecondaryRepos,
        effort,
        maxDurationMinutes,
        label,
        resultSchema,
        stepKey: options?.stepKey ?? null,
      });
      await stub
        .addAgentSessionEvent({
          sessionId: queued.id,
          type: "lane.queued",
          message: options?.queueAfter
            ? `Queued behind session ${queueAfter}`
            : `Queued behind session ${queueAfter} — open PR coverage detected`,
          payload: dedupe ? { coverage: dedupe.coverage } : undefined,
        })
        .catch(() => {});
      if (continuation) await noteContinuation(stub, queued.id, continuation);
      return queued;
    }
    // PILE-420 — the agent type is paused workspace-wide: the dispatch is
    // accepted but held, parked `waiting` + `paused`. Resume drains holds
    // in order; a dedupe edge rides along so a held lane still joins its
    // queue chain after release.
    let pause:
      | { reason?: string | null; createdBy?: string | null }
      | undefined = await stub.getAgentPause(agentId);
    if (!pause) {
      // PILE-425 — spend/token window caps: a breached cap pauses the agent
      // type (the sweep fires the CoS alert once per breach-day via
      // claimSpendCapAlert) and this dispatch parks on the hold like any
      // pause. Fails open — a DO hiccup must not block dispatch; the sweep
      // catches up next pass.
      const verdict = await stub
        .evaluateAgentSpendCaps(agentId)
        .catch((err: unknown) => {
          console.error("spend-cap evaluation failed", {
            agentId,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        });
      if (verdict && verdict.breaches.length > 0) {
        pause = await stub.pauseAgentType(agentId, {
          reason: `spend cap — ${describeCapBreach(verdict.breaches[0])}`,
          actorId: SPEND_CAP_ACTOR,
          actorType: "agent",
        });
      }
    }
    if (!pause) {
      // VTX-621 / VTX-648 — per-agent concurrency cap + review sub-cap:
      // review lanes (`purpose === "review"`) cap at reviewConcurrencyCap(cap)
      // and hold locally without writing a workspace-wide agent_pauses row, so
      // review bursts never block implementation dispatches.
      const cap = provider.maxConcurrentLanes;
      if (cap != null) {
        const liveRows = (await stub.listAgentSessions({ limit: 200 })).filter(
          (s) =>
            s.agentId === agentId &&
            s.id !== options?.promoteSessionId &&
            !["completed", "failed", "canceled"].includes(s.status) &&
            s.paused !== 1 &&
            !(s.status === "waiting" && s.providerSessionId == null)
        );
        const liveForAgent = liveRows.length;
        const reviewCap = reviewConcurrencyCap(cap);
        const liveReviewForAgent =
          options?.purpose === "review"
            ? liveRows.filter((s) => s.purpose === "review").length
            : 0;
        if (liveForAgent >= cap) {
          pause = await stub.pauseAgentType(agentId, {
            reason: `${CONCURRENT_LANES_PAUSE_PREFIX}${agentId} at ${cap} live lanes`,
            actorId: "system",
            actorType: "system",
          });
        } else if (
          options?.purpose === "review" &&
          liveReviewForAgent >= reviewCap
        ) {
          pause = {
            reason: `${CONCURRENT_LANES_PAUSE_PREFIX}${agentId} at ${reviewCap} review lanes`,
            createdBy: "system",
          };
        }
      }
    }
    if (pause) {
      if (options?.onPaused === "fail") {
        throw new VortexError({
          code: "AGENT_PAUSED",
          status: 409,
          message: `Agent type "${agentId}" is paused${pause.reason ? `: ${pause.reason}` : ""}`,
        });
      }
      const parked = await stub.createAgentSession({
        issueId: issue.id,
        agentId,
        provider: agentId,
        actorId: actor.id,
        actorType: actor.type,
        status: "waiting",
        queuedAfter: queueAfter ?? null,
        paused: 1,
        parentSessionId: options?.parentSessionId ?? null,
        spawnDepth: options?.spawnDepth ?? 0,
        purpose: options?.purpose ?? null,
        secondaryRepos: storedSecondaryRepos,
        effort,
        maxDurationMinutes,
        label,
        resultSchema,
        stepKey: options?.stepKey ?? null,
      });
      await stub
        .addAgentSessionEvent({
          sessionId: parked.id,
          type: "agent.paused",
          message: `Dispatch held — agent type "${agentId}" is paused${pause.reason ? `: ${pause.reason}` : ""}`,
          payload: {
            agentId,
            reason: pause.reason ?? null,
            pausedBy: pause.createdBy ?? null,
          },
        })
        .catch(() => {});
      if (continuation) await noteContinuation(stub, parked.id, continuation);
      return parked;
    }
    // Workspace-wide lane ceiling for container-backed lanes — the CF
    // container apps are bounded (max_instances) and an uncapped queue of
    // concurrent lanes wedges provisioning for everyone. Promote is exempt:
    // it moves a parked lane. Daytona lanes are provider-quota bound, not
    // ours. PILE-474 — the cap is per backend: sessions pinned to Daytona
    // don't count against the CF pool and vice versa. Unpinned (legacy)
    // rows count against whichever backend this dispatch resolves to —
    // they predate the column, so their backend is unknowable.
    const activeSessions = (
      await stub.listAgentSessions({ limit: 200 })
    ).filter((s) => !["completed", "failed", "canceled"].includes(s.status));
    // Resolve the dispatch backend lazily: computeBackend() throws
    // CONFIG_ERROR when neither DAYTONA_API_KEY nor a SANDBOX binding is
    // configured, but remote API providers never touch sandbox compute —
    // and below the lane ceiling the backend is irrelevant anyway.
    if (activeSessions.length >= MAX_ACTIVE_LANES_PER_WORKSPACE) {
      let dispatchBackend: ComputeBackend["kind"] | null;
      try {
        dispatchBackend = computeBackend(env, agentId).kind;
      } catch (err) {
        // Unconfigured compute can't back a Cloudflare container lane, so
        // the CF container pool cap doesn't apply to this dispatch.
        if (err instanceof VortexError && err.code === "CONFIG_ERROR") {
          dispatchBackend = null;
        } else {
          throw err;
        }
      }
      const liveCount = activeSessions.filter(
        (s) => s.computeBackend === dispatchBackend || s.computeBackend === null
      ).length;
      if (
        liveCount >= MAX_ACTIVE_LANES_PER_WORKSPACE &&
        dispatchBackend === "cloudflare"
      ) {
        throw new VortexError({
          code: "CONFLICT",
          status: 409,
          message: `Workspace has ${liveCount} active agent sessions (max ${MAX_ACTIVE_LANES_PER_WORKSPACE}) — wait for lanes to finish`,
        });
      }
    }
    if (
      dedupe &&
      (dedupe.coverage.length > 0 || dedupe.collisions.length > 0)
    ) {
      // Advisory findings surface on the session the moment it's created.
      dedupeAdvisory = dedupe;
    }
  }

  let session: AgentSession;
  if (options?.promoteSessionId) {
    const promoted = promoteTarget;
    if (!promoted || promoted.status !== "waiting") {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Queued session not found or no longer waiting",
      });
    }
    // PILE-260 — promotion rewinds createdAt: the provision timeout and
    // the inactivity fallback anchor here, and queue dwell is not lane
    // runtime. queuedAfter stays on the row as the edge an infra-retry
    // re-anchors to — clearing it parallelizes the chain on redispatch.
    const promotedAt = new Date().toISOString();
    session = (await stub.updateAgentSession(promoted.id, {
      status: "created",
      createdAt: promotedAt,
      // An explicit stepKey on promote wins; otherwise the parked row's
      // stored key (set when the dispatch was queued) drives resolution.
      ...(options?.stepKey !== undefined ? { stepKey: options.stepKey } : {}),
    })) ??
      // A null return means the row didn't take the write — the fallback
      // must still reflect the promotion or the stale queue timestamp
      // trips the provision timeout on the next sweep.
      { ...promoted, status: "created", createdAt: promotedAt };
  } else {
    session = await stub.createAgentSession({
      issueId: issue.id,
      agentId,
      provider: agentId,
      actorId: actor.id,
      actorType: actor.type,
      status: "created",
      result: null,
      url: null,
      parentSessionId: options?.parentSessionId ?? null,
      spawnDepth: options?.spawnDepth ?? 0,
      purpose: options?.purpose ?? null,
      secondaryRepos: storedSecondaryRepos,
      effort,
      maxDurationMinutes,
      label,
      resultSchema,
      stepKey: options?.stepKey ?? null,
    });
  }

  // PILE-423 — scoped guidance packs (Linear's "Guidance"): resolve the packs
  // applying to this lane (workspace → team → status → step), record the
  // versions used on the session row, and inject the rendered text into the
  // dispatch prompt envelope ahead of the caller's own instructions so the
  // most specific text lands last. Queued/paused lanes resolve at promotion
  // — a parked row re-enters this path and picks up current versions.
  const stepKey = options?.stepKey ?? session.stepKey ?? null;
  const guidancePacks = await stub.resolveGuidancePacks({
    teamId: issue.teamId ?? null,
    status: issue.status ?? null,
    stepKey,
  });
  // Workspace memory — recall prior facts for this entity (by both UUID and
  // human identifier), the target repository, the agent's own lessons, and
  // shared workspace facts, injected ahead of the caller's instructions.
  let memoryText: string | null = null;
  try {
    const entityFacts = await stub.memoryRecall({
      entityType: "issue",
      entityId: issue.id,
      limit: 15,
    });
    const identifierFacts =
      issue.identifier && issue.identifier !== issue.id
        ? await stub.memoryRecall({
            entityType: "issue",
            entityId: issue.identifier,
            limit: 15,
          })
        : [];
    const repoFacts = issue.repo
      ? await stub.memoryRecall({
          entityType: "repo",
          entityId: issue.repo,
          limit: 10,
        })
      : [];
    const agentFacts = await stub.memoryRecall({
      entityType: "agent",
      entityId: options?.agentProfile?.slug ?? agentId,
      limit: 10,
    });
    const sharedFacts = await stub.memoryRecall({
      entityType: "workspace",
      entityId: organizationId,
      limit: 10,
    });
    // PILE-640 — task-contextual brief: the entity/repo/agent lists above
    // are newest-N windows, so an older but topically-relevant fact drops
    // out. Re-run recall with the issue title+description as the search
    // text and surface semantic/BM25 matches that fell outside the windows.
    const taskQuery = [issue.title, issue.description]
      .filter(Boolean)
      .join(" ")
      .slice(0, 240)
      .trim();
    const contextualRepoFacts =
      issue.repo && taskQuery
        ? await stub.memoryRecall({
            entityType: "repo",
            entityId: issue.repo,
            search: taskQuery,
            limit: 10,
          })
        : [];
    const contextualWorkspaceFacts = taskQuery
      ? await stub.memoryRecall({ search: taskQuery, limit: 8 })
      : [];
    const seenFactIds = new Set<string>();
    const facts = [
      ...(entityFacts ?? []),
      ...(identifierFacts ?? []),
      ...(repoFacts ?? []),
      ...(agentFacts ?? []),
      ...(sharedFacts ?? []),
    ].filter((f) => {
      if (seenFactIds.has(f.id)) return false;
      seenFactIds.add(f.id);
      return true;
    });
    // Contextual hits not already covered by the base windows — these are
    // the facts semantic recall rescued from beyond the newest-N cap.
    const contextualFacts = [
      ...(contextualRepoFacts ?? []),
      ...(contextualWorkspaceFacts ?? []),
    ].filter((f) => {
      if (seenFactIds.has(f.id)) return false;
      seenFactIds.add(f.id);
      return true;
    });
    if (facts.length > 0 || contextualFacts.length > 0) {
      // PILE-616 — split the entity profile: durable static facts
      // (conventions, lessons, architecture) up front, transient dynamic
      // context (recent outcomes, signals, expiring holds) after, so the
      // lane reads a structured profile instead of a flat list.
      const staticFacts = facts.filter((f) => !isDynamicMemoryFact(f));
      const dynamicFacts = facts.filter((f) => isDynamicMemoryFact(f));
      const sections: string[] = [];
      if (staticFacts.length > 0) {
        sections.push(
          "Static facts:\n" +
            staticFacts.map((f) => `- [${f.kind}] ${f.fact}`).join("\n")
        );
      }
      if (dynamicFacts.length > 0) {
        sections.push(
          "Recent / dynamic context:\n" +
            dynamicFacts
              .map(
                (f) =>
                  `- [${f.kind}] ${f.fact}${f.validUntil ? ` (expires ${f.validUntil})` : ""}`
              )
              .join("\n")
        );
      }
      if (contextualFacts.length > 0) {
        sections.push(
          "Task-relevant recall (matched on this issue's text):\n" +
            contextualFacts.map((f) => `- [${f.kind}] ${f.fact}`).join("\n")
        );
      }
      memoryText =
        "Workspace memory (prior facts for this work — treat as given):\n" +
        sections.join("\n\n") +
        "\n\nWhen you finish, call memory_remember for durable facts " +
        "you learned (coverage swept, lessons, entity notes) so the " +
        "next lane starts with them.";
    }
  } catch {
    // Memory recall is best-effort — never block a dispatch on it.
    memoryText = null;
  }

  let guidanceText: string | null = null;
  if (guidancePacks.length > 0) {
    const refs = guidanceRefs(guidancePacks);
    const recorded = await stub.updateAgentSession(session.id, {
      guidance: JSON.stringify(refs),
    });
    if (recorded) session = recorded;
    guidanceText = renderGuidancePacks(guidancePacks);
    await stub
      .addAgentSessionEvent({
        sessionId: session.id,
        type: "lane.guidance",
        message: `Guidance packs: ${refs.map((r) => `${r.name}@${r.version}`).join(", ")}`,
        payload: { packs: refs },
      })
      .catch(() => {});
  }

  // PILE-212 — lane-scoped preview DB: when org metadata declares laneDb for
  // this repo, provision a PlanetScale branch+role and inject the env into the
  // runner. Branch is named off the real session id, so this runs post-create.
  let extraEnv =
    options?.extraEnv && options?.envAllowlist
      ? Object.fromEntries(
          Object.entries(options.extraEnv).filter(([key]) =>
            options.envAllowlist?.includes(key)
          )
        )
      : options?.extraEnv;
  // PILE-290 — lane-env allowlist includes PILE_PGX_* for pgx lane DBs.
  if (issue.repo && !session.laneDbRef) {
    const laneConfig = await laneDbConfigForOrgRepo(
      env,
      organizationId,
      issue.repo
    );
    if (laneConfig) {
      const laneProvider = getLaneDbProvider(
        env,
        undefined,
        laneConfig.provider
      );
      if (laneProvider) {
        try {
          const provisioned = await laneProvider.provision(
            laneConfig,
            session.id
          );
          extraEnv = { ...extraEnv, ...provisioned.env };
          await stub.updateAgentSession(session.id, {
            laneDbRef: JSON.stringify(provisioned.ref),
          });
        } catch (err) {
          await stub
            .addAgentActivity({
              sessionId: session.id,
              actorId: actor.id,
              type: "error",
              system: true,
              message: `Lane DB provisioning failed: ${err instanceof Error ? err.message : String(err)}`,
            })
            .catch(() => {});
        }
      }
    }
  }

  if (dedupeError) {
    await stub
      .addAgentSessionEvent({
        sessionId: session.id,
        type: "lane.dedupe",
        message: `Pre-dispatch dedupe skipped: ${dedupeError}`,
      })
      .catch(() => {});
  }
  if (dedupeAdvisory) {
    await stub
      .addAgentSessionEvent({
        sessionId: session.id,
        type: "lane.dedupe",
        message: `Pre-dispatch dedupe: ${dedupeAdvisory.coverage.length} PR coverage match(es), ${dedupeAdvisory.collisions.length} file collision(s)`,
        payload: {
          coverage: dedupeAdvisory.coverage,
          collisions: dedupeAdvisory.collisions,
        },
      })
      .catch(() => {});
  }
  if (continuation) await noteContinuation(stub, session.id, continuation);

  await stub.addAgentActivity({
    sessionId: session.id,
    actorId: actor.id,
    type: "thought",
    system: true,
    message: `Dispatching to ${agentId}… (effort ${effort}${resolvedModel ? `, model ${resolvedModel}` : ""}${maxDurationMinutes ? `, max ${maxDurationMinutes}m` : ""})`,
  });

  try {
    const comments = (await stub.listComments(issue.id))
      .filter((c) => !c.internal)
      .slice(-20)
      .map((c) => ({
        author: c.externalAuthor ?? c.authorId ?? "unknown",
        createdAt: c.createdAt ?? null,
        body: c.body,
      }));

    // Mint a scoped read-only credential so the dispatched agent can read
    // linked support tickets and capture artifacts through the API. If minting
    // fails the dispatch proceeds — the agent just lacks Pile access.
    let pileApi: { url: string; key: string } | undefined;
    try {
      const auth = await createAuth(env);
      const created = await auth.api.createApiKey({
        body: {
          userId: actor.id,
          name: `agent-${session.id.slice(0, 13)}`,
          // PILE-623 — ephemeral lane tokens live 24h; the sweep's
          // pruneStaleEphemeralAgentKeys janitor removes any stragglers
          // past the TTL (or already expired) on each pass.
          expiresIn: 60 * 60 * 24,
          rateLimitEnabled: false,
          metadata: {
            organizationId,
            permissions: "read",
            actorType: "agent",
          },
          permissions: { workspace: ["read"] },
        },
      });
      const parsed = z.object({ key: z.string() }).safeParse(created);
      if (parsed.success && env.PUBLIC_API_URL) {
        pileApi = { url: env.PUBLIC_API_URL, key: parsed.data.key };
      } else {
        await stub
          .addAgentActivity({
            sessionId: session.id,
            actorId: actor.id,
            type: "error",
            system: true,
            message: `Pile API credential unavailable: ${!parsed.success ? "unexpected createApiKey response" : "PUBLIC_API_URL unset"}`,
          })
          .catch(() => {});
      }
    } catch (err) {
      pileApi = undefined;
      await stub
        .addAgentActivity({
          sessionId: session.id,
          actorId: actor.id,
          type: "error",
          system: true,
          message: `Pile API credential mint failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        .catch(() => {});
    }

    // PILE-276 — lane permission tiers from the repo's default-branch
    // `.pile/config.json`, applied at sandbox provision and in the runner.
    const lanePermissions = issue.repo
      ? await fetchLanePermissions(env, issue.repo, agentId)
      : { permissions: DEFAULT_LANE_PERMISSIONS };
    if (lanePermissions.lockedReason) {
      await stub
        .addAgentActivity({
          sessionId: session.id,
          actorId: actor.id,
          type: "error",
          system: true,
          message: `Lane permissions locked to push=disabled shell=disabled: ${lanePermissions.lockedReason}`,
        })
        .catch(() => {});
    }

    const providerSession = await provider.dispatch(
      organizationId,
      issue,
      resolvedModel,
      {
        sessionId: session.id,
        gitIdentity,
        // ExecutionContext.waitUntil is a WebIDL method — passing
        // `ctx.waitUntil` detaches it and workerd throws "Illegal invocation"
        // when the provider calls sessionContext.waitUntil(task). Wrap it so
        // the real ctx stays the receiver.
        waitUntil: ctx
          ? (task: Promise<unknown>) => ctx.waitUntil(task)
          : undefined,
        comments,
        pileApi,
        agentProfile: options?.agentProfile,
        conversationKey: options?.conversationKey,
        resumeProviderSessionId: options?.conversationKey
          ? ((
              await stub.getAgentSessionByConversationKey(
                options.conversationKey
              )
            )?.providerSessionId ?? undefined)
          : undefined,
        instructions:
          [
            memoryText,
            guidanceText,
            // PILE-446 — a continuation lane lands on the covering PR's head
            // branch; the context tells it the PR exists and what to do
            // there instead of treating the run as fresh work.
            continuation
              ? [
                  `Continuation dispatch: open PR ${continuation.prUrl} already covers this issue and its agent session ended.`,
                  `Your working branch is the PR's head branch \`${continuation.headRef}\` — pick up where it left off. Resolve any merge conflicts with the base branch, address outstanding review feedback, and push to the same branch. Do not open a second pull request.`,
                  continuation.changesRequested
                    ? "The PR has unresolved requested changes — address them."
                    : null,
                ]
                  .filter((line): line is string => line !== null)
                  .join("\n")
              : null,
            options?.instructions ?? null,
            session.resultSchema
              ? buildResultSchemaInstructions(session.resultSchema)
              : null,
          ]
            .filter((part): part is string => part !== null && part !== "")
            .join("\n\n") || undefined,
        extraEnv,
        purpose: options?.purpose,
        secondaryRepos,
        permissions: lanePermissions.permissions,
        effort,
      }
    );

    const updated = await stub.applyAgentSessionResult(
      session.id,
      {
        status: providerSession.status,
        result: providerSession.result,
        url: providerSession.url,
        providerSessionId: providerSession.id,
        prUrl: providerSession.prUrl,
        prState: providerSession.prState,
        branch: providerSession.branch,
      },
      actor.id
    );

    return updated ?? session;
  } catch (error) {
    // Dispatch-time substrate failure (container spawn 503, RPC transport
    // reset, compute I/O timeout, Daytona sandbox-create/provision errors)
    // is infra-class — it gets the retry path and feeds the fleet breaker,
    // not the task-failure trail. Compute-layer failures arrive flagged as
    // ComputeError (PILE-452); everything else falls back to status and the
    // sandbox SDK's transient classifiers.
    let infraFailure = isComputeInfraError(error);
    if (
      !infraFailure &&
      error instanceof VortexError &&
      (error.status === 503 || error.status === 504)
    ) {
      infraFailure = true;
    } else if (!infraFailure) {
      try {
        const sandboxSdk = (await import("@cloudflare/sandbox")) as {
          isPlatformTransientError?: (e: unknown) => boolean;
          isDurableObjectCodeUpdateReset?: (e: unknown) => boolean;
        };
        infraFailure =
          sandboxSdk.isPlatformTransientError?.(error) === true ||
          sandboxSdk.isDurableObjectCodeUpdateReset?.(error) === true;
      } catch {
        // Plain-node contexts (generators, tests) can't resolve the SDK —
        // classification stays task-failure there.
      }
    }
    await stub.applyAgentSessionResult(
      session.id,
      {
        status: "failed",
        result: error instanceof Error ? error.message : String(error),
        infraFailure,
      },
      actor.id
    );
    // The session row exists and is marked failed — carry its id on the
    // throw so callers that redispatch can still link retryOf on the
    // corpse (PILE-452). Without it a failed cold-dispatch left no visible
    // chain and the sweep retried invisibly every pass.
    if (error instanceof Error) {
      (error as { failedSessionId?: string }).failedSessionId = session.id;
    }
    throw error;
  }
}

/** The session row a failed dispatchAgent left behind, when it got far
 *  enough to create one. */
export function failedDispatchSessionId(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const id = (error as { failedSessionId?: unknown }).failedSessionId;
  return typeof id === "string" ? id : undefined;
}

/** Provider isolation switch — `config.disabled` on the workspace provider
 *  row lets an org pin agent work to one runtime (e.g. devin-cli) without
 *  deleting integrations. Read from the row's config JSON. */
function isProviderDisabled(configJson: string | null | undefined): boolean {
  if (!configJson) return false;
  try {
    const parsed: unknown = JSON.parse(configJson);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).disabled === true
    );
  } catch {
    return false;
  }
}
