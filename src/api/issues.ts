import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../platform/env.js";
import type { WorkspaceToken } from "./middleware.js";
import type { Issue, IssueInput } from "../workspace/types.js";
import { VortexError } from "../platform/errors.js";
import { getAgentProvider } from "../agents/index.js";
import { createD1 } from "../global/db.js";
import { createRepoBranch } from "../global/repo-branches.js";

const createIssueSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: z
    .enum(["backlog", "todo", "in_progress", "done", "canceled"])
    .optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assigneeId: z.string().optional(),
  projectId: z.string().optional(),
  cycleId: z.string().optional(),
  labelIds: z.string().optional(),
}) satisfies z.ZodType<IssueInput>;

const updateIssueSchema = createIssueSchema.partial();

const issueApiSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.enum(["backlog", "todo", "in_progress", "done", "canceled"]),
    priority: z.enum(["low", "medium", "high", "urgent"]),
    assigneeId: z.string().nullable(),
    projectId: z.string().nullable(),
    cycleId: z.string().nullable(),
    labelIds: z.string().nullable(),
    repo: z.string().nullable(),
    branch: z.string().nullable(),
    prUrl: z.string().nullable(),
    prState: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Issue") satisfies z.ZodType<Issue>;

const agentSessionSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  issueId: z.string(),
  status: z.string(),
  result: z.string().optional(),
  url: z.string().optional(),
});

type Variables = {
  workspaceToken: WorkspaceToken;
};

const listIssuesRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/issues",
  tags: ["issues"],
  request: {
    params: z.object({ workspaceId: z.string() }),
  },
  responses: {
    200: {
      description: "Issues list",
      content: {
        "application/json": {
          schema: z.object({ issues: z.array(issueApiSchema) }),
        },
      },
    },
  },
});

const createIssueRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/issues",
  tags: ["issues"],
  request: {
    params: z.object({ workspaceId: z.string() }),
    body: {
      content: {
        "application/json": { schema: createIssueSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Issue created",
      content: {
        "application/json": { schema: issueApiSchema },
      },
    },
  },
});

const getIssueRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/issues/{id}",
  tags: ["issues"],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Issue",
      content: {
        "application/json": { schema: issueApiSchema },
      },
    },
  },
});

const updateIssueRoute = createRoute({
  method: "patch",
  path: "/workspaces/{workspaceId}/issues/{id}",
  tags: ["issues"],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": { schema: updateIssueSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Issue updated",
      content: {
        "application/json": { schema: issueApiSchema },
      },
    },
  },
});

const dispatchRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/issues/{id}/dispatch",
  tags: ["agents"],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            agentId: z.string().optional(),
            model: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Session created",
      content: {
        "application/json": { schema: agentSessionSchema },
      },
    },
  },
});

export function registerIssueRoutes(
  app: OpenAPIHono<{ Bindings: AppEnv; Variables: Variables }>
) {
  app.openapi(listIssuesRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(
      c.env.WORKSPACE_DURABLE_OBJECT.idFromName(workspaceId)
    );
    const issues = await stub.listIssues();
    return c.json({ issues });
  });

  app.openapi(createIssueRoute, async (c) => {
    const input = c.req.valid("json");
    const { workspaceId } = c.req.valid("param");
    const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(
      c.env.WORKSPACE_DURABLE_OBJECT.idFromName(workspaceId)
    );
    const issue = await stub.createIssue(input);
    return c.json(issue, 201);
  });

  app.openapi(getIssueRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(
      c.env.WORKSPACE_DURABLE_OBJECT.idFromName(workspaceId)
    );
    const issue = await stub.getIssue(id);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    return c.json(issue);
  });

  app.openapi(updateIssueRoute, async (c) => {
    const input = c.req.valid("json");
    const { workspaceId, id } = c.req.valid("param");
    const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(
      c.env.WORKSPACE_DURABLE_OBJECT.idFromName(workspaceId)
    );
    const issue = await stub.updateIssue(id, input);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    return c.json(issue);
  });

  app.openapi(dispatchRoute, async (c) => {
    const { agentId, model } = c.req.valid("json");
    const { workspaceId, id } = c.req.valid("param");
    const stub = c.env.WORKSPACE_DURABLE_OBJECT.get(
      c.env.WORKSPACE_DURABLE_OBJECT.idFromName(workspaceId)
    );
    const issue = await stub.getIssue(id);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }

    const provider = getAgentProvider(agentId ?? "devin", c.env);
    const session = await provider.dispatch(workspaceId, issue, model);

    if (issue.repo && issue.branch) {
      const db = createD1(c.env.D1);
      await createRepoBranch(db, workspaceId, issue.repo, issue.branch, issue.id);
    }

    return c.json(session, 201);
  });
}
