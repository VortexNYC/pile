import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import type { InferSelectModel } from "drizzle-orm";

import { getAgentProvider } from "../agents/index.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import type {
  workspaceAgentActivities,
  workspaceAgentSessions,
} from "../workspace/schema.js";
import { getWorkspaceStub } from "./stub.js";

const agentActivityTypeSchema = z.enum([
  "thought",
  "response",
  "error",
  "elicitation",
  "action",
  "status",
]);

type AgentSession = InferSelectModel<typeof workspaceAgentSessions>;
type AgentActivity = InferSelectModel<typeof workspaceAgentActivities>;

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
  providerSessionId: z.string().nullable(),
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
  middleware: [rls("read", "agent:read")],
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

const issueLiveRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/live",
  tags: ["agent-sessions"],
  middleware: [rls("read", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
  },
  responses: {
    200: {
      description: "Live agent state for issue",
      content: {
        "application/json": {
          schema: z.object({
            session: agentSessionSchema.nullable(),
            activities: z.array(agentActivitySchema),
          }),
        },
      },
    },
  },
});

const getSessionRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}",
  tags: ["agent-sessions"],
  middleware: [rls("read", "agent:read")],
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
  middleware: [rls("write", "agent:write")],
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
  middleware: [rls("write", "agent:write")],
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
  middleware: [rls("write", "agent:write")],
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
    const stub = getWorkspaceStub(c.env, organizationId);
    const rows = await stub.listAgentSessions({
      issueId: query.issueId,
      limit: query.limit ? Number(query.limit) : undefined,
    });
    return c.json({
      sessions: rows.map((row) => toSessionResponse(row, undefined)),
    });
  });

  app.openapi(issueLiveRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const live = await stub.getActiveAgentSessionForIssue(issueId);
    return c.json({
      session: live ? toSessionResponse(live.session, live.activities) : null,
      activities: live?.activities.map(toActivityResponse) ?? [],
    });
  });

  app.openapi(getSessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const session = await stub.getAgentSessionWithActivities(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    return c.json(toSessionResponse(session, session.activities));
  });

  app.openapi(addActivityRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }

    const activity = await stub.addAgentActivity({
      sessionId,
      actorId: identity.id,
      type: body.type,
      message: body.message,
      payload: body.payload,
    });
    return c.json(toActivityResponse(activity), 201);
  });

  app.openapi(patchSessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);

    const updated = await stub.updateAgentSession(sessionId, {
      status: body.status,
      result: body.result,
      url: body.url,
    });
    if (!updated) {
      return c.json({ message: "Session not found" }, 404);
    }

    const activities = await stub.listAgentActivities(sessionId);
    return c.json(toSessionResponse(updated, activities));
  });

  // Vercel AI SDK UI-message-stream (SSE) replay of the activity log, so any
  // useChat-compatible consumer can read a session's history live.
  app.get(
    "/workspaces/:organizationId/agent/sessions/:sessionId/stream",
    async (c) => {
      const organizationId = c.req.param("organizationId");
      const sessionId = c.req.param("sessionId");
      const stub = getWorkspaceStub(c.env, organizationId);
      const session = await stub.getAgentSessionWithActivities(sessionId);
      if (!session) {
        return c.json({ message: "Session not found" }, 404);
      }

      const lines: string[] = [];
      const emit = (part: Record<string, unknown>) =>
        lines.push(`data: ${JSON.stringify(part)}\n\n`);
      emit({ type: "start", messageId: sessionId });
      for (const a of session.activities) {
        if (a.type === "thought") {
          emit({ type: "reasoning-start", id: a.id });
          emit({ type: "reasoning-delta", id: a.id, delta: a.message });
          emit({ type: "reasoning-end", id: a.id });
        } else if (a.type === "response") {
          emit({ type: "text-start", id: a.id });
          emit({ type: "text-delta", id: a.id, delta: a.message });
          emit({ type: "text-end", id: a.id });
        } else if (a.type === "error") {
          emit({ type: "error", errorText: a.message });
        } else {
          emit({
            type: `data-${a.type}`,
            id: a.id,
            data: {
              message: a.message,
              payload: a.payload ?? null,
              createdAt: a.createdAt,
            },
          });
        }
      }
      emit({ type: "finish" });

      return new Response(lines.join(""), {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-vercel-ai-ui-message-stream": "v1",
        },
      });
    }
  );

  app.openapi(pollSessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }

    const provider = getAgentProvider(session.agentId, c.env);
    const polled = await provider.poll(session.providerSessionId ?? sessionId);

    const updated = await stub.updateAgentSession(sessionId, {
      status: agentSessionStatusSchema.parse(polled.status),
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

    const activities = await stub.listAgentActivities(sessionId);
    return c.json(toSessionResponse(updated, activities));
  });
}
