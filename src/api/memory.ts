import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

const memorySchema = z.object({
  id: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  kind: z.string(),
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

// PILE-616 — entity profile. Registered before /memory/{id} routes so the
// literal "profile" segment never resolves as an id.
const profileRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/memory/profile",
  tags: ["memory"],
  middleware: [rls("memory:view")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      entityType: z.string().min(1),
      entityId: z.string().min(1),
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Entity memory profile — static vs dynamic facts",
      content: {
        "application/json": {
          schema: z.object({
            entityType: z.string(),
            entityId: z.string(),
            staticFacts: z.array(memorySchema),
            dynamicFacts: z.array(memorySchema),
            byKind: z.record(z.string(), z.array(memorySchema)),
            summary: z.string(),
          }),
        },
      },
    },
  },
});

// PILE-617 — batch memory write + document→memory extraction.
const batchRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/memory/batch",
  tags: ["memory"],
  middleware: [rls("memory:create")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            memories: z
              .array(
                z.object({
                  entityType: z.string().min(1),
                  entityId: z.string().min(1),
                  kind: z.string().min(1),
                  fact: z.string().min(1),
                  validUntil: z.string().nullable().optional(),
                  sourceAgentSlug: z.string().nullable().optional(),
                  sourceSessionId: z.string().nullable().optional(),
                })
              )
              .optional(),
            documentIds: z.array(z.string()).optional(),
            sourceAgentSlug: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Memories written",
      content: {
        "application/json": {
          schema: z.object({
            ids: z.array(z.string()),
            count: z.number(),
            extractedFromDocuments: z.number(),
          }),
        },
      },
    },
  },
});

// PILE-627 — "dreaming": distill structured facts from text, a session,
// a document, or an issue and persist them as memory.
const extractRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/memory/extract",
  tags: ["memory"],
  middleware: [rls("memory:create")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            sessionId: z.string().optional(),
            issueId: z.string().optional(),
            documentId: z.string().optional(),
            text: z.string().optional(),
            entityType: z.string().optional(),
            entityId: z.string().optional(),
            sourceAgentSlug: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Facts extracted and persisted",
      content: {
        "application/json": {
          schema: z.object({
            ids: z.array(z.string()),
            facts: z.array(
              z.object({
                id: z.string(),
                entityType: z.string(),
                entityId: z.string(),
                kind: z.string(),
                fact: z.string(),
              })
            ),
          }),
        },
      },
    },
  },
});

// PILE-628 — patch a memory fact in place.
const updateRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/memory/{id}",
  tags: ["memory"],
  middleware: [rls("memory:create")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            fact: z.string().min(1).optional(),
            kind: z.string().min(1).optional(),
            validUntil: z.string().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Memory fact updated",
      content: {
        "application/json": {
          schema: z.object({ memory: memorySchema }),
        },
      },
    },
    404: { description: "Memory fact not found" },
  },
});

// PILE-628 — forget a memory fact and its superseded history.
const deleteRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/memory/{id}",
  tags: ["memory"],
  middleware: [rls("memory:create")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Memory fact forgotten",
      content: {
        "application/json": {
          schema: z.object({
            deleted: z.boolean(),
            id: z.string(),
            deletedCount: z.number(),
          }),
        },
      },
    },
    404: { description: "Memory fact not found" },
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
      search: q.search,
      limit: q.limit ? Number(q.limit) : 25,
    });
    return c.json({ memories }, 200);
  });

  app.openapi(rememberRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const id = await stub.memoryRemember({
      entityType: body.entityType,
      entityId: body.entityId,
      kind: body.kind,
      fact: body.fact,
      validUntil: body.validUntil ?? null,
      sourceAgentSlug: body.sourceAgentSlug ?? null,
    });
    return c.json({ id }, 200);
  });

  app.openapi(profileRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const q = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const profile = await stub.memoryProfile({
      entityType: q.entityType,
      entityId: q.entityId,
      limit: q.limit ? Number(q.limit) : undefined,
    });
    return c.json(profile, 200);
  });

  app.openapi(batchRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const res = await stub.memoryRememberBatch({
      memories: body.memories,
      documentIds: body.documentIds,
      sourceAgentSlug: body.sourceAgentSlug ?? null,
    });
    return c.json(res, 200);
  });

  app.openapi(extractRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const res = await stub.memoryExtract({
      sessionId: body.sessionId,
      issueId: body.issueId,
      documentId: body.documentId,
      text: body.text,
      entityType: body.entityType,
      entityId: body.entityId,
      sourceAgentSlug: body.sourceAgentSlug ?? null,
    });
    return c.json(res, 200);
  });

  app.openapi(updateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const body = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const actorId = c.get("workspaceIdentity").id;
    const memory = await stub.memoryUpdate(
      id,
      {
        fact: body.fact,
        kind: body.kind,
        validUntil: body.validUntil,
      },
      actorId
    );
    if (!memory)
      throw VortexError.fromCode("NOT_FOUND", "Memory fact not found");
    return c.json({ memory }, 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const actorId = c.get("workspaceIdentity").id;
    const res = await stub.memoryForget(id, actorId);
    if (!res.deleted)
      throw VortexError.fromCode("NOT_FOUND", "Memory fact not found");
    return c.json(
      { deleted: true, id, deletedCount: res.deletedIds.length },
      200
    );
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
