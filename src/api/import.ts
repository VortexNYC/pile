import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import {
  createImportApproval,
  findImportApprovalByJobId,
  updateImportApprovalStatus,
} from "../global/import-approvals.js";
import {
  createImportJob,
  findImportJob,
  updateImportJobStatus,
  type ImportJobRecord,
} from "../global/import-jobs.js";
import {
  confluenceCredentialsSchema,
  confluenceImportSource,
  confluenceOptionsSchema,
} from "../import/confluence.js";
import {
  githubIssuesCredentialsSchema,
  githubIssuesImportSource,
  githubIssuesOptionsSchema,
} from "../import/github-issues.js";
import {
  intercomSupportCredentialsSchema,
  intercomSupportImportSource,
  intercomSupportOptionsSchema,
} from "../import/intercom-support.js";
import {
  intercomCredentialsSchema,
  intercomImportSource,
  intercomOptionsSchema,
} from "../import/intercom.js";
import {
  jiraCredentialsSchema,
  jiraImportSource,
  jiraOptionsSchema,
} from "../import/jira.js";
import {
  linearCredentialsSchema,
  linearImportSource,
  linearOptionsSchema,
} from "../import/linear.js";
import {
  notionCredentialsSchema,
  notionImportSource,
  notionOptionsSchema,
} from "../import/notion.js";
import { resumeImport, runImport } from "../import/runner.js";
import type { ImportCounts, ImportRunState } from "../import/types.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const importBodySchema = z.object({
  source: z.enum([
    "jira",
    "confluence",
    "linear",
    "notion",
    "github-issues",
    "intercom",
    "intercom-support",
  ]),
  credentials: z.unknown(),
  options: z.unknown().optional(),
});

const baseImportOptionsSchema = z.object({
  approvalRequired: z.boolean().optional(),
  limit: z.number().int().min(1).optional(),
  cursor: z.string().optional(),
});

const importResponseSchema = z.object({
  ok: z.boolean(),
  source: z.string(),
  jobId: z.string(),
  status: z.string(),
  counts: z.record(z.string(), z.number()).optional(),
  nextCursor: z.string().optional(),
});

const resumeBodySchema = z.object({
  credentials: z.unknown(),
  limit: z.number().int().min(1).optional(),
});

function parseBaseOptions(options: unknown) {
  return baseImportOptionsSchema.parse(options ?? {});
}

function parseJobCounts(
  countsJson: string | null
): Record<string, number> | undefined {
  if (!countsJson) return undefined;
  const parsed = z
    .record(z.string(), z.number())
    .safeParse(JSON.parse(countsJson));
  return parsed.success ? parsed.data : undefined;
}

async function createApprovalJob(
  db: ReturnType<typeof createD1>,
  organizationId: string,
  source: string,
  options: unknown,
  requestedBy: string
): Promise<ImportJobRecord> {
  const job = await createImportJob(db, organizationId, source, options);
  await updateImportJobStatus(db, job.id, "pending_approval");
  await createImportApproval(db, organizationId, job.id, requestedBy);
  const updated = await findImportJob(db, organizationId, job.id);
  if (!updated) {
    throw new Error("Failed to create approval job");
  }
  return updated as ImportJobRecord;
}

const importRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/import",
  tags: ["import"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: importBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Import started or awaiting approval",
      content: {
        "application/json": {
          schema: importResponseSchema,
        },
      },
    },
  },
});

const importJobStatusRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/import/{jobId}",
  tags: ["import"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string(), jobId: z.string() }),
  },
  responses: {
    200: {
      description: "Import job status",
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            source: z.string(),
            status: z.string(),
            counts: z.record(z.string(), z.number()).optional(),
            error: z.string().optional(),
            approval: z
              .object({
                status: z.string(),
                approvedBy: z.string().optional(),
              })
              .optional(),
          }),
        },
      },
    },
    404: {
      description: "Import job not found",
    },
  },
});

const importResumeRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/import/{jobId}/resume",
  tags: ["import"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string(), jobId: z.string() }),
    body: {
      content: {
        "application/json": { schema: resumeBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Import batch resumed",
      content: {
        "application/json": {
          schema: importResponseSchema,
        },
      },
    },
    404: {
      description: "Import job not found",
    },
    409: {
      description: "Import job is not resumable",
    },
  },
});

const importApproveRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/import/{jobId}/approve",
  tags: ["import"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string(), jobId: z.string() }),
  },
  responses: {
    200: {
      description: "Import approved",
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), jobId: z.string() }),
        },
      },
    },
    404: {
      description: "Import job not found",
    },
  },
});

const importRejectRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/import/{jobId}/reject",
  tags: ["import"],
  middleware: [rls("admin")],
  request: {
    params: z.object({ organizationId: z.string(), jobId: z.string() }),
  },
  responses: {
    200: {
      description: "Import rejected",
      content: {
        "application/json": {
          schema: z.object({ ok: z.boolean(), jobId: z.string() }),
        },
      },
    },
    404: {
      description: "Import job not found",
    },
  },
});

