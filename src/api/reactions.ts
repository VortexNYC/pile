import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import emojiRegex from "emoji-regex";

import { createD1 } from "../global/db.js";
import {
  createReaction,
  deleteReaction,
  getReaction,
  listReactions,
} from "../global/reactions.js";
import { canAccessTeam } from "../global/teams.js";
import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import type { Issue } from "../types/workspace.js";

const reactionSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  actorId: z.string(),
  emoji: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createReactionSchema = z.object({
  emoji: z.string().refine(
    (value) => {
      const match = value.match(emojiRegex());
      return match !== null && match[0] === value;
    },
    { message: "must be a single valid emoji" }
  ),
});

async function getIssue(
  stub: { getIssue(id: string): Promise<Issue | undefined> },
  id: string
): Promise<Issue> {
  const issue = await stub.getIssue(id);
  if (!issue) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Issue not found",
    });
  }
  return issue;
}

async function assertIssueAccess(
  db: ReturnType<typeof createD1>,
  issue: Issue,
  identity: WorkspaceIdentity
): Promise<void> {
  const allowed = await canAccessTeam(db, issue.teamId, identity);
  if (!allowed) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Issue not found",
    });
  }
}

async function getStub(env: WorkerEnv, organizationId: string) {
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
  await stub.setOrganizationId(organizationId);
  return stub;
}

const listIssueReactionsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{id}/reactions",
  tags: ["reactions"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Issue reactions",
      content: {
        "application/json": {
          schema: z.object({ reactions: z.array(reactionSchema) }),
        },
      },
    },
  },
});

const createIssueReactionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/issues/{id}/reactions",
  tags: ["reactions"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: { "application/json": { schema: createReactionSchema } },
    },
  },
  responses: {
    201: {
      description: "Reaction created",
      content: {
        "application/json": { schema: reactionSchema },
      },
    },
  },
});

const listCommentReactionsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/comments/{commentId}/reactions",
  tags: ["reactions"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), commentId: z.string() }),
  },
  responses: {
    200: {
      description: "Comment reactions",
      content: {
        "application/json": {
          schema: z.object({ reactions: z.array(reactionSchema) }),
        },
      },
    },
  },
});

const createCommentReactionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/comments/{commentId}/reactions",
  tags: ["reactions"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), commentId: z.string() }),
    body: {
      content: { "application/json": { schema: createReactionSchema } },
    },
  },
  responses: {
    201: {
      description: "Reaction created",
      content: {
        "application/json": { schema: reactionSchema },
      },
    },
  },
});

const deleteReactionRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/reactions/{reactionId}",
  tags: ["reactions"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), reactionId: z.string() }),
  },
  responses: {
    204: { description: "Reaction deleted" },
  },
});

export function registerReactionRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listIssueReactionsRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);
    const issue = await getIssue(stub, id);
    await assertIssueAccess(db, issue, identity);
    const rows = await listReactions(db, organizationId, "issue", id);
    return c.json({ reactions: rows });
  });

  app.openapi(createIssueReactionRoute, async (c) => {
    const { id, organizationId } = c.req.valid("param");
    const { emoji } = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);
    const issue = await getIssue(stub, id);
    await assertIssueAccess(db, issue, identity);
    const reaction = await createReaction(db, {
      organizationId,
      targetType: "issue",
      targetId: id,
      actorId: identity.id,
      emoji,
    });
    return c.json(reaction, 201);
  });

  app.openapi(listCommentReactionsRoute, async (c) => {
    const { organizationId, commentId } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const comment = await (
      await getStub(c.env, organizationId)
    ).getComment(commentId);
    if (!comment) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    const stub = await getStub(c.env, organizationId);
    const issue = await getIssue(stub, comment.issueId);
    await assertIssueAccess(db, issue, identity);
    const rows = await listReactions(db, organizationId, "comment", commentId);
    return c.json({ reactions: rows });
  });

  app.openapi(createCommentReactionRoute, async (c) => {
    const { organizationId, commentId } = c.req.valid("param");
    const { emoji } = c.req.valid("json");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const comment = await (
      await getStub(c.env, organizationId)
    ).getComment(commentId);
    if (!comment) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    const stub = await getStub(c.env, organizationId);
    const issue = await getIssue(stub, comment.issueId);
    await assertIssueAccess(db, issue, identity);
    const reaction = await createReaction(db, {
      organizationId,
      targetType: "comment",
      targetId: commentId,
      actorId: identity.id,
      emoji,
    });
    return c.json(reaction, 201);
  });

  app.openapi(deleteReactionRoute, async (c) => {
    const { organizationId, reactionId } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const reaction = await getReaction(db, organizationId, reactionId);
    if (!reaction) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Reaction not found",
      });
    }
    if (
      reaction.actorId !== identity.id &&
      !identity.permissions.includes("admin")
    ) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Cannot delete this reaction",
      });
    }
    await deleteReaction(db, organizationId, reactionId);
    return c.body(null, 204);
  });
}
