import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import {
  confluenceCredentialsSchema,
  confluenceImportSource,
  confluenceOptionsSchema,
} from "../import/confluence.js";
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
  githubIssuesCredentialsSchema,
  githubIssuesImportSource,
  githubIssuesOptionsSchema,
} from "../import/github-issues.js";
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
  source: z.enum([
    "jira",
    "confluence",
    "linear",
    "notion",
    "github-issues",
  ]),
  credentials: z.unknown(),
  options: z.unknown().optional(),
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
          schema: z.object({
            ok: z.boolean(),
            source: z.string(),
            counts: z.record(z.string(), z.number()),
          }),
        },
      },
    },
  },
});

export function registerImportRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(importRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const ctx = await createImportContext(
      c.env,
      organizationId,
      c.var.userId ?? "unknown"
    );

    let counts: ImportCounts;
    switch (body.source) {
      case "jira": {
        const credentials = jiraCredentialsSchema.parse(body.credentials);
        const options = jiraOptionsSchema.parse(body.options ?? {});
        counts = await runImport(jiraImportSource, ctx, credentials, options);
        break;
      }
      case "confluence": {
        const credentials = confluenceCredentialsSchema.parse(body.credentials);
        const options = confluenceOptionsSchema.parse(body.options ?? {});
        counts = await runImport(
          confluenceImportSource,
          ctx,
          credentials,
          options
        );
        break;
      }
      case "linear": {
        const credentials = linearCredentialsSchema.parse(body.credentials);
        const options = linearOptionsSchema.parse(body.options ?? {});
        counts = await runImport(linearImportSource, ctx, credentials, options);
        break;
      }
      case "notion": {
        const credentials = notionCredentialsSchema.parse(body.credentials);
        const options = notionOptionsSchema.parse(body.options ?? {});
        counts = await runImport(notionImportSource, ctx, credentials, options);
        break;
      }
      case "github-issues": {
        const credentials = githubIssuesCredentialsSchema.parse(
          body.credentials
        );
        const options = githubIssuesOptionsSchema.parse(body.options ?? {});
        counts = await runImport(
          githubIssuesImportSource,
          ctx,
          credentials,
          options
        );
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
      counts,
    });
  });
}
