import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { findImportJob } from "../global/import-jobs.js";
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
import { createImportContext, runImport } from "../import/runner.js";
import type { ImportCounts } from "../import/types.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const importBodySchema = z.object({
  source: z.enum(["jira", "confluence", "linear", "notion", "github-issues"]),
  credentials: z.unknown(),
  options: z.unknown().optional(),
});

const importResponseSchema = z.object({
  ok: z.boolean(),
  source: z.string(),
  jobId: z.string(),
  counts: z.record(z.string(), z.number()),
});

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
      description: "Import complete",
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
          }),
        },
      },
    },
    404: {
      description: "Import job not found",
    },
  },
});

function parseJobCounts(
  countsJson: string | null
): Record<string, number> | undefined {
  if (!countsJson) return undefined;
  const parsed = z
    .record(z.string(), z.number())
    .safeParse(JSON.parse(countsJson));
  return parsed.success ? parsed.data : undefined;
}

export function registerImportRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(importRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const ctx = await createImportContext(
      c.env,
      organizationId,
      c.var.userId ?? "unknown"
    );

    let result: { counts: ImportCounts; jobId: string };
    switch (body.source) {
      case "jira": {
        const credentials = jiraCredentialsSchema.parse(body.credentials);
        const options = jiraOptionsSchema.parse(body.options ?? {});
        const runResult = await runImport(
          jiraImportSource,
          ctx,
          credentials,
          options
        );
        result = { counts: runResult.counts, jobId: runResult.job.id };
        break;
      }
      case "confluence": {
        const credentials = confluenceCredentialsSchema.parse(body.credentials);
        const options = confluenceOptionsSchema.parse(body.options ?? {});
        const runResult = await runImport(
          confluenceImportSource,
          ctx,
          credentials,
          options
        );
        result = { counts: runResult.counts, jobId: runResult.job.id };
        break;
      }
      case "linear": {
        const credentials = linearCredentialsSchema.parse(body.credentials);
        const options = linearOptionsSchema.parse(body.options ?? {});
        const runResult = await runImport(
          linearImportSource,
          ctx,
          credentials,
          options
        );
        result = { counts: runResult.counts, jobId: runResult.job.id };
        break;
      }
      case "notion": {
        const credentials = notionCredentialsSchema.parse(body.credentials);
        const options = notionOptionsSchema.parse(body.options ?? {});
        const runResult = await runImport(
          notionImportSource,
          ctx,
          credentials,
          options
        );
        result = { counts: runResult.counts, jobId: runResult.job.id };
        break;
      }
      case "github-issues": {
        const credentials = githubIssuesCredentialsSchema.parse(
          body.credentials
        );
        const options = githubIssuesOptionsSchema.parse(body.options ?? {});
        const runResult = await runImport(
          githubIssuesImportSource,
          ctx,
          credentials,
          options
        );
        result = { counts: runResult.counts, jobId: runResult.job.id };
        break;
      }
      default: {
        const exhaustive: never = body.source;
        throw new Error(`Unsupported import source: ${String(exhaustive)}`);
      }
    }

    return c.json({
      ok: true,
      source: body.source,
      jobId: result.jobId,
      counts: result.counts,
    });
  });

  app.openapi(importJobStatusRoute, async (c) => {
    const { organizationId, jobId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const job = await findImportJob(db, organizationId, jobId);
    if (!job) {
      return c.json({ error: "Import job not found" }, 404);
    }
    return c.json({
      id: job.id,
      source: job.source,
      status: job.status,
      counts: parseJobCounts(job.counts),
      error: job.error ?? undefined,
    });
  });
}
