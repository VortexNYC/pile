import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppContext } from "./middleware.js";
import { VortexError } from "../platform/errors.js";
import { rls } from "../platform/rls.js";
import { createD1 } from "../global/db.js";
import {
  listComments,
  createComment,
  getComment,
  updateComment,
  deleteComment,
} from "../global/comments.js";

const commentSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  issueId: z.string(),
  authorId: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createCommentBodySchema = z.object({
  body: z.string().min(1),
});

const listCommentsRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/issues/{issueId}/comments",
  tags: ["comments"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string(), issueId: z.string() }),
  },
  responses: {
    200: {
      description: "Comments list",
      content: {
        "application/json": {
          schema: z.object({ comments: z.array(commentSchema) }),
        },
      },
    },
  },
});

const createCommentRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/issues/{issueId}/comments",
  tags: ["comments"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string(), issueId: z.string() }),
    body: {
      content: {
        "application/json": { schema: createCommentBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Comment created",
      content: {
        "application/json": { schema: commentSchema },
      },
    },
  },
});

const getCommentRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/issues/{issueId}/comments/{id}",
  tags: ["comments"],
  middleware: [rls("read")],
  request: {
    params: z.object({
      workspaceId: z.string(),
      issueId: z.string(),
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Comment",
      content: {
        "application/json": { schema: commentSchema },
      },
    },
  },
});

const updateCommentRoute = createRoute({
  method: "patch",
  path: "/workspaces/{workspaceId}/issues/{issueId}/comments/{id}",
  tags: ["comments"],
  middleware: [rls("write")],
  request: {
    params: z.object({
      workspaceId: z.string(),
      issueId: z.string(),
      id: z.string(),
    }),
    body: {
      content: {
        "application/json": { schema: createCommentBodySchema },
      },
    },
  },
  responses: {
    200: {
      description: "Comment updated",
      content: {
        "application/json": { schema: commentSchema },
      },
    },
  },
});

const deleteCommentRoute = createRoute({
  method: "delete",
  path: "/workspaces/{workspaceId}/issues/{issueId}/comments/{id}",
  tags: ["comments"],
  middleware: [rls("write")],
  request: {
    params: z.object({
      workspaceId: z.string(),
      issueId: z.string(),
      id: z.string(),
    }),
  },
  responses: {
    204: { description: "Comment deleted" },
  },
});

export function registerCommentRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listCommentsRoute, async (c) => {
    const { workspaceId, issueId } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const items = await listComments(db, workspaceId, issueId);
    return c.json({ comments: items });
  });

  app.openapi(createCommentRoute, async (c) => {
    const { workspaceId, issueId } = c.req.valid("param");
    const { body } = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await createComment(db, workspaceId, {
      issueId,
      authorId: c.var.workspaceIdentity.id,
      body,
    });
    return c.json(item, 201);
  });

  app.openapi(getCommentRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    const item = await getComment(db, workspaceId, id);
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    return c.json(item);
  });

  app.openapi(updateCommentRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const { body } = c.req.valid("json");
    const db = createD1(c.env.D1);
    const item = await updateComment(db, workspaceId, id, { body });
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    return c.json(item);
  });

  app.openapi(deleteCommentRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const db = createD1(c.env.D1);
    await deleteComment(db, workspaceId, id);
    return c.body(null, 204);
  });
}
