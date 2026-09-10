import { getWorkspaceStub } from "../api/stub.js";
import { createD1 } from "../global/db.js";
import {
  createImportJob,
  updateImportJobStatus,
  type ImportJobRecord,
} from "../global/import-jobs.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type {
  ImportBatchResult,
  ImportContext,
  ImportCounts,
  ImportRunState,
  ImportSource,
} from "./types.js";

export async function createImportContext(
  env: WorkerEnv,
  organizationId: string,
  importerId: string,
  jobId: string
): Promise<ImportContext> {
  const stub = getWorkspaceStub(env, organizationId);
  await stub.setOrganizationId(organizationId);
  return {
    env,
    organizationId,
    importerId,
    jobId,
    db: createD1(env.D1),
    stub,
  };
}

export interface ImportRunResult {
  batch: ImportBatchResult;
  job: ImportJobRecord;
}

function mergeCounts(
  existing: ImportCounts | null,
  batch: ImportCounts
): ImportCounts {
  const merged: ImportCounts = existing ? { ...existing } : {};
  for (const [key, value] of Object.entries(batch)) {
    merged[key] = (merged[key] ?? 0) + value;
  }
  return merged;
}

function serializeCounts(counts: ImportCounts): string {
  return JSON.stringify(counts);
}

function parseCounts(json: string | null): ImportCounts | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ImportCounts;
  } catch {
    return null;
  }
}

export async function executeImportBatch<TCredentials, TOptions>(
  source: ImportSource<TCredentials, TOptions>,
  ctx: ImportContext,
  job: ImportJobRecord,
  credentials: TCredentials,
  options: TOptions,
  state?: ImportRunState
): Promise<ImportRunResult> {
  const validation = await source.validate(credentials);
  if (!validation.ok) {
    const result = { counts: { errors: 1 } };
    await updateImportJobStatus(ctx.db, job.id, "failed", {
      error: validation.error,
      counts: serializeCounts(result.counts),
      completedAt: new Date().toISOString(),
    });
    return { batch: result, job };
  }

  await updateImportJobStatus(ctx.db, job.id, "running");
  try {
    const batch = await source.run(ctx, credentials, options, {
      cursor: state?.cursor ?? job.cursor ?? undefined,
      limit: state?.limit,
    });

    const existing = parseCounts(job.counts);
    const merged = mergeCounts(existing, batch.counts);

    if (batch.nextCursor !== undefined && batch.nextCursor !== null) {
      const updated = await updateImportJobStatus(ctx.db, job.id, "paused", {
        cursor: batch.nextCursor,
        counts: serializeCounts(merged),
      });
      return { batch, job: updated as ImportJobRecord };
    }

    const updated = await updateImportJobStatus(ctx.db, job.id, "completed", {
      counts: serializeCounts(merged),
      completedAt: new Date().toISOString(),
      cursor: null,
    });
    return { batch, job: updated as ImportJobRecord };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const existing = parseCounts(job.counts);
    const merged = mergeCounts(existing, { errors: 1 });
    const updated = await updateImportJobStatus(ctx.db, job.id, "failed", {
      error: message,
      counts: serializeCounts(merged),
      completedAt: new Date().toISOString(),
    });
    return { batch: { counts: merged }, job: updated as ImportJobRecord };
  }
}

export async function runImport<TCredentials, TOptions>(
  source: ImportSource<TCredentials, TOptions>,
  env: WorkerEnv,
  organizationId: string,
  importerId: string,
  credentials: TCredentials,
  options: TOptions,
  state?: ImportRunState
): Promise<ImportRunResult> {
  const db = createD1(env.D1);
  const job = await createImportJob(db, organizationId, source.name, options);
  const ctx = await createImportContext(
    env,
    organizationId,
    importerId,
    job.id
  );
  return executeImportBatch(source, ctx, job, credentials, options, state);
}

export async function resumeImport<TCredentials, TOptions>(
  source: ImportSource<TCredentials, TOptions>,
  env: WorkerEnv,
  organizationId: string,
  importerId: string,
  job: ImportJobRecord,
  credentials: TCredentials,
  options: TOptions,
  state?: ImportRunState
): Promise<ImportRunResult> {
  const ctx = await createImportContext(
    env,
    organizationId,
    importerId,
    job.id
  );
  return executeImportBatch(source, ctx, job, credentials, options, state);
}
