import { getWorkspaceStub } from "../api/stub.js";
import { createD1 } from "../global/db.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { ImportContext, ImportCounts, ImportSource } from "./types.js";

export async function createImportContext(
  env: WorkerEnv,
  organizationId: string,
  importerId: string
): Promise<ImportContext> {
  const stub = getWorkspaceStub(env, organizationId);
  await stub.setOrganizationId(organizationId);
  return {
    env,
    organizationId,
    importerId,
    db: createD1(env.D1),
    stub,
  };
}

export async function runImport<TCredentials, TOptions>(
  source: ImportSource<TCredentials, TOptions>,
  ctx: ImportContext,
  credentials: TCredentials,
  options: TOptions
): Promise<ImportCounts> {
  const validation = await source.validate(credentials);
  if (!validation.ok) {
    return { errors: 1 };
  }
  const counts = await source.run(ctx, credentials, options);
  return {
    errors: 0,
    ...counts,
  };
}
