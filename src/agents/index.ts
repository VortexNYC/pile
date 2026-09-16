import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { AgentSession, Issue } from "../types/workspace.js";
import { CfAgentProvider } from "./cf-agent.js";
import { CodexCliAgentProvider } from "./codex-cli.js";
import { CodexAgentProvider } from "./codex.js";
import { CursorAgentProvider } from "./cursor.js";
import { DevinAgentProvider } from "./devin.js";
import type { AgentProvider } from "./provider.js";

const providers: Record<string, (env: WorkerEnv) => AgentProvider> = {
  devin: (env) => new DevinAgentProvider(env),
  codex: (env) => new CodexAgentProvider(env),
  "codex-cli": (env) => new CodexCliAgentProvider(env),
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

export async function dispatchAgent(
  env: WorkerEnv,
  agentId: string,
  organizationId: string,
  issue: Issue,
  actor: WorkspaceIdentity,
  model?: string,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<AgentSession> {
  const provider = getAgentProvider(agentId, env);
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
  await stub.setOrganizationId(organizationId);

  const providerConfig = await stub.getAgentProviderConfig(agentId);
  const allowedTeamIds = parseAgentProviderTeamIds(providerConfig?.teamIds);
  if (allowedTeamIds && !allowedTeamIds.includes(issue.teamId)) {
    throw new VortexError({
      code: "FORBIDDEN",
      status: 403,
      message: `Agent provider ${agentId} is not enabled for this team`,
    });
  }

  const gitIdentity = issue.repo
    ? ((await stub.getGitIdentityByRepo(issue.repo)) ?? null)
    : null;

  const active = await stub.getActiveAgentSessionForIssue(issue.id);
  if (active) {
    throw new VortexError({
      code: "CONFLICT",
      status: 409,
      message: `An active agent session (${active.session.id}) already exists for this issue`,
    });
  }

  const session = await stub.createAgentSession({
    issueId: issue.id,
    agentId,
    provider: agentId,
    actorId: actor.id,
    actorType: actor.type,
    status: "created",
    result: null,
    url: null,
  });

  await stub.addAgentActivity({
    sessionId: session.id,
    actorId: actor.id,
    type: "thought",
    message: `Dispatching to ${agentId}…`,
  });

  try {
    const providerSession = await provider.dispatch(
      organizationId,
      issue,
      model,
      { sessionId: session.id, gitIdentity, waitUntil: ctx?.waitUntil }
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
