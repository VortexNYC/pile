import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import {
  supportCaptureSessions,
  supportTicketAttachments,
  supportWidgetSessions,
} from "../global/schema.js";
import { getTicketById, listTicketEvents } from "../global/support-tickets.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const traceRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/support/trace/{id}",
  tags: ["support-tickets"],
  middleware: [rls("read")],
  request: {
    params: z.object({
      organizationId: z.string(),
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description:
        "Correlated trace — resolves any of {ticket id, capture session id, widget session id} and returns the full picture: ticket, timeline events, attachments with R2 availability, capture session, widget session, escalated issue, and agent sessions.",
      content: {
        "application/json": {
          schema: z.object({
            resolvedAs: z.enum(["ticket", "capture_session", "widget_session"]),
            ticket: z.unknown().nullable(),
            events: z.array(z.unknown()),
            attachments: z.array(
              z.object({
                id: z.string(),
                type: z.string(),
                fileName: z.string().nullable(),
                size: z.number().nullable(),
                r2Key: z.string().nullable(),
                available: z.boolean(),
              })
            ),
            captureSession: z.unknown().nullable(),
            widgetSession: z.unknown().nullable(),
            issue: z.unknown().nullable(),
            agentSessions: z.array(z.unknown()),
          }),
        },
      },
    },
    404: {
      description: "No ticket, capture session, or widget session with this id",
    },
  },
});

export function registerSupportTraceRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(traceRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);

    let resolvedAs: "ticket" | "capture_session" | "widget_session" = "ticket";
    let ticket = await getTicketById(db, organizationId, id);
    let captureSession = null as Record<string, unknown> | null;
    let widgetSession = null as Record<string, unknown> | null;

    if (!ticket) {
      captureSession =
        (await db
          .select()
          .from(supportCaptureSessions)
          .where(
            and(
              eq(supportCaptureSessions.organizationId, organizationId),
              eq(supportCaptureSessions.id, id)
            )
          )
          .get()) ?? null;
      if (captureSession?.ticketId) {
        ticket = await getTicketById(
          db,
          organizationId,
          captureSession.ticketId as string
        );
        resolvedAs = "capture_session";
      }
    }

    if (!ticket && !captureSession) {
      widgetSession =
        (await db
          .select()
          .from(supportWidgetSessions)
          .where(
            and(
              eq(supportWidgetSessions.organizationId, organizationId),
              eq(supportWidgetSessions.id, id)
            )
          )
          .get()) ?? null;
      if (widgetSession?.ticketId) {
        ticket = await getTicketById(
          db,
          organizationId,
          widgetSession.ticketId as string
        );
        resolvedAs = "widget_session";
      }
    }

    if (!ticket) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "No ticket, capture session, or widget session with this id",
      });
    }

    const ticketId = ticket.id;
    if (!captureSession) {
      captureSession =
        (await db
          .select()
          .from(supportCaptureSessions)
          .where(
            and(
              eq(supportCaptureSessions.organizationId, organizationId),
              eq(supportCaptureSessions.ticketId, ticketId)
            )
          )
          .get()) ?? null;
    }
    if (!widgetSession) {
      widgetSession =
        (await db
          .select()
          .from(supportWidgetSessions)
          .where(
            and(
              eq(supportWidgetSessions.organizationId, organizationId),
              eq(supportWidgetSessions.ticketId, ticketId)
            )
          )
          .get()) ?? null;
    }

    const events = await listTicketEvents(db, organizationId, ticketId, {
      limit: 200,
    });

    const attachmentRows = await db
      .select()
      .from(supportTicketAttachments)
      .where(
        and(
          eq(supportTicketAttachments.organizationId, organizationId),
          eq(supportTicketAttachments.ticketId, ticketId)
        )
      );
    const attachments = await Promise.all(
      attachmentRows.map(async (row) => ({
        id: row.id,
        type: row.type,
        fileName: row.fileName,
        size: row.size,
        r2Key: row.r2Key,
        available:
          row.r2Key === null ||
          (await c.env.ATTACHMENTS_BUCKET.head(row.r2Key)) !== null,
      }))
    );

    let issue = null as unknown;
    let agentSessions: unknown[] = [];
    if (ticket.issueId) {
      const stub = getWorkspaceStub(c.env, organizationId);
      issue = (await stub.getIssue(ticket.issueId)) ?? null;
      agentSessions = await stub.listAgentSessions({
        issueId: ticket.issueId,
      });
    }

    return c.json({
      resolvedAs,
      ticket,
      events,
      attachments,
      captureSession,
      widgetSession,
      issue,
      agentSessions,
    });
  });
}
