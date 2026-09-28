import { createD1 } from "../global/db.js";
import { getInstallationTokenForRepo } from "../global/github-auth.js";
import { scrubCaptureText } from "../global/redact.js";
import { organization } from "../global/schema.js";
import { processIncomingMessage } from "../global/support-channels.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { AgentSession } from "../types/workspace.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";
import { loadProviderConfig } from "./credentials.js";
import { resolveAgentEnv } from "./daytona.js";
import { dispatchAgent, getAgentProvider } from "./index.js";
import type {
  AgentProvider,
  AgentProviderSession,
  AgentProviderState,
} from "./provider.js";

export const DEFAULT_TIMEOUT_MINUTES = 60;
export const DEFAULT_INACTIVITY_MINUTES = 20;
export const DEFAULT_PROVISION_TIMEOUT_MINUTES = 30;
// A provider call that hangs must never stall the whole org's sweep — the
// loop is serial, so one wedged sandbox otherwise starves every session.
const DEFAULT_PROBE_TIMEOUT_MS = 90_000;

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
  provider: AgentProvider,
  result: string,
  probeTimeoutMs: number
): Promise<void> {
  const remoteId = session.providerSessionId ?? session.id;
  try {
    if (provider.cancel)
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
    console.error("agent session infra retry failed", {
      session: session.id,
      agentId: session.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
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
      if (sessions.length === 0) continue;
      for (const session of sessions) {
        const providerConfig = await loadProviderConfig(
          env,
          stub,
          session.agentId
        );
        const effectiveEnv = resolveAgentEnv(env, providerConfig ?? undefined);
        const { timeoutMinutes, inactivityMinutes, provisionTimeoutMinutes } =
          parseAgentTimeouts(providerConfig?.config);
        const provider = getAgentProvider(session.agentId, effectiveEnv);
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
          const provisionFailure: AgentProviderSession = {
            id: session.id,
            agentId: session.agentId,
            status: "failed",
            result: `provision timed out after ${provisionTimeoutMinutes}m (runner never started)`,
            infraFailure: true,
          };
          await stub.applyAgentSessionResult(session.id, provisionFailure);
          await ingestFailedAgentSession(env, id, session, provisionFailure);
          await retryInfraSession(env, stub, id, session, ctx);
          continue;
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
          continue;
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
            if (polled.status === "failed") {
              await ingestFailedAgentSession(env, id, session, polled);
              if (polled.infraFailure) {
                await retryInfraSession(env, stub, id, session, ctx);
              }
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
            continue;
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
          continue;
        }

        if (stillAlive) continue;
        await cancelSession(
          stub,
          session,
          provider,
          `session inactive for ${inactivityMinutes}m`,
          probeTimeoutMs
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

      let checkState: string | null = null;
      const head = pr.head as Record<string, unknown> | undefined;
      if (typeof head?.sha === "string") {
        const checks = (await withTimeout(
          githubApiGet(
            ghFetch,
            token,
            `/repos/${owner}/${repo}/commits/${head.sha}/check-runs?per_page=100`
          ),
          probeTimeoutMs,
          "github-checks"
        )) as {
          check_runs?: Array<{ status?: string; conclusion?: string | null }>;
        };
        checkState = summarizeCheckRuns(checks.check_runs);
      }

      if (state !== session.prState) {
        await stub.updateAgentSession(session.id, { prState: state });
      }
      const issue = await stub.getIssue(session.issueId);
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
