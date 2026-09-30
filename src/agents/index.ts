import { eq } from "drizzle-orm";
import { z } from "zod";

import { createD1 } from "../global/db.js";
import { organization } from "../global/schema.js";
import { createAuth } from "../platform/auth.js";
import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { WorkerEnv } from "../platform/middleware.js";
import {
  DEFAULT_GIT_IDENTITY_REPO,
  type AgentSession,
  type Issue,
} from "../types/workspace.js";
import { CfAgentProvider } from "./cf-agent.js";
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
import {
  getLaneDbProvider,
  laneDbConfigForRepo,
  type LaneDbConfig,
} from "./lane-db.js";
import type { AgentProvider } from "./provider.js";

// Workspace-wide ceiling on live lanes — the container apps are bounded
// (max_instances) and one lane's provisioning wedge otherwise starves all.
const MAX_ACTIVE_LANES_PER_WORKSPACE = 25;

const providers: Record<string, (env: WorkerEnv) => AgentProvider> = {
  devin: (env) => new DevinAgentProvider(env),
  codex: (env) => new CodexAgentProvider(env),
  "codex-cli": (env) => new CodexCliAgentProvider(env),
  "devin-cli": (env) => new DevinCliAgentProvider(env),
  "cursor-cli": (env) => new CursorCliAgentProvider(env),
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
  }
): Promise<AgentSession> {
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
  const provider = getAgentProvider(
    agentId,
    resolveAgentEnv(env, providerConfig ?? undefined)
  );

  const gitIdentity = issue.repo
    ? ((await stub.getGitIdentityByRepo(issue.repo)) ??
      (await stub.getGitIdentityByRepo(DEFAULT_GIT_IDENTITY_REPO)) ??
      null)
    : null;

  const active = await stub.getActiveAgentSessionForIssue(issue.id);
  if (active && active.session.id !== options?.promoteSessionId) {
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
    const promoted = await stub.getAgentSession(options.promoteSessionId);
    if (!promoted || promoted.status !== "waiting") {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Queued session not found or no longer waiting",
      });
    }
    session =
      (await stub.updateAgentSession(promoted.id, {
        status: "created",
        queuedAfter: null,
      })) ?? promoted;
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
    });
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
    message: `Dispatching to ${agentId}…`,
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
          message: `Pile API credential mint failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        .catch(() => {});
    }

    const providerSession = await provider.dispatch(
      organizationId,
      issue,
      model,
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
        instructions: options?.instructions,
        extraEnv,
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
    await stub.applyAgentSessionResult(
      session.id,
      {
        status: "failed",
        result: error instanceof Error ? error.message : String(error),
      },
      actor.id
    );
    throw error;
  }
}
