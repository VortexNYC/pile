import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import {
  agentSessions,
  supportTicketEvents,
  supportTickets,
} from "../global/schema.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const activitySchema = z.object({
  kind: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  entityTitle: z.string().nullable(),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  detail: z.string().nullable(),
  createdAt: z.string(),
});

const workspaceActivityRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/activity",
  tags: ["activities"],
  middleware: [rls("settings:view")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      limit: z.coerce.number().default(50),
      entityType: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Unified workspace activity feed — all entity events",
      content: {
        "application/json": {
          schema: z.object({ activity: z.array(activitySchema) }),
        },
      },
    },
  },
});

export function registerActivityFeedRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(workspaceActivityRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { limit, entityType } = c.req.valid("query");
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);

    // Fetch events from all entity types. Issue history and entity comments
    // live in the workspace DO; ticket events and agent sessions live in D1.
    const [issueHistory, commentRows, ticketEvents, sessionRows] =
      await Promise.all([
        stub.listWorkspaceIssueHistory(),
        stub.listWorkspaceComments(),
        db
          .select({
            id: supportTicketEvents.id,
            ticketId: supportTicketEvents.ticketId,
            type: supportTicketEvents.type,
            subType: supportTicketEvents.subType,
            actorType: supportTicketEvents.actorType,
            actorId: supportTicketEvents.actorId,
            metadata: supportTicketEvents.metadata,
            createdAt: supportTicketEvents.createdAt,
          })
          .from(supportTicketEvents)
          .innerJoin(
            supportTickets,
            eq(supportTicketEvents.ticketId, supportTickets.id)
          )
          .where(eq(supportTickets.organizationId, organizationId))
          .limit(limit)
          .all(),
        db
          .select()
          .from(agentSessions)
          .where(eq(agentSessions.organizationId, organizationId))
          .limit(limit)
          .all(),
      ]);

    // Normalize into a common format
    const activity = [
      // Issue history — field changes
      ...issueHistory.map((h) => ({
        kind: "history",
        entityType: "issue",
        entityId: h.issueId,
        entityTitle: null,
        actorId: h.actorId,
        actorName: null,
        action: `changed ${h.field}`,
        detail: `${h.fromValue ?? "—"} → ${h.toValue ?? "—"}`,
        createdAt: h.createdAt,
      })),
      // Ticket events — status changes, assignments
      ...ticketEvents.map((e) => ({
        kind: "ticket_event",
        entityType: "ticket",
        entityId: e.ticketId,
        entityTitle: null,
        actorId: e.actorId,
        actorName: e.actorType,
        action: e.subType ? `${e.type}:${e.subType}` : e.type,
        detail: e.metadata,
        createdAt: e.createdAt,
      })),
      // Comments — user comments on any entity
      ...commentRows.map((row) => ({
        kind: "comment",
        entityType: row.entityType ?? "issue",
        entityId: row.entityId ?? row.id,
        entityTitle: null,
        actorId: row.authorId,
        actorName: row.externalAuthor,
        action: "commented",
        detail: row.body.slice(0, 200),
        createdAt: row.createdAt,
      })),
      // Agent sessions — agent actions
      ...sessionRows.map((s) => ({
        kind: "agent",
        entityType: "session",
        entityId: s.id,
        entityTitle: s.issueId,
        actorId: s.actorId,
        actorName: `${s.provider}:${s.agentId}`,
        action: s.status,
        detail: s.result ? s.result.slice(0, 200) : null,
        createdAt: s.createdAt,
      })),
    ];

    // Filter by entity type if specified
    const filtered = entityType
      ? activity.filter((a) => a.entityType === entityType)
      : activity;

    // Sort by createdAt descending
    filtered.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    return c.json({ activity: filtered.slice(0, limit) });
  });
}
