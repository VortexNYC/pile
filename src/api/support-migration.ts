import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { findImportJob, updateImportJobStatus } from "../global/import-jobs.js";
import {
  supportMigrationRunBodySchema,
  supportMigrationValidateBodySchema,
} from "../global/support-migration.js";
import { resumeImport, runImport } from "../import/runner.js";
import type { ImportCounts } from "../import/types.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import {
  intercomSupportImportSource,
  plainSupportImportSource,
  zendeskSupportImportSource,
} from "../support-migration/index.js";

const importIdParam = z.object({
  organizationId: z.string(),
  importId: z.string(),
});

const importRunOutputSchema = z.object({
  ok: z.boolean(),
  source: z.string(),
  jobId: z.string(),
  status: z.string(),
  counts: z.record(z.string(), z.number()).optional(),
  nextCursor: z.string().optional(),
});

const importJobOutputSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  source: z.string(),
  status: z.string(),
  options: z.record(z.string(), z.unknown()).optional(),
  counts: z.record(z.string(), z.number()).optional(),
  cursor: z.string().optional(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});

const validateOutputSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

const startImportRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/imports",
  tags: ["support-migration"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: supportMigrationRunBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Import started",
      content: {
        "application/json": { schema: importRunOutputSchema },
      },
    },
  },
});

const getImportRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/imports/{importId}",
  tags: ["support-migration"],
  middleware: [rls("read")],
  request: {
    params: importIdParam,
  },
  responses: {
    200: {
      description: "Import status",
      content: {
        "application/json": { schema: importJobOutputSchema },
      },
    },
    404: {
      description: "Import not found",
    },
  },
});

const resumeImportRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/imports/{importId}/resume",
  tags: ["support-migration"],
  middleware: [rls("write")],
  request: {
    params: importIdParam,
    body: {
      content: {
        "application/json": { schema: supportMigrationRunBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Import resumed",
      content: {
        "application/json": { schema: importRunOutputSchema },
      },
    },
    404: {
      description: "Import not found",
    },
  },
});

const cancelImportRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/imports/{importId}/cancel",
  tags: ["support-migration"],
  middleware: [rls("write")],
  request: {
    params: importIdParam,
  },
  responses: {
    200: {
      description: "Import canceled",
      content: {
        "application/json": {
          schema: z.object({ id: z.string(), status: z.string() }),
        },
      },
    },
    404: {
      description: "Import not found",
    },
  },
});

const validateImportRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/support/imports/validate",
  tags: ["support-migration"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: supportMigrationValidateBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Validation result",
      content: {
        "application/json": { schema: validateOutputSchema },
      },
    },
  },
});

function importRunOutput(
  source: string,
  job: { id: string; status: string },
  batch: { counts: ImportCounts; nextCursor?: string | null }
) {
  return {
    ok: true,
    source,
    jobId: job.id,
    status: job.status,
    counts: batch.counts,
    nextCursor: batch.nextCursor ?? undefined,
  };
}

function jobOutput(job: {
  id: string;
  organizationId: string;
  source: string;
  status: string;
  options: string | null;
  counts: string | null;
  cursor: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}) {
  return {
    id: job.id,
    organizationId: job.organizationId,
    source: job.source,
    status: job.status,
    options: job.options
      ? (JSON.parse(job.options) as Record<string, unknown>)
      : undefined,
    counts: job.counts
      ? (JSON.parse(job.counts) as Record<string, number>)
      : undefined,
    cursor: job.cursor ?? undefined,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

export function registerSupportMigrationRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(startImportRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const importerId = c.var.userId ?? c.var.workspaceIdentity?.id ?? "unknown";

    switch (body.source) {
      case "intercom": {
        const { batch, job } = await runImport(
          intercomSupportImportSource,
          c.env,
          c.req.raw.headers,
          organizationId,
          importerId,
          body.credentials,
          body.options ?? {}
        );
        return c.json(importRunOutput(body.source, job, batch));
      }
      case "plain": {
        const { batch, job } = await runImport(
          plainSupportImportSource,
          c.env,
          c.req.raw.headers,
          organizationId,
          importerId,
          body.credentials,
          body.options ?? {}
        );
        return c.json(importRunOutput(body.source, job, batch));
      }
      case "zendesk": {
        const { batch, job } = await runImport(
          zendeskSupportImportSource,
          c.env,
          c.req.raw.headers,
          organizationId,
          importerId,
          body.credentials,
          body.options ?? {}
        );
        return c.json(importRunOutput(body.source, job, batch));
      }
    }
  });

  app.openapi(getImportRoute, async (c) => {
    const { organizationId, importId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const job = await findImportJob(db, organizationId, importId);
    if (!job) {
      return c.json({ error: "Import not found" }, 404);
    }
    return c.json(jobOutput(job));
  });

  app.openapi(resumeImportRoute, async (c) => {
    const { organizationId, importId } = c.req.valid("param");
    const body = c.req.valid("json");
    const importerId = c.var.userId ?? c.var.workspaceIdentity?.id ?? "unknown";

    const db = createD1(c.env.D1);
    const existing = await findImportJob(db, organizationId, importId);
    if (!existing) {
      return c.json({ error: "Import not found" }, 404);
    }

    switch (body.source) {
      case "intercom": {
        const { batch, job } = await resumeImport(
          intercomSupportImportSource,
          c.env,
          c.req.raw.headers,
          organizationId,
          importerId,
          existing,
          body.credentials,
          body.options ?? {}
        );
        return c.json(importRunOutput(body.source, job, batch));
      }
      case "plain": {
        const { batch, job } = await resumeImport(
          plainSupportImportSource,
          c.env,
          c.req.raw.headers,
          organizationId,
          importerId,
          existing,
          body.credentials,
          body.options ?? {}
        );
        return c.json(importRunOutput(body.source, job, batch));
      }
      case "zendesk": {
        const { batch, job } = await resumeImport(
          zendeskSupportImportSource,
          c.env,
          c.req.raw.headers,
          organizationId,
          importerId,
          existing,
          body.credentials,
          body.options ?? {}
        );
        return c.json(importRunOutput(body.source, job, batch));
      }
    }
  });

  app.openapi(cancelImportRoute, async (c) => {
    const { organizationId, importId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const job = await findImportJob(db, organizationId, importId);
    if (!job) {
      return c.json({ error: "Import not found" }, 404);
    }

    await updateImportJobStatus(db, importId, "failed", {
      error: "canceled",
    });
    return c.json({ id: importId, status: "failed" });
  });

  app.openapi(validateImportRoute, async (c) => {
    const body = c.req.valid("json");

    let validation;
    switch (body.source) {
      case "intercom":
        validation = await intercomSupportImportSource.validate(
          body.credentials
        );
        break;
      case "plain":
        validation = await plainSupportImportSource.validate(body.credentials);
        break;
      case "zendesk":
        validation = await zendeskSupportImportSource.validate(
          body.credentials
        );
        break;
    }

    let error: string | undefined;
    if (!validation.ok) {
      error = validation.error;
    }

    return c.json({ ok: validation.ok, error });
  });
}
