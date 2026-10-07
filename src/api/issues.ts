import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";

import {
  dispatchEffortSchema,
  maxDurationSchema,
  resolveDispatchEffort,
} from "../agents/budget.js";
import { loadProviderConfig } from "../agents/credentials.js";
import { resolveAgentEnv } from "../agents/daytona.js";
import {
  dispatchAgent,
  getAgentProvider,
  inheritTeamDefaultRepo,
} from "../agents/index.js";
import { resolveResultSchema } from "../agents/lane-result.js";
import {
  notePlanSource,
  planLaneOptions,
  resolveDispatchAgent,
  triggerPlanLabel,
} from "../agents/plan-dispatch.js";
import {
  buildPreflightCritiqueInstructions,
  evaluateDispatchReadiness,
} from "../agents/preflight.js";
import { secondaryReposSchema } from "../agents/secondary-repos.js";
import { consumeUsage } from "../global/billing.js";
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
  ISSUE_PR_STATES,
  ISSUE_RESOLUTIONS,
  ISSUE_STATUSES,
  type Issue,
  type IssueInput,
  type IssueResolution,
  type IssueStatus,
} from "../types/workspace.js";
import { filterConditionSchema } from "../workspace/filter.js";
import {
  agentSessionSchema,
  resultSchemaInputSchema,
  toSessionResponse,
} from "./agent-sessions.js";
import { getExecutionCtx } from "./execution-ctx.js";
import { assertIssueAccess, issueViewer } from "./issue-access.js";
import {
  encodeCursor,
  listIssuesQuerySchema,
  toListArgs,
} from "./list-args.js";
import {
  cleanPageText,
  fetchReadablePage,
  summarizeText,
} from "./page-summary.js";

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
  teamKey: z.string().optional(),
  description: z.string().nullable().optional(),
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
  projectId: z.string().nullable().optional(),
  cycleId: z.string().nullable().optional(),
  labelIds: z
    .array(z.string())
    .nullable()
    .optional()
    .transform((ids) => (ids && ids.length > 0 ? ids.join(",") : null)),
  repo: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
}) satisfies z.ZodType<IssueInput>;

// prUrl/prState are PATCH-only: create seeds them to null and the GitHub
// webhook / lane-completion paths are the usual writers. PATCH exists so a
// human or agent can link (or unlink) a PR without a session. prUrl stays a
// plain URL (not github.com-specific — GitLab MR URLs are valid) and prState
// is the canonical four-value domain the webhook writers normalize into.
const updateIssueSchema = createIssueSchema.partial().extend({
  prUrl: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//.test(u), {
      message: "prUrl must be an http(s) URL",
    })
    .nullable()
    .optional(),
  prState: z.enum(ISSUE_PR_STATES).nullable().optional(),
});

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

const possibleDuplicateSchema = z
  .object({
    id: z.string(),
    identifier: z.string().nullable(),
    title: z.string(),
    status: z.enum(ISSUE_STATUSES),
    score: z.number().openapi({
      description:
        "Share of significant title terms in common with the new title (0-1)",
    }),
  })
  .openapi("PossibleDuplicate");

const createdIssueApiSchema = issueApiSchema
  .extend({ possibleDuplicates: z.array(possibleDuplicateSchema) })
  .openapi("CreatedIssue");

const createIssueRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/issues",
  tags: ["issues"],
  middleware: [rls("write")],
  description:
    "The 201 response includes possibleDuplicates: open issues (in teams you can see) whose titles closely match, best first. Non-blocking — if one is the same work, comment on or update it instead of keeping the new issue. Pass dedupe=block to get 409 with the matches in details.possibleDuplicates instead of creating.",
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      dedupe: z.enum(["warn", "block"]).optional().openapi({
        description:
          "warn (default): create and return possibleDuplicates; block: 409 when any possible duplicate exists",
      }),
    }),
    body: {
      content: {
        "application/json": { schema: createIssueSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Issue created, with possible duplicates to review",
      content: {
        "application/json": { schema: createdIssueApiSchema },
      },
    },
    409: {
      description:
        "dedupe=block and possible duplicates exist (details.possibleDuplicates)",
      content: {
        "application/json": {
          schema: z
            .object({
              code: z.literal("CONFLICT"),
              message: z.string(),
              hint: z.string(),
              details: z.object({
                possibleDuplicates: z.array(possibleDuplicateSchema),
              }),
            })
            .openapi("DuplicateConflictError"),
        },
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

const similarIssuesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{id}/similar",
  tags: ["issues"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }),
  },
  responses: {
    200: {
      description:
        "Issues whose title/description best match this issue (BM25 over the workspace search index), best first",
      content: {
        "application/json": {
          schema: z.object({
            similar: z.array(
              z.object({ issue: issueApiSchema, score: z.number() })
            ),
          }),
        },
      },
    },
  },
});

