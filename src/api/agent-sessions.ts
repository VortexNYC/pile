import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import type { InferSelectModel } from "drizzle-orm";

import { loadProviderConfig } from "../agents/credentials.js";
import { resolveAgentEnv } from "../agents/daytona.js";
import { dispatchAgent, getAgentProvider } from "../agents/index.js";
import { createD1 } from "../global/db.js";
import { createRepoBranch } from "../global/repo-branches.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import type { AgentSessionStatus } from "../types/workspace.js";
import type {
  workspaceAgentActivities,
  workspaceAgentSessions,
} from "../workspace/schema.js";
import { captureSessionPrArtifact } from "./agent-artifacts.js";
import { getWorkspaceStub } from "./stub.js";

function getExecutionCtx(c: {
  executionCtx?: { waitUntil: (promise: Promise<unknown>) => void };
}): { waitUntil: (promise: Promise<unknown>) => void } | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}

const agentActivityTypeSchema = z.enum([
  "thought",
  "response",
  "error",
  "elicitation",
  "action",
  "status",
  "artifact",
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
  prUrl: z.string().nullable(),
  prState: z.string().nullable(),
  branch: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastProgressAt: z.string().nullable().optional(),
  lastStateHash: z.string().nullable().optional(),
  activities: z
    .array(
      z.object({
        id: z.string(),
        sessionId: z.string(),
        actorId: z.string().nullable(),
        type: agentActivityTypeSchema,
        message: z.string(),
        payload: z.unknown().nullable(),
        parentId: z.string().nullable(),
        startedAt: z.string().nullable(),
        endedAt: z.string().nullable(),
        durationMs: z.number().nullable(),
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
  parentId: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
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

function avgSeconds(durations: number[]): number | null {
  if (durations.length === 0) return null;
  return Math.round(
    durations.reduce((a, b) => a + b, 0) / durations.length / 1000
  );
}

const agentStatsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/stats",
  tags: ["agent-sessions"],
  middleware: [rls("read", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description:
        "Aggregate agent session stats for the workspace: totals, per-provider breakdown, success rate, durations, and infra failures",
      content: {
        "application/json": {
          schema: z.object({
            total: z.number(),
            byStatus: z.record(z.string(), z.number()),
            infraFailures: z.number(),
            avgDurationSeconds: z.number().nullable(),
            providers: z.array(
              z.object({
                agentId: z.string(),
                total: z.number(),
                completed: z.number(),
                failed: z.number(),
                successRate: z.number().nullable(),
                avgDurationSeconds: z.number().nullable(),
              })
            ),
          }),
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
            parentId: z.string().optional(),
            startedAt: z.string().optional(),
            endedAt: z.string().optional(),
            durationMs: z.number().optional(),
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

const artifactTypeSchema = z.enum([
  "diff",
  "log",
  "screenshot",
  "trace",
  "output",
  "other",
]);

const createArtifactBodySchema = z
  .object({
    name: z.string().min(1),
    type: artifactTypeSchema,
    content: z.string().optional(),
    data: z.string().optional(),
    mimeType: z.string().optional(),
    url: z.string().optional(),
  })
  .refine(
    (value) =>
      value.content !== undefined ||
      value.data !== undefined ||
      value.url !== undefined,
    "At least one of content, data, or url is required"
  );

const createArtifactRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/artifacts",
  tags: ["agent-sessions"],
  middleware: [rls("write", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    body: {
      content: {
        "application/json": { schema: createArtifactBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Artifact captured",
      content: { "application/json": { schema: agentActivitySchema } },
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

const getSessionStateRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/state",
  tags: ["agent-sessions"],
  middleware: [rls("read", "agent:read")],
  request: {
    params: z.object({
      organizationId: z.string(),
      sessionId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Live agent session state from provider and compute",
      content: {
        "application/json": {
          schema: z.object({
            session: agentSessionSchema,
            provider: z.unknown().nullable().optional(),
            compute: z.unknown().nullable().optional(),
          }),
        },
      },
    },
    400: { description: "Not supported for this agent or not configured" },
    404: { description: "Session not found" },
  },
});

const childIssueSchema = z.object({
  id: z.string(),
  identifier: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  priority: z.string(),
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  parentId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createChildSessionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/children",
  tags: ["agent-sessions"],
  middleware: [rls("write", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            title: z.string().min(1),
            description: z.string().optional(),
            agentId: z.string().optional(),
            model: z.string().optional(),
            repo: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Child session created and dispatched",
      content: {
        "application/json": {
          schema: z.object({
            session: agentSessionSchema,
            issue: childIssueSchema,
          }),
        },
      },
    },
    400: { description: "Bad request" },
    404: { description: "Session or parent issue not found" },
    429: { description: "Too many active child sessions" },
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

  app.openapi(agentStatsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const rows = await stub.listAgentSessions({});

    const TERMINAL = new Set(["completed", "failed", "canceled"]);
    const byStatus: Record<string, number> = {};
    const byAgent = new Map<
      string,
      { total: number; completed: number; failed: number; durations: number[] }
    >();
    let infraFailures = 0;
    const durations: number[] = [];

    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      if (row.infraFailure) infraFailures += 1;
      const agg = byAgent.get(row.agentId) ?? {
        total: 0,
        completed: 0,
        failed: 0,
        durations: [],
      };
      agg.total += 1;
      if (row.status === "completed") agg.completed += 1;
      if (row.status === "failed") agg.failed += 1;
      if (TERMINAL.has(row.status)) {
        const ms = Date.parse(row.updatedAt) - Date.parse(row.createdAt);
        if (Number.isFinite(ms) && ms >= 0) {
          agg.durations.push(ms);
          durations.push(ms);
        }
      }
      byAgent.set(row.agentId, agg);
    }

    return c.json(
      {
        total: rows.length,
        byStatus,
        infraFailures,
        avgDurationSeconds: avgSeconds(durations),
        providers: [...byAgent.entries()].map(([agentId, a]) => ({
          agentId,
          total: a.total,
          completed: a.completed,
          failed: a.failed,
          successRate:
            a.completed + a.failed === 0
              ? null
              : Math.round((a.completed / (a.completed + a.failed)) * 100) /
                100,
          avgDurationSeconds: avgSeconds(a.durations),
        })),
      },
      200
    );
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
      parentId: body.parentId,
      startedAt: body.startedAt,
      endedAt: body.endedAt,
      durationMs: body.durationMs,
    });
    return c.json(toActivityResponse(activity), 201);
  });

  app.openapi(createArtifactRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }

    const activity = await stub.addAgentSessionArtifact({
      sessionId,
      actorId: identity.id,
      name: body.name,
      type: body.type,
      content: body.content,
      data: body.data,
      mimeType: body.mimeType,
      url: body.url,
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

  // Server-sent event stream of agent session deltas. Supports Last-Event-ID
  // for reconnect/replay and emits one event per changed field/activity.
  app.get(
    "/workspaces/:organizationId/agent/sessions/:sessionId/stream",
    async (c) => {
      const organizationId = c.req.param("organizationId");
      const sessionId = c.req.param("sessionId");
      const stub = getWorkspaceStub(c.env, organizationId);

      const session = await stub.getAgentSession(sessionId);
      if (!session) {
        return c.json({ message: "Session not found" }, 404);
      }

      const lastEventIdRaw =
        c.req.header("Last-Event-ID") ?? c.req.query("lastEventId");
      let afterId = 0;
      if (lastEventIdRaw === undefined) {
        const latest = await stub.listAgentSessionEvents(sessionId, {
          limit: 1,
        });
        afterId = latest[0]?.id ?? 0;
      } else {
        afterId = Number(lastEventIdRaw);
        if (Number.isNaN(afterId)) afterId = 0;
      }

      const encoder = new TextEncoder();
      let lastEmittedId = afterId;
      const terminal = new Set(["completed", "failed", "canceled"]);
      let closed = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let streamController:
        | ReadableStreamDefaultController<Uint8Array>
        | undefined;

      const safeClose = () => {
        if (!closed) {
          closed = true;
          if (timeoutId) clearTimeout(timeoutId);
          try {
            streamController?.close();
          } catch {
            /* already closed */
          }
        }
      };

      const sendEvent = (event: {
        id: number;
        type: string;
        message: string;
        payload: unknown;
        createdAt: string;
      }) => {
        if (closed) return;
        const lines = [
          `id: ${event.id}`,
          `event: ${event.type}`,
          `data: ${JSON.stringify(event)}`,
          "",
        ].join("\n");
        streamController?.enqueue(encoder.encode(lines));
      };

      const tick = async () => {
        if (closed) return;
        const current = await stub.getAgentSession(sessionId).catch(() => null);
        if (!current) {
          safeClose();
          return;
        }

        const events = await stub
          .listAgentSessionEvents(sessionId, {
            afterId: lastEmittedId,
            limit: 100,
          })
          .catch(() => []);

        for (const row of events) {
          const payload = row.payload ? JSON.parse(row.payload) : null;
          sendEvent({
            id: row.id,
            type: row.type,
            message: row.message,
            payload,
            createdAt: row.createdAt,
          });
          lastEmittedId = row.id;
        }

        if (terminal.has(current.status)) {
          safeClose();
          return;
        }

        timeoutId = setTimeout(tick, 1_000);
      };

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          tick().catch(() => safeClose());
        },
        cancel() {
          closed = true;
          if (timeoutId) clearTimeout(timeoutId);
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
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

    const providerConfig = await loadProviderConfig(
      c.env,
      stub,
      session.agentId
    );
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

    const providerConfig = await loadProviderConfig(
      c.env,
      stub,
      session.agentId
    );
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

    await captureSessionPrArtifact(stub, sessionId, identity.id, polled.prUrl);

    const activities = await stub.listAgentActivities(sessionId);
    return c.json(toSessionResponse(updated ?? session, activities));
  });

  app.openapi(getSessionStateRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }

    const providerConfig = await loadProviderConfig(
      c.env,
      stub,
      session.agentId
    );
    const effectiveEnv = resolveAgentEnv(c.env, providerConfig ?? undefined);
    const provider = getAgentProvider(session.agentId, effectiveEnv);

    if (!provider.getState) {
      return c.json(
        { message: "Live state not supported for this agent" },
        400
      );
    }

    const remoteId = session.providerSessionId ?? sessionId;
    const state = await provider.getState(remoteId, sessionId);
    if (!state) {
      return c.json(
        { message: "Provider or compute not configured for this agent" },
        400
      );
    }

    const activities = await stub.listAgentActivities(sessionId);
    return c.json({
      session: toSessionResponse(session, activities),
      provider: state.provider ?? null,
      compute: state.compute ?? null,
    });
  });

  app.openapi(createChildSessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }

    const parentIssue = await stub.getIssue(session.issueId);
    if (!parentIssue) {
      return c.json({ message: "Parent issue not found" }, 404);
    }
    if (!parentIssue.repo) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Parent issue has no repository",
      });
    }

    const active = await stub.countActiveChildSessions(parentIssue.id);
    const max = await stub.getMaxConcurrentAgentChildren();
    if (active >= max) {
      throw new VortexError({
        code: "TOO_MANY_REQUESTS",
        status: 429,
        message: `Maximum concurrent child sessions (${max}) reached`,
      });
    }

    const child = await stub.createIssue(
      {
        title: body.title,
        description: body.description,
        parentId: parentIssue.id,
        teamId: parentIssue.teamId,
        repo: body.repo ?? parentIssue.repo,
        priority: parentIssue.priority,
        status: "backlog",
      },
      identity.id
    );

    const resolvedAgentId = body.agentId ?? "devin";
    const providerConfig = await loadProviderConfig(
      c.env,
      stub,
      resolvedAgentId
    );
    const effectiveEnv = resolveAgentEnv(c.env, providerConfig ?? undefined);

    const childSession = await dispatchAgent(
      effectiveEnv,
      resolvedAgentId,
      organizationId,
      child,
      identity,
      body.model,
      getExecutionCtx(c)
    );

    const childAfter = await stub.getIssue(child.id);
    if (childAfter?.repo && childAfter?.branch) {
      await createRepoBranch(
        db,
        organizationId,
        childAfter.repo,
        childAfter.branch,
        childAfter.id
      );
    }

    return c.json({ session: childSession, issue: childAfter ?? child }, 201);
  });
}
