import type { WorkerEnv } from "./middleware.js";

export function getWorkspaceStub(env: WorkerEnv, organizationId: string) {
  return env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
}
