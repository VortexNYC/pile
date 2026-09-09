import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";

import { createD1 } from "../global/db.js";
import { teamMember } from "../global/schema.js";
import { createAuth } from "../platform/auth.js";
import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import { resolveMentions } from "./mentions.js";
import { getWorkspaceStub } from "./stub.js";

// `content` is a BlockNote document: a JSON array of blocks. Validated
// loosely — the array-of-objects shape is the contract; block internals are
// owned by the editor schema (BlockNote/TipTap).
const blockSchema = z.array(z.record(z.string(), z.unknown()));
// Agents write markdown; editors write blocks.
const contentInputSchema = z.union([blockSchema, z.string()]);

const documentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  title: z.string(),
  icon: z.string().nullable(),
  content: contentInputSchema,
  contentFormat: z.enum(["blocks", "markdown"]),
  slug: z.string().nullable(),
  projectId: z.string().nullable(),
  issueId: z.string().nullable(),
  initiativeId: z.string().nullable(),
  parentDocumentId: z.string().nullable(),
  spaceId: z.string().nullable(),
  isTemplate: z.boolean(),
  createdById: z.string(),
  updatedById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  trashedAt: z.string().nullable(),
});

const createDocumentSchema = z.object({
  title: z.string().min(1),
  icon: z.string().optional(),
  content: contentInputSchema.optional(),
  contentFormat: z.enum(["blocks", "markdown"]).optional(),
  slug: z.string().optional(),
  projectId: z.string().optional(),
  issueId: z.string().optional(),
  initiativeId: z.string().optional(),
  parentDocumentId: z.string().optional(),
  spaceId: z.string().optional(),
  isTemplate: z.boolean().optional(),
});

const updateDocumentSchema = z.object({
  title: z.string().min(1).optional(),
  icon: z.string().nullable().optional(),
  content: contentInputSchema.optional(),
  contentFormat: z.enum(["blocks", "markdown"]).optional(),
  slug: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  issueId: z.string().nullable().optional(),
  initiativeId: z.string().nullable().optional(),
  parentDocumentId: z.string().nullable().optional(),
  spaceId: z.string().nullable().optional(),
  isTemplate: z.boolean().optional(),
});

const historyEntrySchema = z.object({
  id: z.string(),
  documentId: z.string(),
  content: contentInputSchema,
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
  spaceId: string | null;
  isTemplate: boolean;
  contentFormat: "blocks" | "markdown";
  slug: string | null;
  createdById: string;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
}) {
  return {
    ...row,
    content:
      row.contentFormat === "markdown"
        ? row.content
        : (JSON.parse(row.content) as Record<string, unknown>[]),
  };
}

function notFound(): never {
  throw new VortexError({
    code: "NOT_FOUND",
    status: 404,
    message: "Document not found",
  });
}

// Per-doc grants: when a doc has any permission rows, only listed actors
// (+ workspace admins, + members of granted Better Auth teams) get in.
// Default-open otherwise.
async function assertDocAccess(
  c: {
    env: WorkerEnv;
    get: (key: "workspaceIdentity") => WorkspaceIdentity;
    req: {
      param: (key: string) => string;
      raw: { headers: Headers };
    };
  },
  stub: {
    documentAccessLevel(
      documentId: string,
      actorId: string,
      teamIds: string[]
    ): Promise<"view" | "edit" | null>;
  },
  documentId: string,
  required: "view" | "edit"
) {
  const organizationId = c.req.param("organizationId");
  const identity = c.get("workspaceIdentity");
  if (identity.permissions.includes("admin")) return;
  // Type-level ceiling: the member's Better Auth role (incl. dynamic
  // organizationRole rows) must allow the action on `document`. Agents
  // authenticate by org-scoped API key, not session — instance grants only.
  if (identity.type === "user" && identity.role) {
    const auth = createAuth(c.env);
    const result = await auth.api.hasPermission({
      body: {
        organizationId,
        permissions: { document: [required] },
      },
      headers: c.req.raw.headers,
    });
    if (!result.success) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: `Role does not allow ${required} on documents`,
      });
    }
  }
  // Resolve Better Auth team memberships for user identities; API-key
  // actors (agents) hold grants directly on their key identity.
  const teamIds =
    identity.type === "user"
      ? (
          await createD1(c.env.D1)
            .select({ teamId: teamMember.teamId })
            .from(teamMember)
            .where(eq(teamMember.userId, identity.id))
            .all()
        ).map((row) => row.teamId)
      : [];
  const level = await stub.documentAccessLevel(
    documentId,
    identity.id,
    teamIds
  );
  if (level === null || (required === "edit" && level === "view")) {
    if (level === null) return notFound();
    throw new VortexError({
      code: "FORBIDDEN",
      status: 403,
      message: "View-only access to this document",
    });
  }
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
      spaceId: z.string().optional(),
      isTemplate: z
        .string()
        .transform((v) => v === "true")
        .optional(),
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

const spaceSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  publicSharing: z.boolean(),
  createdById: z.string(),
  createdAt: z.string(),
});

const shareSchema = z.object({
  token: z.string(),
  documentId: z.string(),
  includeChildren: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
});

const docCommentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  issueId: z.string().nullable(),
  documentId: z.string().nullable(),
  authorId: z.string().nullable(),
  body: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const listSpacesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/document-spaces",
  tags: ["documents"],
  middleware: [rls("read")],
  request: { params: z.object({ organizationId: z.string() }) },
  responses: {
    200: {
      description: "Document spaces",
      content: {
        "application/json": {
          schema: z.object({ spaces: z.array(spaceSchema) }),
        },
      },
    },
  },
});

const createSpaceRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/document-spaces",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            description: z.string().optional(),
            icon: z.string().optional(),
            publicSharing: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Space created",
      content: { "application/json": { schema: spaceSchema } },
    },
  },
});

const updateSpaceRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/document-spaces/{id}",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).optional(),
            description: z.string().nullable().optional(),
            icon: z.string().nullable().optional(),
            publicSharing: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Space updated",
      content: { "application/json": { schema: spaceSchema } },
    },
    404: { description: "Space not found" },
  },
});

const deleteSpaceRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/document-spaces/{id}",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Space deleted; documents are unlinked" },
    404: { description: "Space not found" },
  },
});

const listDocumentCommentsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/documents/{id}/comments",
  tags: ["documents"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Document comments",
      content: {
        "application/json": {
          schema: z.object({ comments: z.array(docCommentSchema) }),
        },
      },
    },
    404: { description: "Document not found" },
  },
});

const createDocumentCommentRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/documents/{id}/comments",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": { schema: z.object({ body: z.string().min(1) }) },
      },
    },
  },
  responses: {
    201: {
      description: "Comment created",
      content: { "application/json": { schema: docCommentSchema } },
    },
    404: { description: "Document not found" },
  },
});

const resolveCommentRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/comments/{commentId}/resolve",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), commentId: z.string() }),
  },
  responses: {
    200: {
      description: "Comment resolved",
      content: { "application/json": { schema: docCommentSchema } },
    },
    404: { description: "Comment not found" },
  },
});

const unresolveCommentRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/comments/{commentId}/unresolve",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), commentId: z.string() }),
  },
  responses: {
    200: {
      description: "Comment unresolved",
      content: { "application/json": { schema: docCommentSchema } },
    },
    404: { description: "Comment not found" },
  },
});

const createShareRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/documents/{id}/share",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            includeChildren: z.boolean().optional(),
            expiresAt: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Share link created",
      content: { "application/json": { schema: shareSchema } },
    },
    404: { description: "Document not found" },
  },
});

const deleteShareRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/documents/{id}/share/{token}",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({
      organizationId: z.string(),
      id: z.string(),
      token: z.string(),
    }),
  },
  responses: {
    204: { description: "Share revoked" },
    404: { description: "Share not found" },
  },
});

// Public share read — the token is the capability; no workspace auth.
const readSharedRoute = createRoute({
  method: "get",
  path: "/shared-documents/{organizationId}/{token}",
  tags: ["documents"],
  request: {
    params: z.object({ organizationId: z.string(), token: z.string() }),
  },
  responses: {
    200: {
      description: "Shared document",
      content: {
        "application/json": {
          schema: z.object({
            document: documentSchema,
            children: z.array(documentSchema).optional(),
          }),
        },
      },
    },
    404: { description: "Share not found or expired" },
  },
});

const watchRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/documents/{id}/watch",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: { description: "Watching document" },
    404: { description: "Document not found" },
  },
});

const unwatchRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/documents/{id}/watch",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Unwatched" },
  },
});

const searchRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/documents/search",
  tags: ["documents"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({ q: z.string().min(1) }),
  },
  responses: {
    200: {
      description: "Matching documents",
      content: {
        "application/json": {
          schema: z.object({ documents: z.array(documentSchema) }),
        },
      },
    },
  },
});

const permissionSchema = z.object({
  // User id, API-key id, or Better Auth team id (actorType="team").
  actorId: z.string(),
  actorType: z.enum(["user", "agent", "team"]).optional(),
  level: z.enum(["view", "edit"]),
});

const setPermissionRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/documents/{id}/permissions",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: { content: { "application/json": { schema: permissionSchema } } },
  },
  responses: {
    200: { description: "Permission set" },
    404: { description: "Document not found" },
  },
});

const revokePermissionRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/documents/{id}/permissions/{actorId}",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({
      organizationId: z.string(),
      id: z.string(),
      actorId: z.string(),
    }),
  },
  responses: {
    204: { description: "Permission revoked" },
  },
});

const listLinksRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/documents/{id}/links",
  tags: ["documents"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Outgoing links from this document",
      content: {
        "application/json": {
          schema: z.object({
            links: z.array(
              z.object({
                targetType: z.string(),
                targetId: z.string(),
              })
            ),
          }),
        },
      },
    },
  },
});

const listBacklinksRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/documents/{id}/backlinks",
  tags: ["documents"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Documents that link to this document",
      content: {
        "application/json": {
          schema: z.object({ documents: z.array(z.string()) }),
        },
      },
    },
  },
});

const issueDocumentsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/documents",
  tags: ["documents"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
  },
  responses: {
    200: {
      description: "Documents that link to this issue",
      content: {
        "application/json": {
          schema: z.object({ documents: z.array(documentSchema) }),
        },
      },
    },
  },
});

const restoreVersionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/documents/{id}/history/{entryId}/restore",
  tags: ["documents"],
  middleware: [rls("write")],
  request: {
    params: z.object({
      organizationId: z.string(),
      id: z.string(),
      entryId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Document restored to the given history entry",
      content: { "application/json": { schema: documentSchema } },
    },
    404: { description: "Document or history entry not found" },
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
      spaceId: query.spaceId,
      isTemplate: query.isTemplate,
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
    await assertDocAccess(c, stub, id, "view");
    return c.json(toResponse(doc));
  });

  app.openapi(updateRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    await assertDocAccess(c, stub, id, "edit");
    const doc = await stub.updateDocument(id, input, identity.id);
    if (!doc) return notFound();
    return c.json(toResponse(doc));
  });

  app.openapi(deleteRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const identity = c.get("workspaceIdentity");
    await assertDocAccess(c, stub, id, "edit");
    const deleted = await stub.deleteDocument(id, identity.id);
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
      history: history.map((h) => ({
        id: h.id,
        documentId: h.documentId,
        content: (() => {
          try {
            return JSON.parse(h.content) as Record<string, unknown>[];
          } catch {
            return h.content;
          }
        })(),
        actorId: h.actorId,
        createdAt: h.createdAt,
      })),
    });
  });

  app.openapi(listSpacesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json({ spaces: await stub.listDocumentSpaces() });
  });

  app.openapi(createSpaceRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    const space = await stub.createDocumentSpace({
      ...input,
      createdById: identity.id,
    });
    return c.json(space, 201);
  });

  app.openapi(updateSpaceRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    const space = await stub.updateDocumentSpace(id, input);
    if (!space) return notFound();
    return c.json(space);
  });

  app.openapi(deleteSpaceRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    if (!(await stub.deleteDocumentSpace(id))) return notFound();
    return c.body(null, 204);
  });

  app.openapi(listDocumentCommentsRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const doc = await stub.getDocument(id);
    if (!doc) return notFound();
    return c.json({ comments: await stub.listDocumentComments(id) });
  });

  app.openapi(createDocumentCommentRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const { body } = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    const doc = await stub.getDocument(id);
    if (!doc) return notFound();
    const mentions = await resolveMentions(
      createD1(c.env.D1),
      organizationId,
      body
    );
    const comment = await stub.createComment({
      documentId: id,
      authorId: identity.id,
      body,
      mentions,
    });
    return c.json(comment, 201);
  });

  app.openapi(resolveCommentRoute, async (c) => {
    const { organizationId, commentId } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    const comment = await stub.resolveComment(commentId, identity.id);
    if (!comment) return notFound();
    return c.json(comment);
  });

  app.openapi(unresolveCommentRoute, async (c) => {
    const { organizationId, commentId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const comment = await stub.unresolveComment(commentId);
    if (!comment) return notFound();
    return c.json(comment);
  });

  app.openapi(createShareRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    const doc = await stub.getDocument(id);
    if (!doc) return notFound();
    const share = await stub.createDocumentShare({
      documentId: id,
      includeChildren: input.includeChildren,
      expiresAt: input.expiresAt,
      createdById: identity.id,
    });
    return c.json(share, 201);
  });

  app.openapi(deleteShareRoute, async (c) => {
    const { organizationId, token } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    if (!(await stub.deleteDocumentShare(token))) return notFound();
    return c.body(null, 204);
  });

  app.openapi(readSharedRoute, async (c) => {
    const { organizationId, token } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const share = await stub.getDocumentShareByToken(token);
    if (!share || share.organizationId !== organizationId) return notFound();
    if (share.expiresAt && share.expiresAt < new Date().toISOString())
      return notFound();
    const doc = await stub.getDocument(share.documentId);
    if (!doc || doc.trashedAt) return notFound();
    const children = share.includeChildren
      ? await stub.listDocuments({ parentDocumentId: doc.id })
      : undefined;
    return c.json({
      document: toResponse(doc),
      children: children?.map(toResponse),
    });
  });

  app.openapi(watchRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    const doc = await stub.getDocument(id);
    if (!doc) return notFound();
    await stub.watchDocument(id, identity.id);
    return c.json({ watching: true });
  });

  app.openapi(unwatchRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.unwatchDocument(id, identity.id);
    return c.body(null, 204);
  });

  app.openapi(searchRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { q } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const ids = await stub.searchDocuments(q);
    const docs = (
      await Promise.all(ids.map((id) => stub.getDocument(id)))
    ).filter((d) => d !== undefined);
    return c.json({ documents: docs.map(toResponse) });
  });

  app.openapi(setPermissionRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
    const stub = getWorkspaceStub(c.env, organizationId);
    await assertDocAccess(c, stub, id, "edit");
    const doc = await stub.getDocument(id);
    if (!doc) return notFound();
    const grant = await stub.setDocumentPermission(
      id,
      input.actorId,
      input.actorType ?? "user",
      input.level
    );
    return c.json(grant);
  });

  app.openapi(revokePermissionRoute, async (c) => {
    const { organizationId, id, actorId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    await assertDocAccess(c, stub, id, "edit");
    await stub.revokeDocumentPermission(id, actorId);
    return c.body(null, 204);
  });

  app.openapi(listLinksRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const links = await stub.listDocumentLinks({ documentId: id });
    return c.json({
      links: links.map((l) => ({
        targetType: l.targetType,
        targetId: l.targetId,
      })),
    });
  });

  app.openapi(listBacklinksRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const links = await stub.listDocumentLinks({
      targetType: "document",
      targetId: id,
    });
    return c.json({ documents: links.map((l) => l.documentId) });
  });

  app.openapi(issueDocumentsRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const links = await stub.listDocumentLinks({
      targetType: "issue",
      targetId: issueId,
    });
    const direct = await stub.listDocuments({ issueId });
    const linked = await Promise.all(
      links.map((l) => stub.getDocument(l.documentId))
    );
    const seen = new Set<string>();
    const docs = [...direct, ...linked.filter((d) => d !== undefined)].filter(
      (d) => {
        if (seen.has(d.id)) return false;
        seen.add(d.id);
        return true;
      }
    );
    return c.json({ documents: docs.map(toResponse) });
  });

  app.openapi(restoreVersionRoute, async (c) => {
    const { organizationId, id, entryId } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const stub = getWorkspaceStub(c.env, organizationId);
    await assertDocAccess(c, stub, id, "edit");
    const doc = await stub.restoreDocumentVersion(id, entryId, identity.id);
    if (!doc) return notFound();
    return c.json(toResponse(doc));
  });
}
