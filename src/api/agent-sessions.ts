import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { getAgentProvider } from "../agents/index.js";
import {
  addAgentActivity,
  getAgentSession,
  getAgentSessionWithActivities,
  listAgentActivities,
  listAgentSessions,
  updateAgentSession,
  type AgentActivity,
  type AgentSession,
} from "../global/agent-sessions.js";
import { createD1 } from "../global/db.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

const agentActivityTypeSchema = z.enum([
  "thought",
  "response",
  "error",
  "elicitation",
  "action",
  "status",
]);

const agentSessionStatusSchema = z.enum([
  "created",
  "running",
  "waiting",
  "completed",
  "failed",
  "canceled",
]);

export const agentSessionSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  issueId: z.string(),
  agentId: z.string(),
  provider: z.string(),
  actorId: z.string(),
  actorType: z.enum(["user", "agent"]),
  status: agentSessionStatusSchema,
  result: z.string().nullable(),
  url: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  activities: z
    .array(
      z.object({
        id: z.string(),
        sessionId: z.string(),
        actorId: z.string().nullable(),
        type: agentActivityTypeSchema,
        message: z.string(),
        payload: z.unknown().nullable(),
        createdAt: z.string(),
      })
    )
    .optional(),
});

const agentActivitySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  actorId: z.string().nullable(),
  type: agentActivityTypeSchema,
  message: z.string(),
  payload: z.unknown().nullable(),
  createdAt: z.string(),
});

function toActivityResponse(row: AgentActivity) {
  return {
    ...row,
    payload: row.payload ? JSON.parse(row.payload) : null,
  };
}

function toSessionResponse(row: AgentSession, activities?: AgentActivity[]) {
  return {
    ...row,
    activities: activities?.map(toActivityResponse),
  };
}

const listSessionsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/sessions",
  tags: ["agent-sessions"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      issueId: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Agent sessions list",
      content: {
        "application/json": {
          schema: z.object({ sessions: z.array(agentSessionSchema) }),
        },
      },
    },
  },
});

const getSessionRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}",
  tags: ["agent-sessions"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
  },
  responses: {
    200: {
      description: "Agent session with activities",
      content: {
        "application/json": { schema: agentSessionSchema },
      },
    },
    404: { description: "Session not found" },
  },
});

const addActivityRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/activities",
  tags: ["agent-sessions"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            type: agentActivityTypeSchema,
            message: z.string().min(1),
            payload: z.record(z.string(), z.unknown()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Activity added",
      content: {
        "application/json": { schema: agentActivitySchema },
      },
    },
    404: { description: "Session not found" },
  },
});

const patchSessionRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}",
  tags: ["agent-sessions"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            status: agentSessionStatusSchema.optional(),
            result: z.string().optional(),
            url: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Session updated",
      content: {
        "application/json": { schema: agentSessionSchema },
      },
    },
    404: { description: "Session not found" },
  },
});

const pollSessionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/poll",
  tags: ["agent-sessions"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
  },
  responses: {
    200: {
      description: "Session polled and updated",
      content: {
        "application/json": { schema: agentSessionSchema },
      },
    },
    404: { description: "Session not found" },
  },
});

export function registerAgentSessionRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listSessionsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const db = createD1(c.env.D1);
    const rows = await listAgentSessions(db, organizationId, {
      issueId: query.issueId,
      limit: query.limit ? Number(query.limit) : undefined,
    });
    return c.json({
      sessions: rows.map((row) => toSessionResponse(row, undefined)),
    });
  });

  app.openapi(getSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const session = await getAgentSessionWithActivities(db, sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    return c.json(toSessionResponse(session, session.activities));
  });

  app.openapi(addActivityRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);

    const session = await getAgentSession(db, sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }

    const activity = await addAgentActivity(db, {
      sessionId,
      actorId: identity.id,
      type: body.type,
      message: body.message,
      payload: body.payload,
    });
    return c.json(toActivityResponse(activity), 201);
  });

  app.openapi(patchSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const db = createD1(c.env.D1);

    const updated = await updateAgentSession(db, sessionId, {
      status: body.status,
      result: body.result,
      url: body.url,
    });
    if (!updated) {
      return c.json({ message: "Session not found" }, 404);
    }

    const activities = await listAgentActivities(db, sessionId);
    return c.json(toSessionResponse(updated, activities));
  });

  app.openapi(pollSessionRoute, async (c) => {
    const { sessionId } = c.req.valid("param");
    const db = createD1(c.env.D1);

    const session = await getAgentSession(db, sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }

    const provider = getAgentProvider(session.agentId, c.env);
    const polled = await provider.poll(sessionId);

    const updated = await updateAgentSession(db, sessionId, {
      status: polled.status as AgentSession["status"],
      result: polled.result ?? undefined,
      url: polled.url ?? undefined,
    });
    if (!updated) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 500,
        message: "Session disappeared during poll",
      });
    }

    const activities = await listAgentActivities(db, sessionId);
    return c.json(toSessionResponse(updated, activities));
  });
}
