import {
  addAgentActivity,
  createAgentSession,
  type AgentSession,
} from "../global/agent-sessions.js";
import { createD1 } from "../global/db.js";
import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { Issue } from "../types/workspace.js";
import { DevinAgentProvider } from "./devin.js";
import type { AgentProvider } from "./provider.js";

const providers: Record<string, (env: AppEnv) => AgentProvider> = {
  devin: (env) => new DevinAgentProvider(env),
};

export function getAgentProvider(agentId: string, env: AppEnv): AgentProvider {
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
  factory: (env: AppEnv) => AgentProvider
) {
  providers[agentId] = factory;
}

export async function dispatchAgent(
  env: AppEnv,
  agentId: string,
  organizationId: string,
  issue: {
    id: string;
    teamId: string;
    title: string;
    description: string | null;
  },
  actor: WorkspaceIdentity,
  model?: string
): Promise<AgentSession> {
  const provider = getAgentProvider(agentId, env);
  const issueInput: Issue = {
    ...issue,
    organizationId,
    status: "backlog",
    priority: "medium",
    resolution: null,
    parentId: null,
    subIssueSortOrder: null,
    assigneeId: null,
    projectId: null,
    cycleId: null,
    labelIds: null,
    number: null,
    identifier: null,
    repo: null,
    branch: null,
    prUrl: null,
    prState: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const providerSession = await provider.dispatch(
    organizationId,
    issueInput,
    model
  );

  const db = createD1(env.D1);
  const session = await createAgentSession(db, {
    organizationId,
    issueId: issue.id,
    agentId: providerSession.agentId,
    provider: agentId,
    actorId: actor.id,
    actorType: actor.type,
    status: providerSession.status as AgentSession["status"],
    result: providerSession.result ?? null,
    url: providerSession.url ?? null,
  });

  await addAgentActivity(db, {
    sessionId: session.id,
    type: "status",
    message: `Session created by ${actor.type} ${actor.id}`,
  });

  return session;
}
