import type { InferSelectModel } from "drizzle-orm";
import { z } from "zod";

import type { AppEnv } from "../platform/env.js";
import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { Issue } from "../types/workspace.js";
import type { workspaceAgentSessions } from "../workspace/schema.js";
import { DevinAgentProvider } from "./devin.js";
import { CfAgentProvider } from "./cf-agent.js";
import { CursorAgentProvider } from "./cursor.js";
import { provisionOutpostWorker } from "./outpost.js";
import type { AgentProvider } from "./provider.js";

const providers: Record<string, (env: AppEnv) => AgentProvider> = {
  devin: (env) => new DevinAgentProvider(env),
  "cf-agent": (env) => new CfAgentProvider(env, "cf-agent"),
  cursor: (env) => new CursorAgentProvider(env),
  flue: (env) => new CfAgentProvider(env, "flue"),
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
  env: WorkerEnv,
  agentId: string,
  organizationId: string,
  issue: Issue,
  actor: WorkspaceIdentity,
  model?: string,
  ctx?: { waitUntil: (promise: Promise<unknown>) => void }
): Promise<InferSelectModel<typeof workspaceAgentSessions>> {
  const provider = getAgentProvider(agentId, env);
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
  await stub.setOrganizationId(organizationId);
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

  const providerSession = await provider.dispatch(
    organizationId,
    issue,
    model,
    { sessionId: session.id }
  );

  await stub.updateAgentSession(session.id, {
    status: z
      .enum([
        "created",
        "running",
        "waiting",
        "completed",
        "failed",
        "canceled",
      ])
      .parse(providerSession.status),
    result: providerSession.result ?? null,
    url: providerSession.url ?? null,
    providerSessionId: providerSession.id,
  });

  await stub.addAgentActivity({
    sessionId: session.id,
    type: "status",
    message: `Session created by ${actor.type} ${actor.id}`,
  });

  // Outpost provisioning is Devin-specific — only the Devin provider's
  // sessions can be claimed by `devin worker` on a compute sandbox.
  if (agentId === "devin" && providerSession.id) {
    const provision = provisionOutpostWorker(
      env,
      providerSession.id,
      organizationId,
      session.id
    ).catch((err) => console.error("outpost provisioning failed", err));
    if (ctx) ctx.waitUntil(provision);
    else await provision;
  }

  return session;
}
