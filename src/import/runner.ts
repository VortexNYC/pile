import { getWorkspaceStub } from "../api/stub.js";
import { createD1 } from "../global/db.js";
import {
  createImportJob,
  updateImportJobStatus,
  type ImportJobRecord,
} from "../global/import-jobs.js";
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

export interface ImportRunResult {
  counts: ImportCounts;
  job: ImportJobRecord;
}

export async function runImport<TCredentials, TOptions>(
  source: ImportSource<TCredentials, TOptions>,
  ctx: ImportContext,
  credentials: TCredentials,
  options: TOptions
): Promise<ImportRunResult> {
  const validation = await source.validate(credentials);
  const job = await createImportJob(
    ctx.db,
    ctx.organizationId,
    source.name,
    options
  );
  if (!validation.ok) {
    await updateImportJobStatus(ctx.db, job.id, "failed", {
      error: validation.error,
      completedAt: new Date().toISOString(),
    });
    return {
      counts: { errors: 1 },
      job,
    };
  }

  await updateImportJobStatus(ctx.db, job.id, "running");
  try {
    const counts = await source.run(ctx, credentials, options);
    const result = { errors: 0, ...counts };
    await updateImportJobStatus(ctx.db, job.id, "completed", {
      counts: JSON.stringify(result),
      completedAt: new Date().toISOString(),
    });
    return { counts: result, job };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateImportJobStatus(ctx.db, job.id, "failed", {
      error: message,
      completedAt: new Date().toISOString(),
    });
    return {
      counts: { errors: 1 },
      job,
    };
  }
}
