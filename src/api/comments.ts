import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";

import { createD1 } from "../global/db.js";
import { getInstallationToken } from "../global/github-auth.js";
import { findGithubInstallation } from "../global/github-installations.js";
import { findRepoIssueByIssueId } from "../global/repo-issues.js";
import { canAccessTeam } from "../global/teams.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext } from "../platform/middleware.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";

async function getStub(env: WorkerEnv, organizationId: string) {
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
  await stub.setOrganizationId(organizationId);
  return stub;
}

const commentSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  issueId: z.string(),
  authorId: z.string().nullable(),
  body: z.string(),
  externalId: z.string().nullable(),
  externalSource: z.string().nullable(),
  externalAuthor: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createCommentBodySchema = z.object({
  body: z.string().min(1),
});

const listCommentsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/comments",
  tags: ["comments"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
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
  path: "/workspaces/{organizationId}/issues/{issueId}/comments",
  tags: ["comments"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
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
  path: "/workspaces/{organizationId}/issues/{issueId}/comments/{id}",
  tags: ["comments"],
  middleware: [rls("read")],
  request: {
    params: z.object({
      organizationId: z.string(),
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
  path: "/workspaces/{organizationId}/issues/{issueId}/comments/{id}",
  tags: ["comments"],
  middleware: [rls("write")],
  request: {
    params: z.object({
      organizationId: z.string(),
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
  path: "/workspaces/{organizationId}/issues/{issueId}/comments/{id}",
  tags: ["comments"],
  middleware: [rls("write")],
  request: {
    params: z.object({
      organizationId: z.string(),
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
    const { organizationId, issueId } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const issueStub = await getStub(c.env, organizationId);
    const issue = await issueStub.getIssue(issueId);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    const allowed = await canAccessTeam(db, issue.teamId, identity);
    if (!allowed) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    const items = await issueStub.listComments(issueId);
    return c.json({ comments: items });
  });

  app.openapi(createCommentRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const { body } = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const issueStub = await getStub(c.env, organizationId);
    const issue = await issueStub.getIssue(issueId);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    const allowed = await canAccessTeam(db, issue.teamId, identity);
    if (!allowed) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Cannot comment on this issue",
      });
    }
    const created = await issueStub.createComment({
      issueId,
      authorId: identity.id,
      body,
    });
    if (!created) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 500,
        message: "Failed to create comment",
      });
    }
    let item = created;

    await issueStub.indexComment({
      id: item.id,
      issueId,
      teamId: issue.teamId,
      body: item.body,
      createdAt: item.createdAt,
    });

    const mapping = await findRepoIssueByIssueId(db, issueId);
    if (mapping) {
      const installation = await findGithubInstallation(db, mapping.repo);
      if (installation) {
        const token = await getInstallationToken(
          c.env,
          installation.installationId
        );
        if (token) {
          const response = await fetch(
            `https://api.github.com/repos/${mapping.repo}/issues/${mapping.issueNumber}/comments`,
            {
              method: "POST",
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2022-11-28",
                "Content-Type": "application/json",
                "User-Agent": "vortex",
              },
              body: JSON.stringify({ body }),
            }
          );
          if (response.ok) {
            const raw: unknown = await response.json();
            const parsed = z.object({ id: z.number().int() }).safeParse(raw);
            if (parsed.success) {
              const externalId = parsed.data.id.toString();
              const updated = await issueStub.updateComment(item.id, {
                body,
                externalId,
                externalSource: "github",
              });
              if (updated) {
                item = updated;
              }
            }
          }
        }
      }
    }

    await issueStub.emitCommentCreated(item, issue, identity.id);

    return c.json(item, 201);
  });

  app.openapi(getCommentRoute, async (c) => {
    const { organizationId, issueId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const item = await (await getStub(c.env, organizationId)).getComment(id);
    if (!item || item.issueId !== issueId) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    const issueStub = await getStub(c.env, organizationId);
    const issue = await issueStub.getIssue(item.issueId);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    const allowed = await canAccessTeam(db, issue.teamId, identity);
    if (!allowed) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    return c.json(item);
  });

  app.openapi(updateCommentRoute, async (c) => {
    const { organizationId, issueId, id } = c.req.valid("param");
    const { body } = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const existing = await (
      await getStub(c.env, organizationId)
    ).getComment(id);
    if (!existing || existing.issueId !== issueId) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    const issueStub = await getStub(c.env, organizationId);
    const issue = await issueStub.getIssue(existing.issueId);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    const allowed = await canAccessTeam(db, issue.teamId, identity);
    if (!allowed) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    const item = await issueStub.updateComment(id, { body });
    if (!item) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    await issueStub.emitCommentUpdated(item, issue);
    return c.json(item);
  });

  app.openapi(deleteCommentRoute, async (c) => {
    const { organizationId, issueId, id } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const existing = await (
      await getStub(c.env, organizationId)
    ).getComment(id);
    if (!existing || existing.issueId !== issueId) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    const issueStub = await getStub(c.env, organizationId);
    const issue = await issueStub.getIssue(existing.issueId);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    const allowed = await canAccessTeam(db, issue.teamId, identity);
    if (!allowed) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Comment not found",
      });
    }
    await issueStub.deleteComment(id);
    await issueStub.emitCommentDeleted(id, issueId);
    return c.body(null, 204);
  });
}
