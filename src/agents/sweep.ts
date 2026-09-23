import { createD1 } from "../global/db.js";
import { organization } from "../global/schema.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { AgentSession } from "../types/workspace.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import { decryptProviderConfigRow } from "./credentials.js";
import { resolveAgentEnv } from "./daytona.js";
import { dispatchAgent, getAgentProvider } from "./index.js";
import type { AgentProvider, AgentProviderState } from "./provider.js";

export const DEFAULT_TIMEOUT_MINUTES = 60;
export const DEFAULT_INACTIVITY_MINUTES = 20;

export function parseAgentTimeouts(configJson: string | null | undefined): {
  timeoutMinutes: number;
  inactivityMinutes: number;
} {
  let timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
  let inactivityMinutes = DEFAULT_INACTIVITY_MINUTES;
  if (!configJson) return { timeoutMinutes, inactivityMinutes };
  try {
    const parsed: unknown = JSON.parse(configJson);
    if (typeof parsed !== "object" || parsed === null) {
      return { timeoutMinutes, inactivityMinutes };
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
  } catch {
    /* invalid JSON — keep defaults */
  }
  return { timeoutMinutes, inactivityMinutes };
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
  provider: AgentProvider,
  result: string
): Promise<void> {
  const remoteId = session.providerSessionId ?? session.id;
  try {
    if (provider.cancel) await provider.cancel(remoteId);
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

const MAX_INFRA_RETRIES = 1;

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
  try {
    const issue = await stub.getIssue(session.issueId);
    if (!issue) return;
    const providerConfig = await decryptProviderConfigRow(
      env,
      await stub.getAgentProviderConfig(session.agentId)
    );
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
    console.error("agent session infra retry failed", {
      session: session.id,
      agentId: session.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function sweepAgentSessions(
  env: WorkerEnv,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<void> {
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
      if (sessions.length === 0) continue;
      for (const session of sessions) {
        const providerConfig = await decryptProviderConfigRow(
          env,
          await stub.getAgentProviderConfig(session.agentId)
        );
        const effectiveEnv = resolveAgentEnv(env, providerConfig ?? undefined);
        const { timeoutMinutes, inactivityMinutes } = parseAgentTimeouts(
          providerConfig?.config
        );
        const provider = getAgentProvider(session.agentId, effectiveEnv);
        const started = Date.parse(session.createdAt);
        if (
          Number.isFinite(started) &&
          now - started >= timeoutMinutes * 60 * 1000
        ) {
          await cancelSession(
            stub,
            session,
            provider,
            `session timed out after ${timeoutMinutes}m`
          );
          continue;
        }

        const remoteId = session.providerSessionId ?? session.id;
        let stillAlive = false;
        try {
          const polled = await provider.poll(remoteId);
          if (
            polled.status === "completed" ||
            polled.status === "failed" ||
            polled.status === "canceled"
          ) {
            await stub.applyAgentSessionResult(session.id, polled);
            if (polled.status === "failed" && polled.infraFailure) {
              await retryInfraSession(env, stub, id, session, ctx);
            }
            continue;
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

          if (
            !progressIsStale({
              now,
              createdAt: session.createdAt,
              lastProgressAt: session.lastProgressAt,
              inactivityMinutes,
            })
          ) {
            continue;
          }

          if (provider.getState) {
            const state = await provider.getState(remoteId, session.id);
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
          continue;
        }

        if (stillAlive) continue;
        await cancelSession(
          stub,
          session,
          provider,
          `session inactive for ${inactivityMinutes}m`
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
