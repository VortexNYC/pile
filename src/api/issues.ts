import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";

import { dispatchAgent } from "../agents/index.js";
import { createD1 } from "../global/db.js";
import { deleteIssueReferences } from "../global/issue-data.js";
import { createRepoBranch } from "../global/repo-branches.js";
import { getSavedView } from "../global/saved-views.js";
import { repoBranches } from "../global/schema.js";
import {
  canAccessTeam,
  getDefaultTeam,
  getTeamById,
  getVisibleTeamIds,
} from "../global/teams.js";
import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import type { Issue, IssueInput } from "../types/workspace.js";
import { filterConditionSchema } from "../workspace/filter.js";
import { agentSessionSchema } from "./agent-sessions.js";
import {
  encodeCursor,
  listIssuesQuerySchema,
  toListArgs,
} from "./list-args.js";

async function getStub(env: WorkerEnv, workspaceId: string) {
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(workspaceId)
  );
  await stub.setWorkspaceId(workspaceId);
  return stub;
}

async function loadVisibleTeamIds(
  db: ReturnType<typeof createD1>,
  workspaceId: string,
  identity: WorkspaceIdentity
): Promise<string[]> {
  return getVisibleTeamIds(db, workspaceId, identity);
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

async function assertTeamAccess(
  db: ReturnType<typeof createD1>,
  workspaceId: string,
  teamId: string | undefined,
  identity: WorkspaceIdentity
): Promise<string> {
  const resolvedTeamId = teamId
    ? (await getTeamById(db, teamId, workspaceId))?.id
    : (await getDefaultTeam(db, workspaceId))?.id;
  if (!resolvedTeamId) {
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Team not found",
    });
  }
  const allowed = await canAccessTeam(db, resolvedTeamId, identity);
  if (!allowed) {
    throw new VortexError({
      code: "FORBIDDEN",
      status: 403,
      message: "Cannot create issue in this team",
    });
  }
  return resolvedTeamId;
}

const createIssueSchema = z.object({
  title: z.string().min(1),
  teamId: z.string().optional(),
  description: z.string().optional(),
  status: z
    .enum(["backlog", "todo", "in_progress", "done", "canceled"])
    .optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assigneeId: z.string().optional(),
  projectId: z.string().optional(),
  cycleId: z.string().optional(),
  labelIds: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
}) satisfies z.ZodType<IssueInput>;

const updateIssueSchema = createIssueSchema.partial();

const issueApiSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    teamId: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.enum(["backlog", "todo", "in_progress", "done", "canceled"]),
    priority: z.enum(["low", "medium", "high", "urgent"]),
    assigneeId: z.string().nullable(),
    projectId: z.string().nullable(),
    cycleId: z.string().nullable(),
    labelIds: z.string().nullable(),
    number: z.number().nullable(),
    identifier: z.string().nullable(),
    repo: z.string().nullable(),
    branch: z.string().nullable(),
    prUrl: z.string().nullable(),
    prState: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Issue") satisfies z.ZodType<Issue>;

const listIssuesRoute = createRoute({
  method: "get",
  path: "/workspaces/{workspaceId}/issues",
  tags: ["issues"],
  middleware: [rls("read")],
  request: {
    params: z.object({ workspaceId: z.string() }),
    query: listIssuesQuerySchema,
  },
  responses: {
    200: {
      description: "Issues list",
      content: {
        "application/json": {
          schema: z.object({
            issues: z.array(issueApiSchema),
            nextCursor: z.string().optional(),
          }),
        },
      },
    },
  },
});

const createIssueRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/issues",
  tags: ["issues"],
  middleware: [rls("write")],
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
  middleware: [rls("read")],
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
  middleware: [rls("write")],
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

