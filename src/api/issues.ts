import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";

import { resolveAgentEnv } from "../agents/daytona.js";
import { dispatchAgent, getAgentProvider } from "../agents/index.js";
import { createD1 } from "../global/db.js";
import { deleteIssueReferences } from "../global/issue-data.js";
import {
  createRepoBranch,
  suggestBranchName,
} from "../global/repo-branches.js";
import { repoBranches } from "../global/schema.js";
import {
  canAccessTeam,
  getDefaultTeam,
  getTeamById,
  getVisibleTeamIds,
  listTeams,
} from "../global/teams.js";
import { getTemplate } from "../global/templates.js";
import {
  getCycle,
  getLabel,
  getProject,
} from "../global/workspace-entities.js";
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
import { agentSessionSchema } from "./agent-sessions.js";
import {
  cleanPageText,
  fetchReadablePage,
  summarizeText,
} from "./page-summary.js";

function getExecutionCtx(c: {
  executionCtx?: { waitUntil: (promise: Promise<unknown>) => void };
}): { waitUntil: (promise: Promise<unknown>) => void } | undefined {
  try {
    const ctx = c.executionCtx;
    if (!ctx) return undefined;
    return {
      waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise),
    };
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
  externalRef: z.string().min(1).max(255).nullable().optional(),
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
  labelIds: z
    .array(z.string())
    .optional()
    .transform((ids) => (ids && ids.length > 0 ? ids.join(",") : null)),
  repo: z.string().optional(),
  branch: z.string().optional(),
}) satisfies z.ZodType<IssueInput>;

const updateIssueSchema = createIssueSchema.partial();

const CAPTURE_SCREENSHOT_MAX_BYTES = 8 * 1024 * 1024;

const captureScreenshotSchema = z.object({
  contentBase64: z.string().min(1),
  contentType: z
    .string()
    .regex(/^image\/(png|jpeg|webp)$/)
    .default("image/png"),
});

const captureIssueSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1).optional(),
  selection: z.string().optional(),
  source: z.string().optional(),
  teamId: z.string().optional(),
  teamKey: z.string().optional(),
  projectId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  pageText: z.string().optional(),
  includeFullText: z.boolean().optional(),
  summarize: z.boolean().optional(),
  screenshot: captureScreenshotSchema.optional(),
});

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/^data:[^;]+;base64,/, "");
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    throw new VortexError({
      code: "BAD_REQUEST",
      status: 400,
      message: "Screenshot is not valid base64",
    });
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function screenshotExtension(contentType: string): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/webp") return "webp";
  return "png";
}

const issueApiSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    externalRef: z.string().nullable(),
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
    prCheckState: z.string().nullable(),
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

const listTriageIssuesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/triage",
  tags: ["issues"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Triage issues",
      content: {
        "application/json": {
          schema: z.object({
            issues: z.array(issueApiSchema),
          }),
        },
      },
    },
  },
});

const getIssueBranchNameRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{id}/branch-name",
  tags: ["issues"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Suggested branch name",
      content: {
        "application/json": {
          schema: z.object({ branchName: z.string() }),
        },
      },
    },
    404: { description: "Issue not found" },
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
    200: {
      description:
        "Existing issue with the same externalRef (idempotent create)",
      content: {
        "application/json": { schema: issueApiSchema },
      },
    },
  },
});

const captureIssueRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/capture",
  tags: ["capture"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": { schema: captureIssueSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Captured issue created",
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

const assignIssueSchema = z.object({
  assigneeId: z.string().nullable(),
});

const assignIssueResponseSchema = z.object({
  issue: issueApiSchema,
  session: agentSessionSchema.optional(),
});

const assignIssueRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/issues/{id}/assign",
  tags: ["issues"],
  middleware: [rls("write")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: {
        "application/json": { schema: assignIssueSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Issue assigned",
      content: {
        "application/json": { schema: assignIssueResponseSchema },
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
      const view = await (
        await getStub(c.env, organizationId)
      ).getSavedView(query.view);
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

  app.openapi(listTriageIssuesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);
    const visibleTeamIds = await loadVisibleTeamIds(
      db,
      organizationId,
      identity
    );
    const issues = await stub.listIssues({
      status: "triage",
      teamIds: visibleTeamIds,
    });
    return c.json({ issues });
  });

  app.openapi(getIssueBranchNameRoute, async (c) => {
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
    const branchName = suggestBranchName(
      issue.identifier ?? issue.id,
      issue.title
    );
    return c.json({ branchName });
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
    args.hideSnoozed =
      query.includeSnoozed === undefined ? true : args.hideSnoozed;
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
      if (parent.parentId) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "Sub-issues can only be nested one level",
          hint: `Parent ${parent.identifier} is already a sub-issue`,
        });
      }
      teamId ??= parent.teamId;
    }
    if (input.externalRef) {
      const existing = await stub.getIssueByExternalRef(input.externalRef);
      if (existing) {
        await assertIssueAccess(db, existing, identity);
        return c.json(existing, 200);
      }
    }
    const resolvedTeamId = await assertTeamAccess(
      db,
      organizationId,
      teamId,
      identity
    );
    const teamRecord = await getTeamById(db, resolvedTeamId, organizationId);
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
        repo: input.repo ?? teamRecord?.defaultRepo ?? undefined,
        branch: input.branch,
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

  app.openapi(captureIssueRoute, async (c) => {
    const input = c.req.valid("json");
    const { organizationId } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    const stub = await getStub(c.env, organizationId);

    let teamId = input.teamId;
    if (!teamId && input.teamKey) {
      const wanted = input.teamKey.toUpperCase();
      const match = (await listTeams(db, organizationId)).find(
        (team) => team.key.toUpperCase() === wanted
      );
      if (!match) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Team not found",
        });
      }
      teamId = match.id;
    }
    const resolvedTeamId = await assertTeamAccess(
      db,
      organizationId,
      teamId,
      identity
    );
    const teamRecord = await getTeamById(db, resolvedTeamId, organizationId);

    if (input.projectId) {
      const project = await getProject(db, organizationId, input.projectId);
      if (!project) {
        throw new VortexError({
          code: "NOT_FOUND",
          status: 404,
          message: "Project not found",
        });
      }
    }
    const labelIds = [...new Set(input.labelIds ?? [])];
    const labels = await Promise.all(
      labelIds.map((labelId) => getLabel(db, organizationId, labelId))
    );
    const missingLabel = labelIds.find((_, index) => !labels[index]);
    if (missingLabel) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: `Label not found: ${missingLabel}`,
      });
    }

    let screenshotBytes: Uint8Array | null = null;
    const bucket = c.env.ATTACHMENTS_BUCKET;
    if (input.screenshot) {
      screenshotBytes = base64ToBytes(input.screenshot.contentBase64);
      if (screenshotBytes.byteLength > CAPTURE_SCREENSHOT_MAX_BYTES) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "Screenshot exceeds 8MB",
        });
      }
    }

    const wantsSummary = input.summarize === true;
    const wantsFullText = input.includeFullText === true;
    let pageText =
      input.pageText && input.pageText.trim().length > 0
        ? cleanPageText(input.pageText)
        : null;
    let fetchedTitle: string | null = null;
    if ((wantsSummary || wantsFullText) && pageText === null) {
      const fetched = await fetchReadablePage(input.url);
      if (fetched && fetched.text.length > 0) {
        pageText = fetched.text;
        fetchedTitle = fetched.title;
      }
    }
    const summary = wantsSummary && pageText ? summarizeText(pageText) : null;

    const title =
      input.title && input.title.length > 0
        ? input.title
        : (fetchedTitle ?? input.url);
    const descriptionParts = [
      `Source: ${input.source ?? "web clipper"}`,
      `[${title}](${input.url})`,
    ];
    if (input.selection && input.selection.length > 0) {
      descriptionParts.push(`> ${input.selection}`);
    }
    if (summary && summary.length > 0) {
      descriptionParts.push(`**Summary**\n\n${summary}`);
    }

    let screenshotKey: string | null = null;
    let screenshotUrl: string | null = null;
    if (input.screenshot && screenshotBytes) {
      if (!bucket) {
        throw new VortexError({
          code: "INTERNAL_ERROR",
          status: 503,
          message: "File storage not configured",
        });
      }
      const contentType = input.screenshot.contentType;
      const fileId = crypto.randomUUID();
      screenshotKey = `${organizationId}/files/${fileId}/screenshot.${screenshotExtension(contentType)}`;
      await bucket.put(screenshotKey, screenshotBytes, {
        httpMetadata: { contentType },
      });
      screenshotUrl = `/workspaces/${organizationId}/files?key=${encodeURIComponent(screenshotKey)}`;
      descriptionParts.push(`![Screenshot](${screenshotUrl})`);
    }

    if (wantsFullText && pageText && pageText.length > 0) {
      descriptionParts.push(
        `<details>\n<summary>Full page text</summary>\n\n${pageText}\n\n</details>`
      );
    }

    const issue = await stub.createIssue(
      {
        title,
        description: descriptionParts.join("\n\n"),
        status: "triage",
        teamId: resolvedTeamId,
        projectId: input.projectId,
        labelIds: labelIds.length > 0 ? labelIds.join(",") : undefined,
        repo: teamRecord?.defaultRepo ?? undefined,
      },
      identity.id
    );

    if (screenshotKey && screenshotUrl) {
      await stub.createAttachment({
        issueId: issue.id,
        linearId: "",
        url: screenshotUrl,
        title: "Screenshot",
        subtitle: input.screenshot?.contentType ?? null,
        r2Key: screenshotKey,
      });
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
      if (parent.parentId) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "Sub-issues can only be nested one level",
          hint: `Parent ${parent.identifier} is already a sub-issue`,
        });
      }
      const children = await stub.getIssueChildren(id);
      if (children.length > 0) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "An issue with sub-issues cannot become a sub-issue",
          hint: `Children: ${children.map((child) => child.identifier).join(", ")}`,
        });
      }
      if (await wouldCreateCycle(stub, id, input.parentId, new Set<string>())) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "Parent would create a cycle",
        });
      }
    }
    if (typeof input.externalRef === "string") {
      const existingByRef = await stub.getIssueByExternalRef(input.externalRef);
      if (existingByRef && existingByRef.id !== id) {
        throw new VortexError({
          code: "CONFLICT",
          status: 409,
          message: "externalRef already used",
          hint: `Issue ${existingByRef.identifier} already has externalRef ${input.externalRef}`,
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

    if (!issue.repo) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Issue must have a repository to dispatch an agent",
      });
    }

    const resolvedAgentId = agentId ?? "devin";
    const providerConfig = await stub.getAgentProviderConfig(resolvedAgentId);
    const effectiveEnv = resolveAgentEnv(c.env, providerConfig ?? undefined);

    const session = await dispatchAgent(
      effectiveEnv,
      resolvedAgentId,
      organizationId,
      issue,
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

  app.openapi(assignIssueRoute, async (c) => {
    const { assigneeId } = c.req.valid("json");
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

    const issue = await stub.updateIssue(id, { assigneeId }, identity.id);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }

    let session: Awaited<ReturnType<typeof dispatchAgent>> | undefined;
    if (assigneeId) {
      let isAgent = false;
      try {
        getAgentProvider(assigneeId, c.env);
        isAgent = true;
      } catch {
        isAgent = false;
      }
      if (isAgent) {
        if (!issue.repo) {
          throw new VortexError({
            code: "BAD_REQUEST",
            status: 400,
            message: "Issue must have a repository to dispatch an agent",
          });
        }
        if (!identity.permissions.includes("agent:write")) {
          throw new VortexError({
            code: "FORBIDDEN",
            status: 403,
            message: "Missing permission: agent:write",
          });
        }
        const providerConfig = await stub.getAgentProviderConfig(assigneeId);
        const effectiveEnv = resolveAgentEnv(
          c.env,
          providerConfig ?? undefined
        );
        session = await dispatchAgent(
          effectiveEnv,
          assigneeId,
          organizationId,
          issue,
          identity,
          undefined,
          getExecutionCtx(c)
        );
      }
    }

    return c.json({ issue, session }, 200);
  });
}