interface ImportRunOutput {
  ok: boolean;
  source: string;
  jobId: string;
  status: string;
  counts?: ImportCounts;
  nextCursor?: string;
}

function importRunOutput(
  source: string,
  job: ImportJobRecord,
  batch: { counts: ImportCounts; nextCursor?: string | null }
): ImportRunOutput {
  return {
    ok: true,
    source,
    jobId: job.id,
    status: job.status,
    counts: parseJobCounts(job.counts) ?? batch.counts,
    nextCursor: batch.nextCursor ?? undefined,
  };
}

export function registerImportRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(importRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);
    const baseOptions = parseBaseOptions(body.options);
    const importerId = c.var.userId ?? c.var.workspaceIdentity.id ?? "unknown";

    if (baseOptions.approvalRequired) {
      const job = await createApprovalJob(
        db,
        organizationId,
        body.source,
        body.options,
        importerId
      );
      return c.json(
        {
          ok: true,
          source: body.source,
          jobId: job.id,
          status: job.status,
        },
        200
      );
    }

    const state: ImportRunState = {
      limit: baseOptions.limit,
      cursor: baseOptions.cursor,
    };

    let output: ImportRunOutput;
    switch (body.source) {
      case "jira": {
        const credentials = jiraCredentialsSchema.parse(body.credentials);
        const options = jiraOptionsSchema.parse(body.options ?? {});
        const { batch, job } = await runImport(
          jiraImportSource,
          c.env,
          organizationId,
          importerId,
          credentials,
          options,
          state
        );
        output = importRunOutput(body.source, job, batch);
        break;
      }
      case "confluence": {
        const credentials = confluenceCredentialsSchema.parse(body.credentials);
        const options = confluenceOptionsSchema.parse(body.options ?? {});
        const { batch, job } = await runImport(
          confluenceImportSource,
          c.env,
          organizationId,
          importerId,
          credentials,
          options,
          state
        );
        output = importRunOutput(body.source, job, batch);
        break;
      }
      case "linear": {
        const credentials = linearCredentialsSchema.parse(body.credentials);
        const options = linearOptionsSchema.parse(body.options ?? {});
        const { batch, job } = await runImport(
          linearImportSource,
          c.env,
          organizationId,
          importerId,
          credentials,
          options,
          state
        );
        output = importRunOutput(body.source, job, batch);
        break;
      }
      case "notion": {
        const credentials = notionCredentialsSchema.parse(body.credentials);
        const options = notionOptionsSchema.parse(body.options ?? {});
        const { batch, job } = await runImport(
          notionImportSource,
          c.env,
          organizationId,
          importerId,
          credentials,
          options,
          state
        );
        output = importRunOutput(body.source, job, batch);
        break;
      }
      case "github-issues": {
        const credentials = githubIssuesCredentialsSchema.parse(
          body.credentials
        );
        const options = githubIssuesOptionsSchema.parse(body.options ?? {});
        const { batch, job } = await runImport(
          githubIssuesImportSource,
          c.env,
          organizationId,
          importerId,
          credentials,
          options,
          state
        );
        output = importRunOutput(body.source, job, batch);
        break;
      }
      case "intercom": {
        const credentials = intercomCredentialsSchema.parse(body.credentials);
        const options = intercomOptionsSchema.parse(body.options ?? {});
        const { batch, job } = await runImport(
          intercomImportSource,
          c.env,
          organizationId,
          importerId,
          credentials,
          options,
          state
        );
        output = importRunOutput(body.source, job, batch);
        break;
      }
      case "intercom-support": {
        const credentials = intercomSupportCredentialsSchema.parse(
          body.credentials
        );
        const options = intercomSupportOptionsSchema.parse(body.options ?? {});
        const { batch, job } = await runImport(
          intercomSupportImportSource,
          c.env,
          organizationId,
          importerId,
          credentials,
          options,
          state
        );
        output = importRunOutput(body.source, job, batch);
        break;
      }
      default: {
        const exhaustive: never = body.source;
        throw new Error(`Unsupported import source: ${String(exhaustive)}`);
      }
    }

    return c.json(output, 200);
  });

  app.openapi(importJobStatusRoute, async (c) => {
    const { organizationId, jobId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const job = await findImportJob(db, organizationId, jobId);
    if (!job) {
      return c.json({ error: "Import job not found" }, 404);
    }
    const approval = await findImportApprovalByJobId(db, jobId);
    return c.json({
      id: job.id,
      source: job.source,
      status: job.status,
      counts: parseJobCounts(job.counts),
      error: job.error ?? undefined,
      approval: approval
        ? {
            status: approval.status,
            approvedBy: approval.approvedBy ?? undefined,
          }
        : undefined,
    });
  });

  app.openapi(importResumeRoute, async (c) => {
    const { organizationId, jobId } = c.req.valid("param");
    const resumeBody = c.req.valid("json");
    const db = createD1(c.env.D1);
    const importerId = c.var.userId ?? c.var.workspaceIdentity.id ?? "unknown";
    const job = await findImportJob(db, organizationId, jobId);
    if (!job) {
      return c.json({ error: "Import job not found" }, 404);
    }
    if (job.status === "pending_approval") {
      return c.json({ error: "Import requires approval first" }, 409);
    }
    if (job.status === "completed" || job.status === "failed") {
      return c.json({ error: "Import job is already terminal" }, 409);
    }

    const options = job.options ? JSON.parse(job.options) : {};
    const state: ImportRunState = {
      cursor: job.cursor ?? undefined,
      limit: resumeBody.limit,
    };

    let output: ImportRunOutput;
    switch (job.source) {
      case "jira": {
        const credentials = jiraCredentialsSchema.parse(resumeBody.credentials);
        const parsedOptions = jiraOptionsSchema.parse(options ?? {});
        const { batch, job: updatedJob } = await resumeImport(
          jiraImportSource,
          c.env,
          organizationId,
          importerId,
          job,
          credentials,
          parsedOptions,
          state
        );
        output = importRunOutput(job.source, updatedJob, batch);
        break;
      }
      case "confluence": {
        const credentials = confluenceCredentialsSchema.parse(
          resumeBody.credentials
        );
        const parsedOptions = confluenceOptionsSchema.parse(options ?? {});
        const { batch, job: updatedJob } = await resumeImport(
          confluenceImportSource,
          c.env,
          organizationId,
          importerId,
          job,
          credentials,
          parsedOptions,
          state
        );
        output = importRunOutput(job.source, updatedJob, batch);
        break;
      }
      case "linear": {
        const credentials = linearCredentialsSchema.parse(
          resumeBody.credentials
        );
        const parsedOptions = linearOptionsSchema.parse(options ?? {});
        const { batch, job: updatedJob } = await resumeImport(
          linearImportSource,
          c.env,
          organizationId,
          importerId,
          job,
          credentials,
          parsedOptions,
          state
        );
        output = importRunOutput(job.source, updatedJob, batch);
        break;
      }
      case "notion": {
        const credentials = notionCredentialsSchema.parse(
          resumeBody.credentials
        );
        const parsedOptions = notionOptionsSchema.parse(options ?? {});
        const { batch, job: updatedJob } = await resumeImport(
          notionImportSource,
          c.env,
          organizationId,
          importerId,
          job,
          credentials,
          parsedOptions,
          state
        );
        output = importRunOutput(job.source, updatedJob, batch);
        break;
      }
      case "github-issues": {
        const credentials = githubIssuesCredentialsSchema.parse(
          resumeBody.credentials
        );
        const parsedOptions = githubIssuesOptionsSchema.parse(options ?? {});
        const { batch, job: updatedJob } = await resumeImport(
          githubIssuesImportSource,
          c.env,
          organizationId,
          importerId,
          job,
          credentials,
          parsedOptions,
          state
        );
        output = importRunOutput(job.source, updatedJob, batch);
        break;
      }
      case "intercom": {
        const credentials = intercomCredentialsSchema.parse(
          resumeBody.credentials
        );
        const parsedOptions = intercomOptionsSchema.parse(options ?? {});
        const { batch, job: updatedJob } = await resumeImport(
          intercomImportSource,
          c.env,
          organizationId,
          importerId,
          job,
          credentials,
          parsedOptions,
          state
        );
        output = importRunOutput(job.source, updatedJob, batch);
        break;
      }
      case "intercom-support": {
        const credentials = intercomSupportCredentialsSchema.parse(
          resumeBody.credentials
        );
        const parsedOptions = intercomSupportOptionsSchema.parse(options ?? {});
        const { batch, job: updatedJob } = await resumeImport(
          intercomSupportImportSource,
          c.env,
          organizationId,
          importerId,
          job,
          credentials,
          parsedOptions,
          state
        );
        output = importRunOutput(job.source, updatedJob, batch);
        break;
      }
      default: {
        throw new Error(`Unsupported import source: ${job.source}`);
      }
    }

    return c.json(output, 200);
  });

  app.openapi(importApproveRoute, async (c) => {
    const { organizationId, jobId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const job = await findImportJob(db, organizationId, jobId);
    if (!job) {
      return c.json({ error: "Import job not found" }, 404);
    }
    await updateImportApprovalStatus(
      db,
      jobId,
      "approved",
      c.var.userId ?? "unknown"
    );
    await updateImportJobStatus(db, jobId, "pending");
    return c.json({ ok: true, jobId }, 200);
  });

  app.openapi(importRejectRoute, async (c) => {
    const { organizationId, jobId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const job = await findImportJob(db, organizationId, jobId);
    if (!job) {
      return c.json({ error: "Import job not found" }, 404);
    }
    await updateImportApprovalStatus(
      db,
      jobId,
      "rejected",
      c.var.userId ?? "unknown"
    );
    await updateImportJobStatus(db, jobId, "failed", {
      error: "Import rejected",
      completedAt: new Date().toISOString(),
    });
    return c.json({ ok: true, jobId }, 200);
  });
}
