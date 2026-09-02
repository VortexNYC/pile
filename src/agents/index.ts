import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import { DevinAgentProvider } from "./devin.js";
import type { AgentProvider, AgentSession } from "./provider.js";

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
  factory: (env: AppEnv) => AgentProvider,
) {
  providers[agentId] = factory;
}

export async function dispatchAgent(
  env: AppEnv,
  agentId: string,
  workspaceId: string,
  issue: { id: string; title: string; description: string | null },
): Promise<AgentSession> {
  const provider = getAgentProvider(agentId, env);
  const issueInput = {
    ...issue,
    workspaceId,
    status: "backlog" as const,
    priority: "medium" as const,
    assigneeId: null,
    projectId: null,
    cycleId: null,
    labelIds: null,
    repo: null,
    branch: null,
    prUrl: null,
    prState: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return provider.dispatch(workspaceId, issueInput);
}
