import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import {
  listAgentActivities,
  listAgentSessions,
} from "../global/agent-sessions.js";
import { createD1 } from "../global/db.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const activitySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("history"),
    id: z.string(),
    issueId: z.string(),
    field: z.string(),
    fromValue: z.string().nullable(),
    toValue: z.string().nullable(),
    actorId: z.string().nullable(),
    createdAt: z.string(),
  }),
  z.object({
    kind: z.literal("comment"),
    id: z.string(),
    issueId: z.string(),
    body: z.string(),
    authorId: z.string().nullable(),
    externalAuthor: z.string().nullable(),
    createdAt: z.string(),
  }),
  z.object({
    kind: z.literal("agent"),
    id: z.string(),
    issueId: z.string(),
    sessionId: z.string(),
    type: z.string(),
    message: z.string(),
    actorId: z.string().nullable(),
    createdAt: z.string(),
  }),
]);

const issueActivityRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/activity",
  tags: ["activities"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
  },
  responses: {
    200: {
      description: "Unified issue activity feed",
      content: {
        "application/json": {
          schema: z.object({ activity: z.array(activitySchema) }),
        },
      },
    },
  },
});

export function registerActivityRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(issueActivityRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const db = createD1(c.env.D1);

    const doId = c.env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId);
    const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(doId);
    const history = await stub.listIssueHistory(issueId);
    const comments = await stub.listComments(issueId);
    const sessions = await listAgentSessions(db, organizationId, { issueId });
    const agentActivities = (
      await Promise.all(
        sessions.map((session) => listAgentActivities(db, session.id))
      )
    ).flat();

    const activity = [
      ...history.map((item) => ({
        kind: "history" as const,
        id: item.id,
        issueId: item.issueId,
        field: item.field,
        fromValue: item.fromValue,
        toValue: item.toValue,
        actorId: item.actorId,
        createdAt: item.createdAt,
      })),
      ...comments.map((item) => ({
        kind: "comment" as const,
        id: item.id,
        issueId: item.issueId,
        body: item.body,
        authorId: item.authorId,
        externalAuthor: item.externalAuthor,
        createdAt: item.createdAt,
      })),
      ...agentActivities.map((item) => ({
        kind: "agent" as const,
        id: item.id,
        issueId,
        sessionId: item.sessionId,
        type: item.type,
        message: item.message,
        actorId: item.actorId,
        createdAt: item.createdAt,
      })),
    ].toSorted(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    return c.json({ activity });
  });
}
