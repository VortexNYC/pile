import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { issueViewer } from "./issue-access.js";
import { getWorkspaceStub } from "./stub.js";

const auditEntrySchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  actorId: z.string().nullable(),
  actorType: z.string().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  changes: z.record(z.string(), z.unknown()).nullable(),
  ip: z.string().nullable(),
  country: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: z.string(),
});

const listRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/audit-log",
  tags: ["audit"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      entityType: z.string().optional(),
      entityId: z.string().optional(),
      action: z.string().optional(),
      actorId: z.string().optional(),
      limit: z
        .string()
        .transform((v) => Number.parseInt(v, 10))
        .optional(),
    }),
  },
  responses: {
    200: {
      description: "Workspace audit log, newest first",
      content: {
        "application/json": {
          schema: z.object({ entries: z.array(auditEntrySchema) }),
        },
      },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/audit-log/{id}",
  tags: ["audit"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Audit log entry",
      content: { "application/json": { schema: auditEntrySchema } },
    },
    404: { description: "Audit log entry not found" },
  },
});

export function registerAuditRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const rows = await stub.listAuditLog(
      {
        entityType: query.entityType,
        entityId: query.entityId,
        action: query.action,
        actorId: query.actorId,
        limit: query.limit,
      },
      await issueViewer(createD1(c.env.D1), c.get("workspaceIdentity"))
    );
    return c.json({
      entries: rows.map((r) => ({
        id: r.id,
        organizationId: r.organizationId,
        actorId: r.actorId,
        actorType: r.actorType,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        changes: r.changes
          ? (JSON.parse(r.changes) as Record<string, unknown>)
          : null,
        ip: r.ip,
        country: r.country,
        userAgent: r.userAgent,
        createdAt: r.createdAt,
      })),
    });
  });

  app.openapi(getRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const row = await stub.getAuditLogEntry(id);
    const identity = c.get("workspaceIdentity");
    const viewer = await issueViewer(createD1(c.env.D1), identity);
    const hidden =
      viewer &&
      row?.entityType === "issue" &&
      !(await stub.issueVisibleTo(
        row.entityId,
        viewer.actorId,
        viewer.teamIds
      ));
    if (!row || hidden) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Audit log entry not found",
      });
    }
    return c.json({
      id: row.id,
      organizationId: row.organizationId,
      actorId: row.actorId,
      actorType: row.actorType,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      changes: row.changes
        ? (JSON.parse(row.changes) as Record<string, unknown>)
        : null,
      ip: row.ip,
      country: row.country,
      userAgent: row.userAgent,
      createdAt: row.createdAt,
    });
  });
}
