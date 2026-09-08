import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { getWorkspaceStub } from "./stub.js";

// `content` is a BlockNote document: a JSON array of blocks. Validated
// loosely — the array-of-objects shape is the contract; block internals are
// owned by the editor schema (BlockNote/TipTap).
const blockSchema = z.array(z.record(z.string(), z.unknown()));

const documentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  title: z.string(),
  icon: z.string().nullable(),
  content: blockSchema,
  projectId: z.string().nullable(),
  issueId: z.string().nullable(),
  initiativeId: z.string().nullable(),
  parentDocumentId: z.string().nullable(),
  createdById: z.string(),
  updatedById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  trashedAt: z.string().nullable(),
});

const createDocumentSchema = z.object({
  title: z.string().min(1),
  icon: z.string().optional(),
  content: blockSchema.optional(),
  projectId: z.string().optional(),
  issueId: z.string().optional(),
  initiativeId: z.string().optional(),
  parentDocumentId: z.string().optional(),
});

const updateDocumentSchema = z.object({
  title: z.string().min(1).optional(),
  icon: z.string().nullable().optional(),
  content: blockSchema.optional(),
  projectId: z.string().nullable().optional(),
  issueId: z.string().nullable().optional(),
  initiativeId: z.string().nullable().optional(),
  parentDocumentId: z.string().nullable().optional(),
});

const historyEntrySchema = z.object({
  id: z.string(),
  documentId: z.string(),
  content: blockSchema,
  actorId: z.string(),
  createdAt: z.string(),
});

function toResponse(row: {
  id: string;
  organizationId: string;
  title: string;
  icon: string | null;
  content: string;
  projectId: string | null;
  issueId: string | null;
  initiativeId: string | null;
  parentDocumentId: string | null;
  createdById: string;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
}) {
  return {
    ...row,
    content: JSON.parse(row.content) as Record<string, unknown>[],
  };
}

function notFound(): never {
  throw new VortexError({
    code: "NOT_FOUND",
    status: 404,
    message: "Document not found",
  });
}

const listRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/documents",
  tags: ["documents"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      projectId: z.string().optional(),
      issueId: z.string().optional(),
      initiativeId: z.string().optional(),
      parentDocumentId: z.string().optional(),
      includeTrashed: z
        .string()
        .transform((v) => v === "true")
        .optional(),
    }),
  },
  responses: {
    200: {
      description: "Document list",
      content: {
        "application/json": {
          schema: z.object({ documents: z.array(documentSchema) }),
        },
      },
    },
  },
});

const createRouteDef = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/documents",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: { "application/json": { schema: createDocumentSchema } },
    },
  },
  responses: {
    201: {
      description: "Document created",
      content: { "application/json": { schema: documentSchema } },
    },
  },
});

const getRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/documents/{id}",
  tags: ["documents"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Document",
      content: { "application/json": { schema: documentSchema } },
    },
    404: { description: "Document not found" },
  },
});

const updateRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/documents/{id}",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: { "application/json": { schema: updateDocumentSchema } },
    },
  },
  responses: {
    200: {
      description: "Document updated",
      content: { "application/json": { schema: documentSchema } },
    },
    404: { description: "Document not found" },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/documents/{id}",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Document deleted" },
    404: { description: "Document not found" },
  },
});

const restoreRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/documents/{id}/restore",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Document restored",
      content: { "application/json": { schema: documentSchema } },
    },
    404: { description: "Document not found" },
  },
});

const historyRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/documents/{id}/history",
  tags: ["documents"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Document content history, newest first",
      content: {
        "application/json": {
          schema: z.object({ history: z.array(historyEntrySchema) }),
        },
      },
    },
    404: { description: "Document not found" },
  },
});

export function registerDocumentRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const rows = await stub.listDocuments({
      projectId: query.projectId,
      issueId: query.issueId,
      initiativeId: query.initiativeId,
      parentDocumentId: query.parentDocumentId,
      includeTrashed: query.includeTrashed,
    });
    return c.json({ documents: rows.map(toResponse) });
  });

  app.openapi(createRouteDef, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    const doc = await stub.createDocument({
      ...input,
      createdById: identity.id,
    });
    return c.json(toResponse(doc), 201);
  });

  app.openapi(getRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const doc = await stub.getDocument(id);
    if (!doc) return notFound();
    return c.json(toResponse(doc));
  });

  app.openapi(updateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    const doc = await stub.updateDocument(id, input, identity.id);
    if (!doc) return notFound();
    return c.json(toResponse(doc));
  });

  app.openapi(deleteRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const deleted = await stub.deleteDocument(id);
    if (!deleted) return notFound();
    return c.body(null, 204);
  });

  app.openapi(restoreRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    const doc = await stub.updateDocument(id, { trashedAt: null }, identity.id);
    if (!doc) return notFound();
    return c.json(toResponse(doc));
  });

  app.openapi(historyRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const doc = await stub.getDocument(id);
    if (!doc) return notFound();
    const history = await stub.listDocumentHistory(id);
    return c.json({
      history: history.map((h) =>
        Object.assign({}, h, {
          content: JSON.parse(h.content) as Record<string, unknown>[],
        })
      ),
    });
  });
}