const deleteIssueRoute = createRoute({
  method: "delete",
  path: "/workspaces/{workspaceId}/issues/{id}",
  tags: ["issues"],
  middleware: [rls("write")],
  request: {
    params: z.object({ workspaceId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Issue deleted" },
  },
});

const dispatchRoute = createRoute({
  method: "post",
  path: "/workspaces/{workspaceId}/issues/{id}/dispatch",
  tags: ["agents"],
  middleware: [rls("write")],
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

export function registerIssueRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(listIssuesRoute, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const query = c.req.valid("query");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, workspaceId);
    const visibleTeamIds = await loadVisibleTeamIds(db, workspaceId, identity);
    if (query.identifier) {
      const issue = await stub.getIssueByIdentifier(query.identifier);
      if (issue) {
        await assertIssueAccess(db, issue, identity);
      }
      return c.json({ issues: issue ? [issue] : [] });
    }
    const args = toListArgs(query);
    if (query.teamId && !visibleTeamIds.includes(query.teamId)) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Team not found",
      });
    }
    if (query.view) {
      const view = await getSavedView(db, query.view, workspaceId);
      if (!view) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Saved view not found",
        });
      }
      let parsedFilter: unknown;
      try {
        parsedFilter = JSON.parse(view.filter);
      } catch {
        throw new VortexError({
          code: "INTERNAL_ERROR",
          status: 500,
          message: "Saved view has invalid filter JSON",
        });
      }
      const filter = filterConditionSchema.parse(parsedFilter);
      args.filter = filter;
      if (view.search && !args.search) {
        args.search = view.search;
      }
    }
    args.teamIds = visibleTeamIds;
    const issues = await stub.listIssues(args);
    const nextCursor =
      issues.length === query.limit && issues.length > 0
        ? encodeCursor({
            createdAt: issues[issues.length - 1].createdAt,
            id: issues[issues.length - 1].id,
          })
        : undefined;
    return c.json({ issues, nextCursor });
  });

  app.openapi(createIssueRoute, async (c) => {
    const input = c.req.valid("json");
    const { workspaceId } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const teamId = await assertTeamAccess(
      db,
      workspaceId,
      input.teamId,
      identity
    );
    const stub = await getStub(c.env, workspaceId);
    const issue = await stub.createIssue({ ...input, teamId }, identity.id);
    if (issue.repo && issue.branch) {
      await createRepoBranch(
        db,
        workspaceId,
        issue.repo,
        issue.branch,
        issue.id
      );
    }
    return c.json(issue, 201);
  });

  app.openapi(getIssueRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, workspaceId);
    const issue = await stub.getIssue(id);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    await assertIssueAccess(db, issue, identity);
    return c.json(issue);
  });

  app.openapi(updateIssueRoute, async (c) => {
    const input = c.req.valid("json");
    const { workspaceId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, workspaceId);
    const existing = await stub.getIssue(id);
    if (!existing) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    await assertIssueAccess(db, existing, identity);
    let teamId = existing.teamId;
    if (input.teamId !== undefined) {
      teamId = await assertTeamAccess(db, workspaceId, input.teamId, identity);
    }
    const issue = await stub.updateIssue(id, { ...input, teamId }, identity.id);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    await db
      .delete(repoBranches)
      .where(
        and(
          eq(repoBranches.workspaceId, workspaceId),
          eq(repoBranches.issueId, issue.id)
        )
      );
    if (issue.repo && issue.branch) {
      await createRepoBranch(
        db,
        workspaceId,
        issue.repo,
        issue.branch,
        issue.id
      );
    }
    return c.json(issue);
  });

  app.openapi(deleteIssueRoute, async (c) => {
    const { workspaceId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, workspaceId);
    const existing = await stub.getIssue(id);
    if (!existing) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    await assertIssueAccess(db, existing, identity);
    const deleted = await stub.deleteIssue(id, identity.id);
    if (!deleted) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    await deleteIssueReferences(db, workspaceId, id);
    return c.body(null, 204);
  });

  app.openapi(dispatchRoute, async (c) => {
    const { agentId, model } = c.req.valid("json");
    const { workspaceId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, workspaceId);
    const issue = await stub.getIssue(id);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    await assertIssueAccess(db, issue, identity);

    const session = await dispatchAgent(
      c.env,
      agentId ?? "devin",
      workspaceId,
      {
        id: issue.id,
        teamId: issue.teamId,
        title: issue.title,
        description: issue.description,
      },
      identity,
      model
    );

    if (issue.repo && issue.branch) {
      await createRepoBranch(
        db,
        workspaceId,
        issue.repo,
        issue.branch,
        issue.id
      );
    }

    return c.json(session, 201);
  });
}
