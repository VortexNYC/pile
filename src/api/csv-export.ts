import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { getVisibleTeamIds } from "../global/teams.js";
import { listProjects } from "../global/workspace-entities.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "../types/workspace.js";
import { getWorkspaceStub } from "./stub.js";

const exportRequestSchema = z.object({
  entityType: z.enum(["issues", "projects"]),
  teamId: z.string().optional(),
  status: z.enum(ISSUE_STATUSES).optional(),
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  assigneeId: z.string().optional(),
  projectId: z.string().optional(),
});

function csvRow(values: (string | number | null | undefined)[]) {
  return values
    .map((value) => {
      const str = String(value ?? "");
      if (
        str.includes(",") ||
        str.includes('"') ||
        str.includes("\n") ||
        str.includes("\r")
      ) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    })
    .join(",");
}

const exportRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/csv-exports",
  tags: ["csv-exports"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: { content: { "application/json": { schema: exportRequestSchema } } },
  },
  responses: {
    200: {
      description: "CSV export",
      content: { "text/csv": { schema: z.string() } },
    },
  },
});

export function registerCsvExportRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(exportRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = createD1(c.env.D1);
    const identity = c.var.workspaceIdentity;

    if (input.entityType === "issues") {
      const visibleTeamIds = await getVisibleTeamIds(
        db,
        organizationId,
        identity
      );
      if (input.teamId && !visibleTeamIds.includes(input.teamId)) {
        throw new VortexError({
          code: "FORBIDDEN",
          status: 403,
          message: "Cannot export issues from this team",
        });
      }
      const stub = getWorkspaceStub(c.env, organizationId);
      const issues = await stub.listIssues({
        teamIds: visibleTeamIds,
        teamId: input.teamId,
        status: input.status,
        priority: input.priority,
        assigneeId: input.assigneeId,
        projectId: input.projectId,
      });
      const headers = [
        "id",
        "identifier",
        "title",
        "status",
        "priority",
        "assigneeId",
        "teamId",
        "projectId",
        "createdAt",
        "updatedAt",
      ];
      const rows = [csvRow(headers)];
      for (const issue of issues) {
        rows.push(
          csvRow([
            issue.id,
            issue.identifier,
            issue.title,
            issue.status,
            issue.priority,
            issue.assigneeId,
            issue.teamId,
            issue.projectId,
            issue.createdAt,
            issue.updatedAt,
          ])
        );
      }
      const csv = rows.join("\n");
      return c.text(csv, 200, {
        "content-type": "text/csv",
        "content-disposition": `attachment; filename="${input.entityType}.csv"`,
      });
    }

    const projects = await listProjects(db, organizationId);
    const headers = [
      "id",
      "name",
      "description",
      "status",
      "health",
      "leadId",
      "createdAt",
      "updatedAt",
    ];
    const rows = [csvRow(headers)];
    for (const project of projects) {
      rows.push(
        csvRow([
          project.id,
          project.name,
          project.description,
          project.status,
          project.health,
          project.leadId,
          project.createdAt,
          project.updatedAt,
        ])
      );
    }
    const csv = rows.join("\n");
    return c.text(csv, 200, {
      "content-type": "text/csv",
      "content-disposition": `attachment; filename="${input.entityType}.csv"`,
    });
  });
}
