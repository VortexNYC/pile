import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";

import { dispatchAgent } from "../agents/index.js";
import { createD1 } from "../global/db.js";
import { deleteIssueReferences } from "../global/issue-data.js";
import { createRepoBranch } from "../global/repo-branches.js";
import { getTemplate } from "../global/templates.js";
import { getCycle } from "../global/workspace-entities.js";
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
import {
  ISSUE_PRIORITIES,
  ISSUE_RESOLUTIONS,
  ISSUE_STATUSES,
  type Issue,
  type IssueInput,
  type IssueResolution,
  type IssueStatus,
} from "../types/workspace.js";
import { filterConditionSchema } from "../workspace/filter.js";
import { resolveAgentEnv } from "../agents/outpost.js";
import { agentSessionSchema } from "./agent-sessions.js";

function getExecutionCtx(c: {
  executionCtx?: { waitUntil: (promise: Promise<unknown>) => void };
}): { waitUntil: (promise: Promise<unknown>) => void } | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined;
  }
}
import {
  encodeCursor,
  listIssuesQuerySchema,
  toListArgs,
} from "./list-args.js";

const templateDataSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    status: z.enum(ISSUE_STATUSES).optional(),
    priority: z.enum(ISSUE_PRIORITIES).optional(),
    estimate: z.number().int().min(0).optional(),
    assigneeId: z.string().optional(),
    projectId: z.string().optional(),
    cycleId: z.string().optional(),
    labelIds: z.string().optional(),
  })
  .partial();

async function resolveTemplateDefaults(
  db: ReturnType<typeof createD1>,
  organizationId: string,
  templateId: string | null,
  teamId: string | null
): Promise<Partial<z.infer<typeof createIssueSchema>>> {
  const explicit = templateId !== null;
  let resolvedTemplateId = templateId;
  if (!resolvedTemplateId && teamId) {
    const team = await getTeamById(db, teamId, organizationId);
    resolvedTemplateId = team?.defaultTemplateId ?? null;
  }
  if (!resolvedTemplateId) return {};
  const template = await getTemplate(db, organizationId, resolvedTemplateId);
  if (!template) {
    // A stale team default no-ops; an explicitly requested template 404s.
    if (!explicit) return {};
    throw new VortexError({
      code: "NOT_FOUND",
      status: 404,
      message: "Template not found",
    });
  }
  if (!template.templateData) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(template.templateData);
  } catch {
    throw new VortexError({
      code: "INTERNAL_ERROR",
      status: 500,
      message: "Template has invalid data",
    });
  }
  const result = templateDataSchema.safeParse(parsed);
  if (!result.success) {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Template data is invalid",
    });
  }
  return result.data;
}

async function getStub(env: WorkerEnv, organizationId: string) {
  const stub = env.WORKSPACE_DURABLE_OBJECT.get(
    env.WORKSPACE_DURABLE_OBJECT.idFromName(organizationId)
  );
  await stub.setOrganizationId(organizationId);
  return stub;
}

async function wouldCreateCycle(
  stub: Awaited<ReturnType<typeof getStub>>,
  issueId: string,
  parentId: string,
  seen: Set<string>
): Promise<boolean> {
  if (parentId === issueId) return true;
  if (seen.has(parentId)) return true;
  seen.add(parentId);
  const issue = await stub.getIssue(parentId);
  const next = issue?.parentId ?? null;
  if (next === null) return false;
  return wouldCreateCycle(stub, issueId, next, seen);
}

async function loadVisibleTeamIds(
  db: ReturnType<typeof createD1>,
  organizationId: string,
  identity: WorkspaceIdentity
): Promise<string[]> {
  return getVisibleTeamIds(db, organizationId, identity);
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
  organizationId: string,
  teamId: string | undefined,
  identity: WorkspaceIdentity
): Promise<string> {
  const resolvedTeamId = teamId
    ? (await getTeamById(db, teamId, organizationId))?.id
    : (await getDefaultTeam(db, organizationId))?.id;
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

const TERMINAL_STATUSES: ReadonlyArray<IssueStatus> = ["done", "canceled"];

function validateIssueState(
  status: IssueStatus,
  resolution: IssueResolution | null | undefined
): void {
  if (resolution === undefined || resolution === null) return;
  if (!ISSUE_RESOLUTIONS.some((r) => r === resolution)) {
    throw VortexError.fromCode(
      "BAD_REQUEST",
      `Invalid issue resolution: ${resolution}`
    );
  }
  if (!TERMINAL_STATUSES.some((s) => s === status)) {
    throw VortexError.fromCode(
      "BAD_REQUEST",
      `Resolution can only be set when status is done or canceled, got ${status}`
    );
  }
}

const createIssueSchema = z.object({
  title: z.string().min(1),
  teamId: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(ISSUE_STATUSES).optional(),
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  resolution: z.enum(ISSUE_RESOLUTIONS).nullable().optional(),
  parentId: z.string().nullable().optional(),
  subIssueSortOrder: z.number().nullable().optional(),
  estimate: z.number().int().min(0).nullable().optional(),
  isDraft: z.boolean().optional(),
  templateId: z.string().optional(),
  snoozedUntil: z.string().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
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
    organizationId: z.string(),
    teamId: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.enum(ISSUE_STATUSES),
    priority: z.enum(ISSUE_PRIORITIES),
    resolution: z.enum(ISSUE_RESOLUTIONS).nullable(),
    parentId: z.string().nullable(),
    subIssueSortOrder: z.number().nullable(),
    estimate: z.number().nullable(),
    isDraft: z.boolean(),
    snoozedUntil: z.string().nullable(),
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
  path: "/workspaces/{organizationId}/issues",
  tags: ["issues"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
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

const issueAnalyticsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issue-analytics",
  tags: ["issues"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      groupBy: z
        .enum([
          "status",
          "priority",
          "assigneeId",
          "teamId",
          "projectId",
          "cycleId",
        ])
        .optional()
        .default("status"),
    }),
  },
  responses: {
    200: {
      description: "Issue counts and estimate totals grouped by a field",
      content: {
        "application/json": {
          schema: z.object({
            groups: z.array(
              z.object({
                group: z.string().nullable(),
                count: z.number(),
                estimateTotal: z.number(),
              })
            ),
          }),
        },
      },
    },
  },
});

const burndownRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issue-analytics/burndown",
  tags: ["issues"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({ cycleId: z.string() }),
  },
  responses: {
    200: {
      description: "Daily scope/remaining burndown series for a cycle",
      content: {
        "application/json": {
          schema: z.object({
            total: z.number(),
            totalEstimate: z.number(),
            series: z.array(
              z.object({
                date: z.string(),
                scope: z.number(),
                remaining: z.number(),
              })
            ),
          }),
        },
      },
    },
  },
});

const listTriageRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/triage",
  tags: ["issues"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: listIssuesQuerySchema,
  },
  responses: {
    200: {
      description: "Triage inbox: issues awaiting triage",
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
  path: "/workspaces/{organizationId}/issues",
  tags: ["issues"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
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
  path: "/workspaces/{organizationId}/issues/{id}",
  tags: ["issues"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
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
  path: "/workspaces/{organizationId}/issues/{id}",
  tags: ["issues"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
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

const batchUpdateIssuesSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  patch: updateIssueSchema,
});

const batchUpdateIssuesRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/issues/batch",
  tags: ["issues"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: batchUpdateIssuesSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Issues updated",
      content: {
        "application/json": {
          schema: z.object({ issues: z.array(issueApiSchema) }),
        },
      },
    },
  },
});

const deleteIssueRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/issues/{id}",
  tags: ["issues"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    204: { description: "Issue deleted" },
  },
});

const getIssueChildrenRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{id}/children",
  tags: ["issues"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Issue children",
      content: {
        "application/json": {
          schema: z.object({ issues: z.array(issueApiSchema) }),
        },
      },
    },
  },
});

const dispatchRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/issues/{id}/dispatch",
  tags: ["agents"],
  middleware: [rls("write", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
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
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);
    const visibleTeamIds = await loadVisibleTeamIds(
      db,
      organizationId,
      identity
    );
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
      const view = await (await getStub(c.env, organizationId)).getSavedView(query.view);
      if (
        !view ||
        (view.ownerId !== identity.id &&
          !view.shared &&
          !identity.permissions.includes("admin"))
      ) {
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

  app.openapi(issueAnalyticsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { groupBy } = c.req.valid("query");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);
    const visibleTeamIds = await loadVisibleTeamIds(
      db,
      organizationId,
      identity
    );
    const groups = await stub.issueStats(groupBy, visibleTeamIds);
    return c.json({ groups });
  });

  app.openapi(burndownRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { cycleId } = c.req.valid("query");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const cycle = await getCycle(db, organizationId, cycleId);
    if (!cycle) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Cycle not found",
      });
    }
    const teamIds = await loadVisibleTeamIds(db, organizationId, identity);
    const stub = await getStub(c.env, organizationId);
    const result = await stub.burndown(cycleId, teamIds, {
      startDate: cycle.startDate,
      endDate: cycle.endDate,
    });
    return c.json(result);
  });

  app.openapi(listTriageRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);
    const visibleTeamIds = await loadVisibleTeamIds(
      db,
      organizationId,
      identity
    );
    const args = toListArgs(query);
    args.status = "triage";
    args.isDraft = false;
    args.hideSnoozed = query.includeSnoozed === undefined
      ? true
      : args.hideSnoozed;
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
    const { organizationId } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);
    let teamId = input.teamId;
    if (input.parentId) {
      const parent = await stub.getIssue(input.parentId);
      if (!parent) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "Parent issue not found",
        });
      }
      await assertIssueAccess(db, parent, identity);
      teamId ??= parent.teamId;
    }
    const resolvedTeamId = await assertTeamAccess(
      db,
      organizationId,
      teamId,
      identity
    );
    const templateDefaults = await resolveTemplateDefaults(
      db,
      organizationId,
      input.templateId ?? null,
      resolvedTeamId
    );
    validateIssueState(
      input.status ?? templateDefaults.status ?? "backlog",
      input.resolution
    );
    const { templateId: _templateId, ...rest } = input;
    const issue = await stub.createIssue(
      {
        ...rest,
        description: input.description ?? templateDefaults.description,
        status: input.status ?? templateDefaults.status,
        priority: input.priority ?? templateDefaults.priority,
        estimate:
          input.estimate === undefined
            ? templateDefaults.estimate
            : input.estimate,
        assigneeId:
          input.assigneeId === undefined
            ? templateDefaults.assigneeId
            : input.assigneeId,
        projectId: input.projectId ?? templateDefaults.projectId,
        cycleId: input.cycleId ?? templateDefaults.cycleId,
        labelIds: input.labelIds ?? templateDefaults.labelIds,
        teamId: resolvedTeamId,
      },
      identity.id
    );
    if (issue.repo && issue.branch) {
      await createRepoBranch(
        db,
        organizationId,
        issue.repo,
        issue.branch,
        issue.id
      );
    }
    return c.json(issue, 201);
  });

  app.openapi(getIssueRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);
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

  app.openapi(getIssueChildrenRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);
    const issue = await stub.getIssue(id);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    await assertIssueAccess(db, issue, identity);
    const children = await stub.getIssueChildren(id);
    const visibleTeamIds = await loadVisibleTeamIds(
      db,
      organizationId,
      identity
    );
    const visibleChildren = children.filter((child) =>
      visibleTeamIds.includes(child.teamId)
    );
    return c.json({ issues: visibleChildren });
  });

  app.openapi(updateIssueRoute, async (c) => {
    const input = c.req.valid("json");
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);
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
      teamId = await assertTeamAccess(
        db,
        organizationId,
        input.teamId,
        identity
      );
    }
    if (input.parentId !== undefined && input.parentId !== null) {
      const parent = await stub.getIssue(input.parentId);
      if (!parent) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "Parent issue not found",
        });
      }
      await assertIssueAccess(db, parent, identity);
      if (await wouldCreateCycle(stub, id, input.parentId, new Set<string>())) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "Parent would create a cycle",
        });
      }
    }
    validateIssueState(input.status ?? existing.status, input.resolution);
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
          eq(repoBranches.organizationId, organizationId),
          eq(repoBranches.issueId, issue.id)
        )
      );
    if (issue.repo && issue.branch) {
      await createRepoBranch(
        db,
        organizationId,
        issue.repo,
        issue.branch,
        issue.id
      );
    }
    return c.json(issue);
  });

  app.openapi(batchUpdateIssuesRoute, async (c) => {
    const { ids, patch } = c.req.valid("json");
    const { organizationId } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);

    if (patch.teamId !== undefined) {
      await assertTeamAccess(db, organizationId, patch.teamId, identity);
    }

    if (patch.parentId !== undefined && patch.parentId !== null) {
      const parent = await stub.getIssue(patch.parentId);
      if (!parent) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "Parent issue not found",
        });
      }
      await assertIssueAccess(db, parent, identity);
    }

    const existingIssues = await Promise.all(
      ids.map((id) => stub.getIssue(id))
    );
    const missing = existingIssues.findIndex((issue) => !issue);
    if (missing !== -1) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: `Issue not found: ${ids[missing]}`,
      });
    }
    const validIssues: Issue[] = [];
    for (const issue of existingIssues) {
      if (issue) {
        validIssues.push(issue);
      }
    }

    await Promise.all(
      validIssues.map((issue) => assertIssueAccess(db, issue, identity))
    );
    for (const issue of validIssues) {
      validateIssueState(patch.status ?? issue.status, patch.resolution);
    }

    if (patch.parentId !== undefined && patch.parentId !== null) {
      const parentId: string = patch.parentId;
      await Promise.all(
        ids.map((id) => wouldCreateCycle(stub, id, parentId, new Set<string>()))
      );
    }

    const issues = await stub.batchUpdateIssues(ids, patch, identity.id);
    return c.json({ issues });
  });

  app.openapi(deleteIssueRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);
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
    await deleteIssueReferences(db, organizationId, id);
    return c.body(null, 204);
  });

  app.openapi(dispatchRoute, async (c) => {
    const { agentId, model } = c.req.valid("json");
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);
    const issue = await stub.getIssue(id);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    await assertIssueAccess(db, issue, identity);

    const resolvedAgentId = agentId ?? "devin";
    const providerConfig = await stub.getAgentProviderConfig(resolvedAgentId);
    const effectiveEnv = resolveAgentEnv(c.env, providerConfig ?? undefined);

    const session = await dispatchAgent(
      effectiveEnv,
      resolvedAgentId,
      organizationId,
      {
        id: issue.id,
        teamId: issue.teamId,
        title: issue.title,
        description: issue.description,
      },
      identity,
      model,
      getExecutionCtx(c)
    );

    if (issue.repo && issue.branch) {
      await createRepoBranch(
        db,
        organizationId,
        issue.repo,
        issue.branch,
        issue.id
      );
    }

    return c.json(session, 201);
  });
}
