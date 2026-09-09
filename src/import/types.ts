import type { D1Client } from "../global/db.js";
import type { WorkerEnv } from "../platform/middleware.js";
import type { WorkspaceDO } from "../workspace/durable-object.js";

export interface ImportContext {
  env: WorkerEnv;
  organizationId: string;
  importerId: string;
  db: D1Client;
  stub: DurableObjectStub<WorkspaceDO>;
}

export interface ImportRunState {
  cursor?: string;
  limit?: number;
}

export type ImportValidationResult =
  | { ok: true }
  | { ok: false; error: string };

export type ImportCounts = Record<string, number>;

export interface ImportBatchResult {
  counts: ImportCounts;
  nextCursor?: string | null;
}

export interface ImportSource<TCredentials, TOptions = unknown> {
  name: string;
  validate(
    credentials: TCredentials
  ): Promise<ImportValidationResult> | ImportValidationResult;
  run(
    ctx: ImportContext,
    credentials: TCredentials,
    options: TOptions,
    state?: ImportRunState
  ): Promise<ImportBatchResult>;
}