const dispatchPreflightSchema = z.object({
  ready: z.boolean(),
  missing: z.array(z.string()),
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
          schema: z
            .object({
              agentId: z.string().optional(),
              // Alias for agentId — silently dropped provider params caused
              // dispatches to fall back to the default agent.
              provider: z.string().optional(),
              model: z.string().optional(),
              // Dispatch-time overrides: repo/branch win over the issue's
              // stored fields for this run only; explicit null clears the
              // stored value; instructions are appended to the prompt's
              // context section. When neither body nor issue carries a repo,
              // the team's defaultRepo fills in (PILE-321).
              repo: z.string().nullable().optional(),
              // The lane's WORKING branch (created off the repo default and
              // pushed by the runner) — not the base. PILE-241.
              branch: z.string().nullable().optional(),
              instructions: z.string().optional(),
              // VTX-209 — when true, dispatch a repo-less planner-critique
              // session on the target provider instead of the task lane. It
              // reports missing/ambiguous context back onto the issue thread.
              preflight: z.boolean().optional(),
              // PILE-294 — sibling repos cloned under ~/xrepo/<owner>/<name>
              // next to the primary checkout. `write` entries get the lane
              // branch pushed and a PR opened in that repo.
              secondaryRepos: secondaryReposSchema.optional(),
              // PILE-283 — plan mode. "plan" dispatches a lane that posts an
              // implementation plan on the issue instead of code (re-running
              // it revises the latest plan, with `instructions` as feedback);
              // "implement_plan" dispatches a build lane FROM the latest plan.
              mode: z.enum(["build", "plan", "implement_plan"]).optional(),
              // PILE-293 — run budget. effort is a model tier (low→max);
              // unset, it follows the issue's priority (preflight: low).
              // maxDuration (minutes) replaces the provider timeout for this
              // lane; past it the lane is canceled and escalated.
              effort: dispatchEffortSchema.optional(),
              maxDuration: maxDurationSchema.optional(),
              // PILE-289 — validate the lane's final output; automations
              // read session.structuredResult instead of scraping prose.
              resultSchema: resultSchemaInputSchema.optional(),
            })
            .strict(),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Session created",
      content: {
        "application/json": {
          schema: agentSessionSchema.extend({
            preflight: dispatchPreflightSchema,
          }),
        },
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

// Per-issue access grants (PILE-328): no rows = open to the workspace; any
// row restricts the issue to the listed actors + workspace admins.
const issuePermissionSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  issueId: z.string(),
  actorId: z.string(),
  actorType: z.string(),
  createdAt: z.string(),
});

const issuePermissionBodySchema = z.object({
  // User id, API-key id, or Better Auth team id (actorType="team").
  actorId: z.string().min(1),
  actorType: z.enum(["user", "agent", "team"]).optional(),
});

const listIssuePermissionsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{id}/permissions",
  tags: ["issues"],
  middleware: [rls("read")],
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
  },
  responses: {
    200: {
      description: "Access grants for this issue",
      content: {
        "application/json": {
          schema: z.object({
            permissions: z.array(issuePermissionSchema),
          }),
        },
      },
    },
    404: { description: "Issue not found" },
  },
});

const setIssuePermissionRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/issues/{id}/permissions",
  tags: ["issues"],
  middleware: [rls("write")],
  description:
    "Grant an actor access to this issue. The first grant restricts the issue to listed actors + workspace admins; revoking the last grant reopens it.",
  request: {
    params: z.object({ organizationId: z.string(), id: z.string() }),
    body: {
      content: { "application/json": { schema: issuePermissionBodySchema } },
    },
  },
  responses: {
    200: {
      description: "Permission set",
      content: {
        "application/json": { schema: issuePermissionSchema },
      },
    },
    404: { description: "Issue not found" },
  },
});

const revokeIssuePermissionRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/issues/{id}/permissions/{actorId}",
  tags: ["issues"],
  middleware: [rls("write")],
  description:
    "Revoke an actor's access grant. When the last grant is removed the issue is open to the workspace again.",
  request: {
    params: z.object({
      organizationId: z.string(),
      id: z.string(),
      actorId: z.string(),
    }),
  },
  responses: {
    204: { description: "Permission revoked" },
    404: { description: "Issue not found" },
  },
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
        await assertIssueAccess(db, stub, issue, identity);
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
    if (typeof args.parentId === "string") {
      // parentId accepts the UUID or the KEY-N identifier.
      args.parentId = (await stub.getIssue(args.parentId))?.id ?? args.parentId;
    }
    args.teamIds = visibleTeamIds;
    args.viewer = await issueViewer(db, identity);
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
      viewer: await issueViewer(db, identity),
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
    await assertIssueAccess(db, stub, issue, identity);
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
    const groups = await stub.issueStats(
      groupBy,
      visibleTeamIds,
      await issueViewer(db, identity)
    );
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
    const result = await stub.burndown(
      cycleId,
      teamIds,
      {
        startDate: cycle.startDate,
        endDate: cycle.endDate,
      },
      await issueViewer(db, identity)
    );
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
    if (typeof args.parentId === "string") {
      args.parentId = (await stub.getIssue(args.parentId))?.id ?? args.parentId;
    }
    args.teamIds = visibleTeamIds;
    args.viewer = await issueViewer(db, identity);
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
    const { dedupe } = c.req.valid("query");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    await consumeUsage(
      db,
      organizationId,
      "issues",
      "create",
      Number(c.env.FREE_USE_CAP ?? 0),
      1,
      c.env,
      getExecutionCtx(c)
    );
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
      await assertIssueAccess(db, stub, parent, identity);
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
    if (input.externalRef) {
      const existing = await stub.getIssueByExternalRef(input.externalRef);
      if (existing) {
        await assertIssueAccess(db, stub, existing, identity);
        return c.json(existing, 200);
      }
    }
    const resolvedTeamId = await assertTeamAccess(
      db,
      organizationId,
      teamId,
      identity
    );
    const visibleTeamIds = await loadVisibleTeamIds(
      db,
      organizationId,
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
    const { templateId: _templateId, teamKey: _teamKey, ...rest } = input;
    const created = await stub.createIssueWithDuplicates(
      {
        ...rest,
        description:
          input.description === undefined
            ? templateDefaults.description
            : input.description,
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
        projectId:
          input.projectId === undefined
            ? templateDefaults.projectId
            : input.projectId,
        cycleId:
          input.cycleId === undefined
            ? templateDefaults.cycleId
            : input.cycleId,
        labelIds:
          input.labelIds === undefined
            ? templateDefaults.labelIds
            : input.labelIds,
        teamId: resolvedTeamId,
        // Explicit null wins over the team default — the caller is clearing
        // the field, not leaving it unset.
        repo:
          input.repo === undefined
            ? (teamRecord?.defaultRepo ?? undefined)
            : input.repo,
        branch: input.branch,
      },
      identity.id,
      {
        teamIds: visibleTeamIds,
        block: dedupe === "block",
        viewer: await issueViewer(db, identity),
      }
    );
    const possibleDuplicates = created.possibleDuplicates.map(
      ({ issue: match, score }) => ({
        id: match.id,
        identifier: match.identifier,
        title: match.title,
        status: match.status,
        score: Math.round(score * 1000) / 1000,
      })
    );
    const { issue } = created;
    if (!issue) {
      const [top] = possibleDuplicates;
      throw new VortexError({
        code: "CONFLICT",
        status: 409,
        message: "Possible duplicate issues exist",
        hint: `Comment on or update ${top?.identifier ?? top?.id} instead, or retry without dedupe=block`,
        details: { possibleDuplicates },
      });
    }
    if (issue.repo && issue.branch) {
      await createRepoBranch(
        db,
        organizationId,
        issue.repo,
        issue.branch,
        issue.id
      );
    }
    await triggerPlanLabel(
      c.env,
      db,
      stub,
      organizationId,
      null,
      issue,
      identity,
      getExecutionCtx(c)
    );
    return c.json({ ...issue, possibleDuplicates }, 201);
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
    await assertIssueAccess(db, stub, issue, identity);
    return c.json(issue);
  });

  app.openapi(listIssuePermissionsRoute, async (c) => {
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
    await assertIssueAccess(db, stub, issue, identity);
    return c.json({ permissions: await stub.listIssuePermissions(issue.id) });
  });

  app.openapi(setIssuePermissionRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const input = c.req.valid("json");
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
    await assertIssueAccess(db, stub, issue, identity);
    // Grant management is admin-only: a granted member could otherwise
    // declassify the issue by revoking every grant, and any member could
    // restrict an open issue to themselves.
    if (!identity.permissions.includes("admin")) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Only workspace admins can manage issue permissions",
      });
    }
    const grant = await stub.setIssuePermission(
      issue.id,
      input.actorId,
      input.actorType ?? "user",
      identity.id
    );
    return c.json(grant);
  });

  app.openapi(revokeIssuePermissionRoute, async (c) => {
    const { organizationId, id, actorId } = c.req.valid("param");
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
    await assertIssueAccess(db, stub, issue, identity);
    if (!identity.permissions.includes("admin")) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Only workspace admins can manage issue permissions",
      });
    }
    await stub.revokeIssuePermission(issue.id, actorId, identity.id);
    return c.body(null, 204);
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
    await assertIssueAccess(db, stub, issue, identity);
    const visibleTeamIds = await loadVisibleTeamIds(
      db,
      organizationId,
      identity
    );
    const children = await stub.getIssueChildren(
      issue.id,
      await issueViewer(db, identity)
    );
    const visibleChildren = children.filter((child) =>
      visibleTeamIds.includes(child.teamId)
    );
    return c.json({ issues: visibleChildren });
  });

  app.openapi(similarIssuesRoute, async (c) => {
    const { organizationId, id } = c.req.valid("param");
    const { limit } = c.req.valid("query");
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
    await assertIssueAccess(db, stub, issue, identity);
    const visibleTeamIds = await loadVisibleTeamIds(
      db,
      organizationId,
      identity
    );
    const similar = await stub.findSimilarIssues(
      issue.id,
      visibleTeamIds,
      limit ?? 10,
      await issueViewer(db, identity)
    );
    return c.json({
      similar: similar.filter((hit) =>
        visibleTeamIds.includes(hit.issue.teamId)
      ),
    });
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
    await assertIssueAccess(db, stub, existing, identity);
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
      await assertIssueAccess(db, stub, parent, identity);
      if (parent.parentId) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "Sub-issues can only be nested one level",
          hint: `Parent ${parent.identifier} is already a sub-issue`,
        });
      }
      const children = await stub.getIssueChildren(existing.id);
      if (children.length > 0) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "An issue with sub-issues cannot become a sub-issue",
          hint: `Children: ${children.map((child) => child.identifier).join(", ")}`,
        });
      }
      if (
        await wouldCreateCycle(stub, existing.id, parent.id, new Set<string>())
      ) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "Parent would create a cycle",
        });
      }
    }
    if (typeof input.externalRef === "string") {
      const existingByRef = await stub.getIssueByExternalRef(input.externalRef);
      if (existingByRef && existingByRef.id !== existing.id) {
        throw new VortexError({
          code: "CONFLICT",
          status: 409,
          message: "externalRef already used",
          hint: `Issue ${existingByRef.identifier} already has externalRef ${input.externalRef}`,
        });
      }
    }
    validateIssueState(input.status ?? existing.status, input.resolution);
    const issue = await stub.updateIssue(
      existing.id,
      { ...input, teamId },
      identity.id
    );
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
    if (input.labelIds !== undefined) {
      await triggerPlanLabel(
        c.env,
        db,
        stub,
        organizationId,
        existing.labelIds,
        issue,
        identity,
        getExecutionCtx(c)
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

    let parent: Issue | undefined;
    if (patch.parentId !== undefined && patch.parentId !== null) {
      parent = await stub.getIssue(patch.parentId);
      if (!parent) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: "Parent issue not found",
        });
      }
      await assertIssueAccess(db, stub, parent, identity);
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
      validIssues.map((issue) => assertIssueAccess(db, stub, issue, identity))
    );
    for (const issue of validIssues) {
      validateIssueState(patch.status ?? issue.status, patch.resolution);
    }

    if (parent) {
      const parentId: string = parent.id;
      await Promise.all(
        validIssues.map((issue) =>
          wouldCreateCycle(stub, issue.id, parentId, new Set<string>())
        )
      );
    }

    const issues = await stub.batchUpdateIssues(
      validIssues.map((issue) => issue.id),
      patch,
      identity.id
    );
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
    await assertIssueAccess(db, stub, existing, identity);
    const deleted = await stub.deleteIssue(existing.id, identity.id);
    if (!deleted) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    await deleteIssueReferences(db, organizationId, existing.id);
    return c.body(null, 204);
  });

  app.openapi(dispatchRoute, async (c) => {
    const {
      agentId,
      provider,
      model,
      repo,
      branch,
      instructions,
      preflight,
      mode,
      effort,
      maxDuration,
      resultSchema: resultSchemaInput,
      secondaryRepos,
    } = c.req.valid("json");
    const { organizationId, id } = c.req.valid("param");
    const identity = c.get("workspaceIdentity");
    const db = createD1(c.env.D1);
    await consumeUsage(
      db,
      organizationId,
      "agents",
      "dispatch",
      Number(c.env.FREE_USE_CAP ?? 0),
      1,
      c.env,
      getExecutionCtx(c)
    );
    const stub = await getStub(c.env, organizationId);
    const issue = await stub.getIssue(id);
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }
    await assertIssueAccess(db, stub, issue, identity);

    // PILE-241 — branch names the lane's working branch: the runner creates
    // it off the repo default and pushes it. Passing "main"/"master" makes
    // the lane try to create the default branch and fail at push time.
    if (branch && (branch === "main" || branch === "master")) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: `"${branch}" is a repo default branch — branch sets the lane's working branch (leave empty for issue-<id>)`,
      });
    }
    // PILE-321 — a repo-less issue inherits the team's defaultRepo at
    // dispatch (the same fallback issue create applies). An explicit `repo`
    // body field still wins — null deliberately forces a repo-less lane.
    const dispatchIssue =
      repo === undefined
        ? await inheritTeamDefaultRepo(
            db,
            stub,
            organizationId,
            issue,
            identity.id
          )
        : issue;
    const target: Issue = {
      ...dispatchIssue,
      repo: repo === undefined ? dispatchIssue.repo : repo,
      branch: branch === undefined ? dispatchIssue.branch : branch,
    };

    if (preflight && mode && mode !== "build") {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "preflight cannot be combined with plan modes",
      });
    }

    // Explicit agentId wins; otherwise a repo's configured default agent
    // (github installation row) beats the global "devin" fallback. PILE-221
    // `.pile/config.json` enforcement applies to UI, API, and automation
    // dispatches alike.
    const {
      agentId: resolvedAgentId,
      model: configuredModel,
      pileConfig,
    } = await resolveDispatchAgent(c.env, db, organizationId, target, {
      agentId: agentId ?? provider,
      model,
    });
    const resolvedEffort = resolveDispatchEffort(
      effort ?? (preflight ? "low" : undefined),
      target
    );
    const resolvedModel =
      model ?? pileConfig?.effortModels?.[resolvedEffort] ?? configuredModel;
    const resultSchema = resultSchemaInput
      ? resolveResultSchema(resultSchemaInput)
      : undefined;

    // VTX-209 — deterministic readiness gate. Advisory only: the report rides
    // the response and gaps are annotated on the thread once, so callers see
    // exactly what a lane would trip over before tokens get spent.
    const readiness = evaluateDispatchReadiness(target);
    if (!readiness.ready) {
      const thread = await stub.listComments(issue.id).catch(() => []);
      const alreadyFlagged = thread.some(
        (comment) => comment.externalSource === "preflight"
      );
      if (!alreadyFlagged) {
        await stub
          .createComment({
            issueId: issue.id,
            body: `Dispatch preflight flagged gaps:\n\n${readiness.missing.map((m) => `- ${m}`).join("\n")}\n\nAnswer these in the thread before dispatching, or dispatch anyway.`,
            externalAuthor: "preflight",
            externalSource: "preflight",
          })
          .catch(() => null);
      }
    }

    const providerConfig = await loadProviderConfig(
      c.env,
      stub,
      resolvedAgentId
    );
    const effectiveEnv = resolveAgentEnv(c.env, providerConfig ?? undefined);

    // Planner-critique mode: a repo-less lane on the SAME target provider
    // reads the ticket and reports what a real lane would need clarified.
    // Runs detached from the repo so it can't implement — critique only.
    const planMode = mode === "plan" || mode === "implement_plan" ? mode : null;
    const planOptions = planMode
      ? await planLaneOptions(stub, target, planMode, instructions ?? null)
      : null;

    const session = planOptions
      ? await dispatchAgent(
          effectiveEnv,
          resolvedAgentId,
          organizationId,
          target,
          identity,
          resolvedModel,
          getExecutionCtx(c),
          {
            instructions:
              // `plan` with an existing plan already folds instructions in
              // as revision feedback.
              instructions &&
              (planMode === "implement_plan" || !planOptions.plan)
                ? `${planOptions.instructions}\n\n${instructions}`
                : planOptions.instructions,
            envAllowlist: pileConfig?.env,
            // Infra env (not caller-supplied), so the repo env allowlist
            // doesn't filter it.
            extraEnv: planOptions.extraEnv,
            purpose: planOptions.purpose ?? undefined,
            skipQueue: planOptions.skipQueue,
            secondaryRepos,
            effort: resolvedEffort,
            maxDurationMinutes: maxDuration,
            resultSchema,
          }
        )
      : preflight
        ? await dispatchAgent(
            effectiveEnv,
            resolvedAgentId,
            organizationId,
            { ...target, repo: null, branch: null },
            identity,
            resolvedModel,
            getExecutionCtx(c),
            {
              instructions: [
                buildPreflightCritiqueInstructions(target),
                instructions ?? null,
              ]
                .filter((line): line is string => line !== null)
                .join("\n\n"),
              envAllowlist: pileConfig?.env,
              purpose: "preflight",
              skipQueue: true,
              effort: resolvedEffort,
              maxDurationMinutes: maxDuration,
              resultSchema,
            }
          )
        : await dispatchAgent(
            effectiveEnv,
            resolvedAgentId,
            organizationId,
            target,
            identity,
            resolvedModel,
            getExecutionCtx(c),
            {
              instructions,
              envAllowlist: pileConfig?.env,
              secondaryRepos,
              effort: resolvedEffort,
              maxDurationMinutes: maxDuration,
              resultSchema,
            }
          );

    if (planOptions) {
      await notePlanSource(stub, session, planOptions.plan);
    }

    if (target.repo && target.branch && !preflight && planMode !== "plan") {
      await createRepoBranch(
        db,
        organizationId,
        target.repo,
        target.branch,
        target.id
      );
    }

    return c.json({ ...toSessionResponse(session), preflight: readiness }, 201);
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
    await assertIssueAccess(db, stub, existing, identity);

    const issue = await stub.updateIssue(
      existing.id,
      { assigneeId },
      identity.id
    );
    if (!issue) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Issue not found",
      });
    }

    let session: Awaited<ReturnType<typeof dispatchAgent>> | undefined;
    if (assigneeId === null) {
      // Unassign kills the lane (PILE-211): cancel any live session on this
      // issue — the issue is the orchestration surface.
      const active = await stub.getActiveAgentSessionForIssue(issue.id);
      if (active) {
        const providerConfig = await loadProviderConfig(
          c.env,
          stub,
          active.session.agentId
        );
        const provider = getAgentProvider(
          active.session.agentId,
          resolveAgentEnv(c.env, providerConfig ?? undefined)
        );
        if (provider.cancel) {
          await provider
            .cancel(active.session.providerSessionId ?? active.session.id)
            .catch((err) => console.error("unassign cancel failed", err));
        }
        await stub.applyAgentSessionResult(
          active.session.id,
          { status: "canceled" },
          identity.id
        );
      }
    }
    if (assigneeId) {
      let isAgent = false;
      try {
        getAgentProvider(assigneeId, c.env);
        isAgent = true;
      } catch {
        isAgent = false;
      }
      if (isAgent) {
        if (!identity.permissions.includes("agent:write")) {
          throw new VortexError({
            code: "FORBIDDEN",
            status: 403,
            message: "Missing permission: agent:write",
          });
        }
        const providerConfig = await loadProviderConfig(
          c.env,
          stub,
          assigneeId
        );
        const effectiveEnv = resolveAgentEnv(
          c.env,
          providerConfig ?? undefined
        );
        // PILE-321 — assigning an agent dispatches a lane, so the same
        // team-defaultRepo inheritance as /dispatch applies here.
        const dispatchTarget = await inheritTeamDefaultRepo(
          db,
          stub,
          organizationId,
          issue,
          identity.id
        );
        session = await dispatchAgent(
          effectiveEnv,
          assigneeId,
          organizationId,
          dispatchTarget,
          identity,
          undefined,
          getExecutionCtx(c)
        );
      }
    }

    return c.json(
      { issue, session: session ? toSessionResponse(session) : undefined },
      200
    );
  });
}
