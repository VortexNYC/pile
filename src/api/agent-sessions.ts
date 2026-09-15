import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import type { InferSelectModel } from "drizzle-orm";

import { getAgentProvider } from "../agents/index.js";
import { resolveAgentEnv } from "../agents/outpost.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import type { AgentSessionStatus } from "../types/workspace.js";
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

function toStreamParts(a: AgentActivity): Record<string, unknown>[] {
  if (a.type === "thought") {
    return [
      { type: "reasoning-start", id: a.id },
      { type: "reasoning-delta", id: a.id, delta: a.message },
      { type: "reasoning-end", id: a.id },
    ];
  }
  if (a.type === "response") {
    return [
      { type: "text-start", id: a.id },
      { type: "text-delta", id: a.id, delta: a.message },
      { type: "text-end", id: a.id },
    ];
  }
  if (a.type === "error") {
    return [{ type: "error", errorText: a.message }];
  }
  return [
    {
      type: `data-${a.type}`,
      id: a.id,
      data: {
        message: a.message,
        payload: a.payload ?? null,
        createdAt: a.createdAt,
      },
    },
  ];
}

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

const getSessionEventsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/events",
  tags: ["agent-sessions"],
  middleware: [rls("read", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    query: z.object({
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Agent session events",
      content: {
        "application/json": {
          schema: z.object({ events: z.array(agentActivitySchema) }),
        },
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
            prUrl: z.string().optional(),
            prState: z.string().optional(),
            branch: z.string().optional(),
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

const cancelSessionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/cancel",
  tags: ["agent-sessions"],
  middleware: [rls("write", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
  },
  responses: {
    200: {
      description: "Session canceled",
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

  app.openapi(getSessionEventsRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    const events = await stub.listAgentActivities(sessionId, {
      limit: limit ? Number(limit) : undefined,
    });
    return c.json({ events: events.map(toActivityResponse) });
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
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }

    const updated = await stub.applyAgentSessionResult(
      sessionId,
      {
        status: (body.status ?? session.status) as AgentSessionStatus,
        result: body.result,
        url: body.url,
        prUrl: body.prUrl,
        prState: body.prState,
        branch: body.branch,
      },
      identity.id
    );

    const activities = await stub.listAgentActivities(sessionId);
    return c.json(toSessionResponse(updated ?? session, activities));
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

      const emitPart = toStreamParts;

      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enqueue = (part: Record<string, unknown>) =>
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(part)}\n\n`)
            );

          enqueue({ type: "start", messageId: sessionId });
          const seen = new Set<string>();
          let status = session.status;
          for (const a of session.activities) {
            seen.add(a.id);
            for (const part of emitPart(a)) enqueue(part);
          }

          // Live tail: poll the DO until the session reaches a terminal
          // status or the connection budget (90s) runs out. Consumers
          // reconnect for a continued tail.
          const deadline = Date.now() + 90_000;
          const terminal = new Set(["completed", "failed", "canceled"]);
          const tick = async (): Promise<void> => {
            if (terminal.has(status) || Date.now() >= deadline) return;
            await new Promise((r) => setTimeout(r, 2_000));
            const fresh = await stub
              .getAgentSessionWithActivities(sessionId)
              .catch(() => null);
            if (!fresh) return;
            status = fresh.status;
            for (const a of fresh.activities) {
              if (seen.has(a.id)) continue;
              seen.add(a.id);
              for (const part of emitPart(a)) enqueue(part);
            }
            return tick();
          };
          await tick();
          enqueue({ type: "data-session-status", data: { status } });
          enqueue({ type: "finish" });
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-vercel-ai-ui-message-stream": "v1",
        },
      });
    }
  );

  app.openapi(cancelSessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    if (session.status === "canceled") {
      const activities = await stub.listAgentActivities(sessionId);
      return c.json(toSessionResponse(session, activities));
    }

    const providerConfig = await stub.getAgentProviderConfig(session.agentId);
    const effectiveEnv = resolveAgentEnv(c.env, providerConfig ?? undefined);
    const provider = getAgentProvider(session.agentId, effectiveEnv);
    if (provider.cancel) {
      const remote = session.providerSessionId ?? sessionId;
      await provider
        .cancel(remote)
        .catch((err) => console.error("provider cancel failed", err));
    }

    const updated = await stub.applyAgentSessionResult(
      sessionId,
      { status: "canceled" },
      identity.id
    );
    const activities = await stub.listAgentActivities(sessionId);
    return c.json(toSessionResponse(updated ?? session, activities));
  });

  app.openapi(pollSessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }

    const providerConfig = await stub.getAgentProviderConfig(session.agentId);
    const effectiveEnv = resolveAgentEnv(c.env, providerConfig ?? undefined);
    const provider = getAgentProvider(session.agentId, effectiveEnv);
    const polled = await provider.poll(session.providerSessionId ?? sessionId);

    const updated = await stub.applyAgentSessionResult(
      sessionId,
      {
        status: polled.status,
        result: polled.result,
        url: polled.url,
        providerSessionId: polled.id,
        prUrl: polled.prUrl,
        prState: polled.prState,
        branch: polled.branch,
      },
      identity.id
    );

    const activities = await stub.listAgentActivities(sessionId);
    return c.json(toSessionResponse(updated ?? session, activities));
  });
}
