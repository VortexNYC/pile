import type { WorkerEnv } from "../platform/middleware.js";

export function getWorkspaceStub(env: WorkerEnv, organizationId: string) {
  return env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
}

// Issue references may be the internal UUID or the human identifier
// (`ISS-123`) — agent callers know the identifier, not the internal id.
// Resolves to the canonical UUID, passing the ref through when nothing
// matches so callers keep their existing not-found semantics.
export async function resolveIssueRef(
  stub: ReturnType<typeof getWorkspaceStub>,
  ref: string
): Promise<string> {
  return (await stub.getIssue(ref))?.id ?? ref;
}
