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
  DEFAULT_GIT_IDENTITY_REPO,
  type AgentSession,
  type Issue,
} from "../types/workspace.js";
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
import { computeBackend } from "./compute.js";
import { loadProviderConfig } from "./credentials.js";
import { CursorCliAgentProvider } from "./cursor-cli.js";
import { CursorAgentProvider } from "./cursor.js";
import { resolveAgentEnv } from "./daytona.js";
import { checkDispatchDedupe, type DedupeResult } from "./dedupe.js";
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
  if (!options?.promoteSessionId) {
    const dedupe = await checkDispatchDedupe(env, stub, issue).catch((err) => {
      dedupeError = err instanceof Error ? err.message : String(err);
      return null;
    });
    if (dedupe?.hardBlock) {
      throw new VortexError({
        code: "CONFLICT",
        status: 409,
        message: dedupe.hardBlock.reason,
      });
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
      return queued;
    }
    // PILE-420 — the agent type is paused workspace-wide: the dispatch is
    // accepted but held, parked `waiting` + `paused`. Resume drains holds
    // in order; a dedupe edge rides along so a held lane still joins its
    // queue chain after release.
    let pause = await stub.getAgentPause(agentId);
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
    if (pause) {
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
      return parked;
    }
    // Workspace-wide lane ceiling for container-backed lanes — the CF
    // container apps are bounded (max_instances) and an uncapped queue of
    // concurrent lanes wedges provisioning for everyone. Promote is exempt:
    // it moves a parked lane. Daytona lanes are provider-quota bound, not ours.
    const liveCount = (await stub.listAgentSessions({ limit: 200 })).filter(
      (s) => !["completed", "failed", "canceled"].includes(s.status)
    ).length;
    if (
      liveCount >= MAX_ACTIVE_LANES_PER_WORKSPACE &&
      computeBackend(env, agentId).kind === "cloudflare"
    ) {
      throw new VortexError({
        code: "CONFLICT",
        status: 409,
        message: `Workspace has ${liveCount} active agent sessions (max ${MAX_ACTIVE_LANES_PER_WORKSPACE}) — wait for lanes to finish`,
      });
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
  if (issue.repo && !session.laneDbRef) {
    const laneConfig = await laneDbConfigForOrgRepo(
      env,
      organizationId,
      issue.repo
    );
    if (laneConfig) {
      const laneProvider = getLaneDbProvider(env);
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
          ? (
              await stub.getAgentSessionByConversationKey(
                options.conversationKey
              )
            )?.providerSessionId ?? undefined
          : undefined,
        instructions:
          [
            guidanceText,
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
    // reset, compute I/O timeout) is infra-class — it gets the retry path
    // and feeds the fleet breaker, not the task-failure trail.
    let infraFailure = false;
    if (
      error instanceof VortexError &&
      (error.status === 503 || error.status === 504)
    ) {
      infraFailure = true;
    } else {
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
    throw error;
  }
}
