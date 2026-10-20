import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const memorySchema = z.object({
  id: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  kind: z.string(),
  // Caller-chosen lookup key — exact-match via ?key= on recall; a new fact
  // with the same key supersedes the old one.
  key: z.string().nullable(),
  fact: z.string(),
  sourceSessionId: z.string().nullable(),
  sourceAgentSlug: z.string().nullable(),
  validUntil: z.string().nullable(),
  createdAt: z.string(),
});

const recallRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/memory",
  tags: ["memory"],
  middleware: [rls("memory:view")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      entityType: z.string().optional(),
      entityId: z.string().optional(),
      kind: z.string().optional(),
      key: z.string().optional(),
      search: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Workspace memory facts",
      content: {
        "application/json": {
          schema: z.object({ memories: z.array(memorySchema) }),
        },
      },
    },
  },
});

const rememberRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/memory",
  tags: ["memory"],
  middleware: [rls("memory:create")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            entityType: z.string().min(1),
            entityId: z.string().min(1),
            kind: z.string().min(1),
            key: z.string().min(1).optional(),
            fact: z.string().min(1),
            validUntil: z.string().optional(),
            sourceAgentSlug: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Memory written",
      content: {
        "application/json": {
          schema: z.object({ id: z.string() }),
        },
      },
    },
  },
});

const getMemoryRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/memory/{id}",
  tags: ["memory"],
  middleware: [rls("memory:view")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "A single workspace memory fact by its row id",
      content: {
        "application/json": {
          schema: z.object({ memory: memorySchema }),
        },
      },
    },
    404: { description: "Memory not found" },
  },
});

const costsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/costs",
  tags: ["memory"],
  middleware: [rls("memory:view")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      agentSlug: z.string().optional(),
      since: z.string().optional(),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Lane cost ledger — per-session compute durations",
      content: {
        "application/json": {
          schema: z.object({
            costs: z.array(
              z.object({
                sessionId: z.string(),
                agentSlug: z.string().nullable(),
                issueId: z.string().nullable(),
                provider: z.string().nullable(),
                effort: z.string().nullable(),
                status: z.string(),
                createdAt: z.string(),
                settledAt: z.string(),
                durationMs: z.number(),
                attempts: z.number(),
              })
            ),
          }),
        },
      },
    },
  },
});

export function registerMemoryRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(recallRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const q = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const memories = await stub.memoryRecall({
      entityType: q.entityType,
      entityId: q.entityId,
      kind: q.kind,
      key: q.key,
      search: q.search,
      limit: q.limit ? Number(q.limit) : 25,
    });
    return c.json({ memories }, 200);
  });

  app.openapi(getMemoryRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const memory = await stub.memoryGet(id);
    if (!memory) {
      return c.json({ message: "Memory not found" }, 404);
    }
    return c.json({ memory }, 200);
  });

  app.openapi(rememberRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const id = await stub.memoryRemember({
      entityType: body.entityType,
      entityId: body.entityId,
      kind: body.kind,
      key: body.key ?? null,
      fact: body.fact,
      validUntil: body.validUntil ?? null,
      sourceAgentSlug: body.sourceAgentSlug ?? null,
    });
    return c.json({ id }, 200);
  });

  app.openapi(costsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const q = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const costs = await stub.listLaneCosts({
      agentSlug: q.agentSlug,
      since: q.since,
      limit: q.limit ? Number(q.limit) : 200,
    });
    return c.json({ costs }, 200);
  });
}
