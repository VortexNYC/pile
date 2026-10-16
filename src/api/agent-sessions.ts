import type { OpenAPIHono } from "@hono/zod-openapi";
import { createRoute, z } from "@hono/zod-openapi";
import { and, eq, type InferSelectModel } from "drizzle-orm";

import {
  dispatchEffortSchema,
  maxDurationSchema,
  resolveDispatchEffort,
} from "../agents/budget.js";
import {
  agentLogToken,
  agentLogUrl,
  agentMcpUrl,
  agentReportUrl,
  loadProviderConfig,
  verifySessionToken,
} from "../agents/credentials.js";
import { resolveAgentEnv } from "../agents/daytona.js";
import type { SessionGuidanceRef } from "../agents/guidance.js";
import {
  dispatchAgent,
  getAgentProvider,
  inheritTeamDefaultRepo,
  providerKeepsTerminalSandbox,
} from "../agents/index.js";
import { mintLaneGithubToken } from "../agents/lane-github-token.js";
import {
  laneReportStepMessage,
  laneTodosSchema,
  type LaneTodo,
} from "../agents/lane-progress.js";
import { resolveResultSchema, sessionLabel } from "../agents/lane-result.js";
import {
  parseStoredSecondaryRepos,
  secondaryReposSchema,
} from "../agents/secondary-repos.js";
import {
  parseSessionPlan,
  sessionPlanItemSchema,
  sessionPlanSchema,
} from "../agents/session-plan.js";
import { runUsageSchema, spendCapBodySchema } from "../agents/spend.js";
import {
  releasePausedSessions,
  sessionHoldsKeptSandbox,
} from "../agents/sweep.js";
import { consumeUsage } from "../global/billing.js";
import { timingSafeEqualHex } from "../global/crypto.js";
import { createD1 } from "../global/db.js";
import { getInstallationTokenForRepo } from "../global/github-auth.js";
import { prUrlOnRepo } from "../global/lane-guard.js";
import {
  fetchLanePermissions,
  fetchPileRepoConfig,
  laneTokenPermissions,
} from "../global/pile-repo-config.js";
import { scrubLaneText } from "../global/redact.js";
import { createRepoBranch } from "../global/repo-branches.js";
import { githubInstallations } from "../global/schema.js";
import { replyLaneResultToTicket } from "../global/support-escalation.js";
import { VortexError } from "../platform/errors.js";
import type { WorkspaceIdentity } from "../platform/identity.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import {
  DEFAULT_GIT_IDENTITY_REPO,
  type AgentSessionStatus,
  type Issue,
} from "../types/workspace.js";
import type {
  AgentRunReceipt,
  AgentSessionSummary,
} from "../workspace/data/index.js";
import type {
  workspaceAgentActivities,
  workspaceAgentSessions,
} from "../workspace/schema.js";
import { captureSessionPrArtifact } from "./agent-artifacts.js";
import { getExecutionCtx } from "./execution-ctx.js";
import {
  assertIssueAccess,
  issueViewer,
  resolveVisibleIssueRef,
} from "./issue-access.js";
import { fetchGitHubCheckRuns, fetchGitHubPull, parsePrUrl } from "./pr.js";
import { getWorkspaceStub, resolveIssueRef } from "./stub.js";

const agentActivityTypeSchema = z.enum([
  "thought",
  "response",
  "error",
  "elicitation",
  "prompt",
  "action",
  "status",
  "artifact",
]);

type AgentSession = InferSelectModel<typeof workspaceAgentSessions>;

// Session-scoped routes deny access when the session's issue is restricted
// for the caller (issue_permissions) — session rows and lane activities
// carry issue content. Denial reports "Session not found" so restricted
// issues and their lanes stay invisible.
async function assertSessionIssueAccess(
  db: ReturnType<typeof createD1>,
  stub: ReturnType<typeof getWorkspaceStub>,
  session: Pick<AgentSession, "issueId">,
  identity: WorkspaceIdentity
): Promise<void> {
  // Lane tokens ("lane:<sessionId>") are verified against this exact
  // session upstream — the token is the grant; a restricted issue's lane
  // must still read/write its own session.
  if (identity.id.startsWith("lane:")) return;
  const issue = await stub.getIssue(session.issueId);
  // Sessions outlive deleted issues — nothing to check against.
  if (!issue) return;
  try {
    await assertIssueAccess(db, stub, issue, identity);
  } catch (err) {
    if (err instanceof VortexError && err.status === 404) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Session not found",
      });
    }
    throw err;
  }
}

type AgentActivity = InferSelectModel<typeof workspaceAgentActivities>;

// PILE-425 — one row per run: the usage a lane reported plus cost computed
// from the rate map when the provider didn't report spend.
const runReceiptSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  sessionId: z.string(),
  issueId: z.string(),
  agentId: z.string(),
  stepKey: z.string().nullable(),
  dealId: z.string().nullable(),
  status: z.string(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  totalTokens: z.number().int().nullable(),
  toolCalls: z.number().int().nullable(),
  costMicros: z.number().int().nullable(),
  externalSpendMicros: z.number().int().nullable(),
  /** costMicros + externalSpendMicros; null when neither was reported. */
  totalCostMicros: z.number().int().nullable(),
  costSource: z.enum(["reported", "rate_map"]).nullable(),
  capExceeded: z.number().int(),
  stopReason: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function toReceiptResponse(row: AgentRunReceipt) {
  // DB column is free text — narrow to the two sources this build writes.
  const costSource: "reported" | "rate_map" | null =
    row.costSource === "reported"
      ? "reported"
      : row.costSource === "rate_map"
        ? "rate_map"
        : null;
  return {
    ...row,
    costSource,
    totalCostMicros:
      row.costMicros !== null || row.externalSpendMicros !== null
        ? (row.costMicros ?? 0) + (row.externalSpendMicros ?? 0)
        : null,
  };
}

const agentSessionStatusSchema = z.enum([
  "created",
  "running",
  "stale",
  "waiting",
  "completed",
  "failed",
  "canceled",
]);

export const agentSessionSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  issueId: z.string(),
  agentId: z.string(),
  provider: z.string(),
  actorId: z.string(),
  actorType: z.enum(["user", "agent"]),
  status: agentSessionStatusSchema,
  result: z.string().nullable(),
  url: z.string().nullable(),
  providerSessionId: z.string().nullable(),
  prUrl: z.string().nullable(),
  prState: z.string().nullable(),
  branch: z.string().nullable(),
  purpose: z.string().nullable().optional(),
  // JSON [{repo, access}] — see secondaryRepoSchema.
  secondaryRepos: z.string().nullable().optional(),
  maxDurationMinutes: z.number().int().nullable().optional(),
  effort: dispatchEffortSchema.nullable().optional(),
  /** Auto-generated run name for logs and `pile fleet` (PILE-289). */
  label: z.string().nullable().optional(),
  /** Dispatch-time JSON Schema (draft-07) the lane's output is validated
   *  against; `structuredResult` is the validated value, else
   *  `resultSchemaErrors` lists why it failed. */
  resultSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  structuredResult: z.unknown().nullable().optional(),
  resultSchemaErrors: z.array(z.string()).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastProgressAt: z.string().nullable().optional(),
  lastStateHash: z.string().nullable().optional(),
  /** PILE-419 — id of the open (unanswered) elicitation activity that
   *  suspended this session in `waiting`; null when not awaiting input. */
  awaitingActivityId: z.string().nullable().optional(),
  /** When the open elicitation last fired its escalation (dedupe stamp). */
  awaitingEscalatedAt: z.string().nullable().optional(),
  /** PILE-420 — 1 while the lane is parked `waiting` by an agent-type
   *  pause; resume drains holds in order. */
  paused: z.number().optional(),
  /** PILE-423 — pipeline sub-step key this lane works; step-scoped guidance
   *  packs resolve against it. */
  stepKey: z.string().nullable().optional(),
  /** PILE-426 — the agent's published plan checklist, in declared order.
   *  Replaced wholesale on each update; null when no plan was published. */
  plan: z.array(sessionPlanItemSchema).nullable().optional(),
  /** PILE-423 — the guidance packs injected into this lane's dispatch
   *  prompt, in injection order (least specific first). Versions resolve
   *  against the pack's revision history. */
  guidance: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        scope: z.enum(["workspace", "team", "status", "step"]),
        scopeKey: z.string().nullable(),
        version: z.number().int(),
      })
    )
    .nullable()
    .optional(),
  /** Read-time derivation (PILE-209): `stalled` = running, stale progress,
   *  no PR; `needs_input` = an open elicitation is parked on the session
   *  (or, for pre-suspend rows, the latest activity is an elicitation).
   *  Never stored. */
  derivedStatus: z.enum(["stalled", "needs_input"]).nullable().optional(),
  /** PILE-425 — the run's usage/cost receipt, populated on the session
   *  detail GET when the lane reported usage or reached terminal state. */
  receipt: runReceiptSchema.nullable().optional(),
  activities: z
    .array(
      z.object({
        id: z.string(),
        sessionId: z.string(),
        actorId: z.string().nullable(),
        type: agentActivityTypeSchema,
        message: z.string(),
        payload: z.unknown().nullable(),
        parentId: z.string().nullable(),
        startedAt: z.string().nullable(),
        endedAt: z.string().nullable(),
        durationMs: z.number().nullable(),
        createdAt: z.string(),
      })
    )
    .optional(),
});

// PILE-256 — `?summary=1` list/get shape: lane-row scalars only. `result`,
// `activities`, `lastStateHash`, actor ids, and retry/lane bookkeeping stay
// on the full shape so polling dashboards and the fleet TUI stop shipping
// multi-KB blobs per row.
const agentSessionSummarySchema = agentSessionSchema
  .pick({
    id: true,
    issueId: true,
    agentId: true,
    provider: true,
    status: true,
    prUrl: true,
    prState: true,
    createdAt: true,
    updatedAt: true,
    lastProgressAt: true,
    derivedStatus: true,
    label: true,
    awaitingActivityId: true,
  })
  .extend({
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
  });

const agentActivitySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  actorId: z.string().nullable(),
  type: agentActivityTypeSchema,
  message: z.string(),
  payload: z.unknown().nullable(),
  parentId: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  createdAt: z.string(),
});

function toActivityResponse(row: AgentActivity) {
  return {
    ...row,
    payload: row.payload ? JSON.parse(row.payload) : null,
  };
}

const STALLED_PROGRESS_MS = 15 * 60 * 1000;

/** Durable fields only are stored; display status is derived at read —
 *  same rule as AO: never mark dead, just surface ambiguity. */
function deriveSessionStatus(
  row: Pick<
    AgentSession,
    "status" | "prUrl" | "lastProgressAt" | "awaitingActivityId"
  >,
  activities?: AgentActivity[]
): "stalled" | "needs_input" | null {
  if (["completed", "failed", "canceled"].includes(row.status)) return null;
  // PILE-420 — the durable `stale` mark surfaces as the same `stalled`
  // badge a silent `running` lane derives at read.
  if (row.status === "stale") return "stalled";
  // PILE-419 — an open elicitation suspends the session (`waiting` +
  // awaitingActivityId); legacy rows only carry the trailing activity.
  if (row.awaitingActivityId) return "needs_input";
  if (row.status !== "running") return null;
  const last = activities?.[activities.length - 1];
  if (last?.type === "elicitation") return "needs_input";
  if (row.prUrl) return null;
  const progressed = row.lastProgressAt ? Date.parse(row.lastProgressAt) : NaN;
  if (
    Number.isFinite(progressed) &&
    Date.now() - progressed > STALLED_PROGRESS_MS
  ) {
    return "stalled";
  }
  return null;
}

function parseJsonColumn(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  const parsed = parseJsonColumn(value);
  return isJsonObject(parsed) ? parsed : null;
}

function parseStringArray(value: string | null): string[] | null {
  const parsed = parseJsonColumn(value);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : null;
}

const GUIDANCE_SCOPES = new Set(["workspace", "team", "status", "step"]);

// PILE-423 — the session row stores guidance refs as JSON; only well-formed
// entries reach the response (a hand-edited row degrades to null).
function parseGuidanceRefs(value: string | null): SessionGuidanceRef[] | null {
  const parsed = parseJsonColumn(value);
  if (!Array.isArray(parsed)) return null;
  const refs: SessionGuidanceRef[] = [];
  for (const entry of parsed) {
    if (!isJsonObject(entry)) return null;
    const { id, name, scope, scopeKey, version } = entry;
    if (
      typeof id !== "string" ||
      typeof name !== "string" ||
      typeof version !== "number" ||
      typeof scope !== "string" ||
      !GUIDANCE_SCOPES.has(scope) ||
      (scopeKey !== null && typeof scopeKey !== "string")
    ) {
      return null;
    }
    refs.push({
      id,
      name,
      scope: scope as SessionGuidanceRef["scope"],
      scopeKey,
      version,
    });
  }
  return refs;
}

export function toSessionResponse(
  row: AgentSession,
  activities?: AgentActivity[]
) {
  return {
    ...row,
    resultSchema: parseJsonObject(row.resultSchema),
    structuredResult: parseJsonColumn(row.structuredResult),
    resultSchemaErrors: parseStringArray(row.resultSchemaErrors),
    guidance: parseGuidanceRefs(row.guidance),
    plan: parseSessionPlan(row.plan),
    derivedStatus: deriveSessionStatus(row, activities),
    activities: activities?.map(toActivityResponse),
  };
}

// Whitelist, not spread: callers may pass a full row (detail route) or the
// projected summary row (list route) — either way only scalars leave.
function toSessionSummary(row: AgentSessionSummary) {
  return {
    id: row.id,
    issueId: row.issueId,
    agentId: row.agentId,
    provider: row.provider,
    status: row.status,
    prUrl: row.prUrl,
    prState: row.prState,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    endedAt: row.endedAt,
    lastProgressAt: row.lastProgressAt,
    label: row.label,
    awaitingActivityId: row.awaitingActivityId,
    derivedStatus: deriveSessionStatus(row),
  };
}

function isSummaryQuery(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

const listSessionsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/sessions",
  tags: ["agent-sessions"],
  middleware: [rls("session:view", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: z.object({
      issueId: z.string().optional(),
      limit: z.string().optional(),
      summary: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description:
        "Agent sessions list. Pass `?summary=1` for lane-row scalars only (no result/activity blobs) — the shape `pile fleet` polls.",
      content: {
        "application/json": {
          schema: z.union([
            z.object({ sessions: z.array(agentSessionSchema) }),
            z.object({ sessions: z.array(agentSessionSummarySchema) }),
          ]),
        },
      },
    },
  },
});

function avgSeconds(durations: number[]): number | null {
  if (durations.length === 0) return null;
  return Math.round(
    durations.reduce((a, b) => a + b, 0) / durations.length / 1000
  );
}

const agentStatsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/stats",
  tags: ["agent-sessions"],
  middleware: [rls("session:view", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description:
        "Aggregate agent session stats for the workspace: totals, per-provider breakdown, success rate, durations, and infra failures",
      content: {
        "application/json": {
          schema: z.object({
            total: z.number(),
            byStatus: z.record(z.string(), z.number()),
            infraFailures: z.number(),
            avgDurationSeconds: z.number().nullable(),
            providers: z.array(
              z.object({
                agentId: z.string(),
                total: z.number(),
                completed: z.number(),
                failed: z.number(),
                successRate: z.number().nullable(),
                avgDurationSeconds: z.number().nullable(),
              })
            ),
          }),
        },
      },
    },
  },
});

// PILE-242 — one read for "is the fleet healthy": kept-sandbox pressure,
// terminal sessions missing the endedAt anchor (would leak), and per-
// provider infra-failure streaks (the unhealthy signal).
const fleetHealthRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/fleet-health",
  tags: ["agent-sessions"],
  middleware: [rls("session:view", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description:
        "Fleet health: live lanes, kept sandboxes per provider, endedAt gaps, infra failure streaks",
      content: {
        "application/json": {
          schema: z.object({
            live: z.number(),
            missingEndedAt: z.number(),
            providers: z.array(
              z.object({
                agentId: z.string(),
                live: z.number(),
                keptSandboxes: z.number(),
                infraStreak: z.number(),
                unhealthy: z.boolean(),
              })
            ),
          }),
        },
      },
    },
  },
});

const issueLiveRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/issues/{issueId}/live",
  tags: ["agent-sessions"],
  middleware: [rls("issue:view", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string(), issueId: z.string() }),
  },
  responses: {
    200: {
      description: "Live agent state for issue",
      content: {
        "application/json": {
          schema: z.object({
            session: agentSessionSchema.nullable(),
            activities: z.array(agentActivitySchema),
          }),
        },
      },
    },
  },
});

const getSessionRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}",
  tags: ["agent-sessions"],
  middleware: [rls("session:view", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    query: z.object({ summary: z.string().optional() }),
  },
  responses: {
    200: {
      description:
        "Agent session with activities. Pass `?summary=1` for lane-row scalars only.",
      content: {
        "application/json": {
          schema: z.union([agentSessionSchema, agentSessionSummarySchema]),
        },
      },
    },
    404: { description: "Session not found" },
  },
});

const getSessionEventsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/events",
  tags: ["agent-sessions"],
  middleware: [rls("session:view", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    query: z.object({
      limit: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Agent session events",
      content: {
        "application/json": {
          schema: z.object({
            events: z.array(
              z.union([
                agentActivitySchema.extend({ kind: z.literal("activity") }),
                z.object({
                  kind: z.literal("event"),
                  id: z.number(),
                  sessionId: z.string(),
                  type: z.string(),
                  message: z.string(),
                  payload: z.unknown().nullable(),
                  createdAt: z.string(),
                }),
              ])
            ),
          }),
        },
      },
    },
    404: { description: "Session not found" },
  },
});

const getSessionChecksRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/checks",
  tags: ["agent-sessions"],
  middleware: [rls("session:view", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
  },
  responses: {
    200: {
      description: "CI check-runs for the session's pull request",
      content: {
        "application/json": {
          schema: z.object({
            checks: z.array(
              z.object({
                name: z.string(),
                status: z.string(),
                conclusion: z.string().nullable(),
                detailsUrl: z.string().nullable(),
                htmlUrl: z.string().nullable(),
              })
            ),
            prCheckState: z.string().nullable(),
          }),
        },
      },
    },
    400: { description: "Session prUrl is not a GitHub PR" },
    404: { description: "Session not found" },
    502: { description: "GitHub lookup failed" },
  },
});

const addActivityRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/activities",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            type: agentActivityTypeSchema,
            message: z.string().min(1),
            payload: z.record(z.string(), z.unknown()).optional(),
            parentId: z.string().optional(),
            startedAt: z.string().optional(),
            endedAt: z.string().optional(),
            durationMs: z.number().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Activity added",
      content: {
        "application/json": { schema: agentActivitySchema },
      },
    },
    404: { description: "Session not found" },
    409: { description: "Session is terminal" },
  },
});

const artifactTypeSchema = z.enum([
  "diff",
  "log",
  "screenshot",
  "trace",
  "output",
  "other",
]);

const createArtifactBodySchema = z
  .object({
    name: z.string().min(1),
    type: artifactTypeSchema,
    content: z.string().optional(),
    data: z.string().optional(),
    mimeType: z.string().optional(),
    url: z
      .string()
      .refine(
        (v) => /^https?:\/\//i.test(v),
        "URL must start with http:// or https://"
      )
      .optional(),
  })
  .refine(
    (value) =>
      value.content !== undefined ||
      value.data !== undefined ||
      value.url !== undefined,
    "At least one of content, data, or url is required"
  );

const createArtifactRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/artifacts",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    body: {
      content: {
        "application/json": { schema: createArtifactBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "Artifact captured",
      content: { "application/json": { schema: agentActivitySchema } },
    },
    404: { description: "Session not found" },
  },
});

const patchSessionRoute = createRoute({
  method: "patch",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}",
  tags: ["agent-sessions"],
  middleware: [rls("session:edit", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            status: agentSessionStatusSchema.optional(),
            result: z.string().optional(),
            url: z
              .string()
              .refine(
                (v) => /^https?:\/\//i.test(v),
                "URL must start with http:// or https://"
              )
              .optional(),
            prUrl: z.string().optional(),
            prState: z.string().optional(),
            branch: z.string().optional(),
            // PILE-426 — publish/replace the plan checklist. Whole-array
            // replace: the agent resends the full ordered list each update.
            plan: sessionPlanSchema.optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Session updated",
      content: {
        "application/json": { schema: agentSessionSchema },
      },
    },
    404: { description: "Session not found" },
  },
});

const cancelSessionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/cancel",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
  },
  responses: {
    200: {
      description: "Session canceled",
      content: {
        "application/json": { schema: agentSessionSchema },
      },
    },
    404: { description: "Session not found" },
  },
});

// PILE-420 — human Stop: emits `session.stopped`, cancels in-flight runtime
// work via the provider, and ends the session terminal with the stopped
// reason — actor and reason land on the event and the audit entry. No
// further activities are accepted once terminal.
const stopSessionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/stop",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ reason: z.string().optional() }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Session stopped",
      content: {
        "application/json": { schema: agentSessionSchema },
      },
    },
    404: { description: "Session not found" },
  },
});

// PILE-420 — global pause per agent type: while a pause row exists, new
// dispatches for that agent park `waiting` + `paused`; resuming releases
// the holds in order. Pauses carry actor + reason (audit-logged).
const agentPauseSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  agentId: z.string(),
  reason: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});

const listAgentPausesRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/pauses",
  tags: ["agent-sessions"],
  middleware: [rls("session:view", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Paused agent types for the workspace",
      content: {
        "application/json": {
          schema: z.object({ pauses: z.array(agentPauseSchema) }),
        },
      },
    },
  },
});

const pauseAgentTypeRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/agent/pauses/{agentId}",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), agentId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ reason: z.string().optional() }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description:
        "Agent type paused — new dispatches queue until resume (upserts: re-pausing refreshes reason/actor)",
      content: {
        "application/json": { schema: agentPauseSchema },
      },
    },
  },
});

const resumeAgentTypeRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/agent/pauses/{agentId}",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), agentId: z.string() }),
  },
  responses: {
    200: {
      description:
        "Agent type resumed — held sessions released oldest-first (`released` lists them)",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.boolean(),
            released: z.array(z.string()),
          }),
        },
      },
    },
    404: { description: "Agent type is not paused" },
  },
});

// PILE-425 — per-agent spend/token caps. `agentId` "*" is the workspace
// default applied to agent types without their own row. Hitting a cap
// pauses the agent type (agent_pauses row, createdBy "spend-cap") and
// alerts the CoS once per breach-day.
const agentSpendCapSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  agentId: z.string(),
  maxRunsPerDay: z.number().int().nullable(),
  maxRunsPerMonth: z.number().int().nullable(),
  maxTokensPerDay: z.number().int().nullable(),
  maxTokensPerMonth: z.number().int().nullable(),
  maxCostMicrosPerDay: z.number().int().nullable(),
  maxCostMicrosPerMonth: z.number().int().nullable(),
  maxTokensPerRun: z.number().int().nullable(),
  maxCostMicrosPerRun: z.number().int().nullable(),
  lastCapAlertAt: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const receiptFilterQuerySchema = z.object({
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  issueId: z.string().optional(),
  stepKey: z.string().optional(),
  dealId: z.string().optional(),
  /** ISO 8601 bounds on the receipt's createdAt — when the run recorded. */
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.string().optional(),
});

const listSpendCapsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/spend-caps",
  tags: ["agent-sessions"],
  middleware: [rls("session:view", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description:
        'Spend/token caps for the workspace — agentId "*" is the workspace default',
      content: {
        "application/json": {
          schema: z.object({ caps: z.array(agentSpendCapSchema) }),
        },
      },
    },
  },
});

const upsertSpendCapRoute = createRoute({
  method: "put",
  path: "/workspaces/{organizationId}/agent/spend-caps/{agentId}",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), agentId: z.string() }),
    body: {
      content: { "application/json": { schema: spendCapBodySchema } },
    },
  },
  responses: {
    200: {
      description:
        "Spend caps upserted for the agent type — null fields clear a limit; omitted fields keep their value",
      content: {
        "application/json": { schema: agentSpendCapSchema },
      },
    },
  },
});

const deleteSpendCapRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/agent/spend-caps/{agentId}",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), agentId: z.string() }),
  },
  responses: {
    200: {
      description: "Spend caps deleted for the agent type",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
    404: { description: "No caps configured for this agent type" },
  },
});

const listRunReceiptsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/receipts",
  tags: ["agent-sessions"],
  middleware: [rls("session:view", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: receiptFilterQuerySchema,
  },
  responses: {
    200: {
      description: "Run receipts — per-run usage + cost records",
      content: {
        "application/json": {
          schema: z.object({ receipts: z.array(runReceiptSchema) }),
        },
      },
    },
  },
});

const summarizeRunReceiptsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/receipts/summary",
  tags: ["agent-sessions"],
  middleware: [rls("session:view", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
    query: receiptFilterQuerySchema.extend({
      groupBy: z.enum(["agentId", "stepKey", "issueId", "dealId"]),
    }),
  },
  responses: {
    200: {
      description:
        "Run receipts aggregated per agent, step (pipeline stage), issue, or deal",
      content: {
        "application/json": {
          schema: z.object({
            summary: z.array(
              z.object({
                key: z.string().nullable(),
                runs: z.number().int(),
                inputTokens: z.number().int(),
                outputTokens: z.number().int(),
                totalTokens: z.number().int(),
                toolCalls: z.number().int(),
                costMicros: z.number().int(),
                externalSpendMicros: z.number().int(),
                capExceededRuns: z.number().int(),
              })
            ),
          }),
        },
      },
    },
  },
});

const pollSessionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/poll",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
  },
  responses: {
    200: {
      description: "Session polled and updated",
      content: {
        "application/json": { schema: agentSessionSchema },
      },
    },
    404: { description: "Session not found" },
  },
});

const getSessionStateRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/state",
  tags: ["agent-sessions"],
  middleware: [rls("session:view", "agent:read")],
  request: {
    params: z.object({
      organizationId: z.string(),
      sessionId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Live agent session state from provider and compute",
      content: {
        "application/json": {
          schema: z.object({
            session: agentSessionSchema,
            provider: z.unknown().nullable().optional(),
            compute: z.unknown().nullable().optional(),
          }),
        },
      },
    },
    400: { description: "Not supported for this agent or not configured" },
    404: { description: "Session not found" },
  },
});

const childIssueSchema = z.object({
  id: z.string(),
  identifier: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  priority: z.string(),
  repo: z.string().nullable(),
  branch: z.string().nullable(),
  parentId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const createChildSessionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/children",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            title: z.string().min(1),
            description: z.string().optional(),
            agentId: z.string().optional(),
            model: z.string().optional(),
            repo: z.string().optional(),
            effort: dispatchEffortSchema.optional(),
            maxDuration: maxDurationSchema.optional(),
            // PILE-423 — defaults to the parent session's stepKey when unset
            // so a spawned sub-lane keeps the same step-scoped guidance.
            stepKey: z.string().min(1).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Child session created and dispatched",
      content: {
        "application/json": {
          schema: z.object({
            session: agentSessionSchema,
            issue: childIssueSchema,
          }),
        },
      },
    },
    400: { description: "Bad request" },
    404: { description: "Session or parent issue not found" },
    429: { description: "Too many active child sessions" },
  },
});

// Inbound registration (PILE-227): sessions for agents Pile didn't dispatch —
// a Cursor cloud agent started elsewhere, a Devin web session, a custom bot.
// The caller (workspace API key) gets back a per-session lane token the
// external agent then uses to push /logs and /report updates; Pile never
// provisions compute for these.
const registerSessionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/register",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              issueId: z.string(),
              provider: z.string().min(1),
              providerSessionId: z.string().optional(),
              status: agentSessionStatusSchema.optional(),
              url: z
                .string()
                .refine(
                  (v) => /^https?:\/\//i.test(v),
                  "URL must start with http:// or https://"
                )
                .optional(),
              branch: z.string().optional(),
              prUrl: z.string().optional(),
            })
            .strict(),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Session registered",
      content: {
        "application/json": {
          schema: z.object({
            session: agentSessionSchema,
            laneToken: z.string().nullable(),
            logUrl: z.string().nullable(),
            reportUrl: z.string().nullable(),
            mcpUrl: z.string().nullable(),
          }),
        },
      },
    },
    200: {
      description: "Session already registered (providerSessionId dedupe)",
      content: {
        "application/json": {
          schema: z.object({
            session: agentSessionSchema,
            laneToken: z.string().nullable(),
            logUrl: z.string().nullable(),
            reportUrl: z.string().nullable(),
            mcpUrl: z.string().nullable(),
          }),
        },
      },
    },
    404: { description: "Issue not found" },
  },
});

// PILE-289 — `"lane"` selects the built-in verdict/summary/filesChanged
// contract; an object is a caller-supplied draft-07 JSON Schema.
export const resultSchemaInputSchema = z
  .union([z.literal("lane"), z.record(z.string(), z.unknown())])
  .openapi({
    description:
      'JSON Schema (draft-07) the lane\'s final output must validate against, or "lane" for the built-in {verdict, summary, filesChanged} shape. The validated value lands on session.structuredResult.',
  });

// PILE-245 — batch dispatch: one call fans out N issues to lanes. Results are
// per-item (a conflict or missing issue reports in place instead of failing
// the batch), and `queuedAfter` sequences an item behind a sibling item's
// issueId, an existing session id, or the live session of a named issue.
const dispatchBatchItemSchema = z
  .object({
    issueId: z.string().min(1),
    agentId: z.string().optional(),
    branch: z.string().nullable().optional(),
    instructions: z.string().optional(),
    // PILE-423 — pipeline sub-step key; step-scoped guidance packs resolve
    // against it and it persists on the session row.
    stepKey: z.string().min(1).optional(),
    queuedAfter: z.string().optional(),
    secondaryRepos: secondaryReposSchema.optional(),
    // PILE-293 — run budget: effort picks the model tier (defaults from the
    // issue's priority); maxDuration (minutes) cancels + escalates the lane.
    effort: dispatchEffortSchema.optional(),
    maxDuration: maxDurationSchema.optional(),
    resultSchema: resultSchemaInputSchema.optional(),
  })
  .strict();

type DispatchBatchItemResult = {
  issueId: string;
  sessionId: string | null;
  status: AgentSessionStatus | null;
  error: string | null;
};

const dispatchBatchItemError = (
  issueId: string,
  error: string
): DispatchBatchItemResult => ({
  issueId,
  sessionId: null,
  status: null,
  error,
});

const dispatchBatchRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/dispatch-batch",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              items: z.array(dispatchBatchItemSchema).min(1).max(50),
            })
            .strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description:
        "Per-item dispatch results — each entry carries a sessionId or an error, independent of sibling failures",
      content: {
        "application/json": {
          schema: z.object({
            batchId: z.string(),
            results: z.array(
              z.object({
                issueId: z.string(),
                sessionId: z.string().nullable(),
                status: agentSessionStatusSchema.nullable(),
                error: z.string().nullable(),
              })
            ),
          }),
        },
      },
    },
  },
});

const promptSessionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/prompt",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ prompt: z.string().min(1) }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Follow-up delivered to the live sandbox",
      content: { "application/json": { schema: agentSessionSchema } },
    },
    404: { description: "Session not found" },
    409: {
      description:
        "Sandbox gone or busy — use the retry route for a cold dispatch",
    },
  },
});

// PILE-419 — a suspended lane's answer path: the human answers the open
// elicitation, the answer lands as a `response` activity parented to the
// question, and the session resumes (`running`, delivered into the live
// sandbox or queued on the event stream; still `waiting` when the lane is
// also queue-parked behind a blocker).
const respondSessionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/respond",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ answer: z.string().min(1) }).strict(),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Answer recorded and session resumed",
      content: { "application/json": { schema: agentSessionSchema } },
    },
    404: { description: "Session not found" },
    409: {
      description:
        "No open elicitation, or the sandbox is gone/busy — use the retry route for a cold dispatch",
    },
  },
});

const retrySessionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/retry",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              context: z.string().optional(),
              agentId: z.string().optional(),
              model: z.string().optional(),
              // Defaults to the original session's budget.
              effort: dispatchEffortSchema.optional(),
              maxDuration: maxDurationSchema.optional(),
            })
            .strict(),
        },
      },
    },
  },
  responses: {
    201: {
      description: "New session dispatched with retry context",
      content: { "application/json": { schema: agentSessionSchema } },
    },
    404: { description: "Session or issue not found" },
    409: { description: "An active session already exists for this issue" },
  },
});

const automationSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  prompt: z.string(),
  agentId: z.string(),
  teamId: z.string().nullable(),
  issueId: z.string().nullable(),
  triggerKind: z.enum(["cron", "event"]),
  triggerValue: z.string(),
  enabled: z.number(),
  lastFiredAt: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});

const listAutomationsRoute = createRoute({
  method: "get",
  path: "/workspaces/{organizationId}/agent/automations",
  tags: ["agent-sessions"],
  middleware: [rls("session:view", "agent:read")],
  request: {
    params: z.object({ organizationId: z.string() }),
  },
  responses: {
    200: {
      description: "Automations for the workspace",
      content: {
        "application/json": {
          schema: z.object({ automations: z.array(automationSchema) }),
        },
      },
    },
  },
});

const createAutomationRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/automations",
  tags: ["agent-sessions"],
  middleware: [rls("session:create", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z
            .object({
              name: z.string().min(1),
              prompt: z.string().min(1),
              agentId: z.string(),
              teamId: z.string().optional(),
              issueId: z.string().optional(),
              triggerKind: z.enum(["cron", "event"]),
              triggerValue: z.string().min(1),
            })
            .strict(),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Automation created",
      content: { "application/json": { schema: automationSchema } },
    },
  },
});

const deleteAutomationRoute = createRoute({
  method: "delete",
  path: "/workspaces/{organizationId}/agent/automations/{automationId}",
  tags: ["agent-sessions"],
  middleware: [rls("session:delete", "agent:write")],
  request: {
    params: z.object({
      organizationId: z.string(),
      automationId: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Automation deleted",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
    404: { description: "Automation not found" },
  },
});

// Runner pnpm-store cache: warm install artifact keyed by lockfile hash,
// stored in R2. Same per-session token auth + middleware bypass as /logs.
const pnpmStoreKey = (organizationId: string, hash: string) =>
  `pnpm-store/${organizationId}/${hash}.tar.gz`;

const cacheJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const putStoreObject = async (
  env: WorkerEnv,
  req: Request,
  key: string
): Promise<Response> => {
  const bucket = env.ATTACHMENTS_BUCKET;
  if (!bucket) return cacheJson({ message: "Cache storage unavailable" }, 503);
  if (!req.body) return cacheJson({ message: "Missing body" }, 400);
  const length = Number(req.headers.get("content-length") ?? 0);
  // ~95MB stays comfortably under the worker request-body ceiling.
  if (length > 95 * 1024 * 1024) {
    return cacheJson({ message: "Part too large" }, 413);
  }
  await bucket.put(key, req.body, {
    httpMetadata: { contentType: "application/gzip" },
  });
  return cacheJson({ ok: true });
};

export function registerAgentSessionRoutes(app: OpenAPIHono<AppContext>) {
  app.openapi(registerSessionRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const issue = await stub.getIssue(input.issueId);
    if (!issue) {
      return c.json({ message: "Issue not found" }, 404);
    }
    // Registering a session mints a lane token for the issue and the label
    // embeds its title — restricted issues must not be reachable here.
    await assertIssueAccess(createD1(c.env.D1), stub, issue, identity);

    const laneUrls = async (sessionId: string) => ({
      laneToken: await agentLogToken(c.env, organizationId, sessionId),
      logUrl: agentLogUrl(c.env, organizationId, sessionId),
      reportUrl: agentReportUrl(c.env, organizationId, sessionId),
      mcpUrl: agentMcpUrl(c.env, organizationId, sessionId),
    });

    // Idempotent: a retry or a webhook bridge re-registering the same
    // provider-side session returns the existing row + fresh lane URLs
    // instead of a duplicate session.
    if (input.providerSessionId) {
      const existing = await stub.getAgentSessionByProviderSessionId(
        input.providerSessionId
      );
      if (existing) {
        return c.json(
          {
            session: toSessionResponse(existing),
            ...(await laneUrls(existing.id)),
          },
          200
        );
      }
    }

    const session = await stub.createAgentSession({
      issueId: issue.id,
      agentId: input.provider,
      provider: input.provider,
      actorId: identity.id,
      actorType: "agent",
      status: input.status ?? "running",
      url: input.url ?? null,
      providerSessionId: input.providerSessionId ?? null,
      prUrl: input.prUrl ?? null,
      label: sessionLabel(issue, input.provider),
      startedAt:
        (input.status ?? "running") === "running"
          ? new Date().toISOString()
          : null,
    });
    if (input.branch) {
      await stub.updateAgentSession(session.id, { branch: input.branch });
    }
    // Registering a session that's already terminal still goes through the
    // result path so completion events and issue effects fire once.
    if (
      input.status === "completed" ||
      input.status === "failed" ||
      input.status === "canceled"
    ) {
      await stub.applyAgentSessionResult(session.id, {
        status: input.status,
        url: input.url ?? null,
        prUrl: input.prUrl ?? null,
        branch: input.branch ?? null,
      });
    }
    return c.json(
      { session: toSessionResponse(session), ...(await laneUrls(session.id)) },
      201
    );
  });

  // PILE-245 — items dispatch concurrently; a failure on one is reported in
  // place instead of failing the batch. `queuedAfter` may name a sibling
  // item's issueId — those edges are resolved through deferred results so
  // dependents park behind the sibling's fresh session.
  app.openapi(dispatchBatchRoute, async (c) => {
    const { items } = c.req.valid("json");
    const { organizationId } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);
    await stub.setOrganizationId(organizationId);
    await consumeUsage(
      db,
      organizationId,
      "agents",
      "dispatch",
      Number(c.env.FREE_USE_CAP ?? 0),
      items.length,
      c.env,
      getExecutionCtx(c)
    );

    const batchId = crypto.randomUUID();

    // Items may name issues by UUID or KEY-N identifier — normalize to the
    // canonical UUID so dedup and queuedAfter edges can't diverge by form.
    const canonicalIssueIds = await Promise.all(
      items.map((item) => resolveIssueRef(stub, item.issueId))
    );
    const canonicalQueuedAfter = await Promise.all(
      items.map((item) =>
        item.queuedAfter === undefined
          ? Promise.resolve(undefined)
          : resolveIssueRef(stub, item.queuedAfter)
      )
    );

    // First occurrence wins — the one-active-session-per-issue guard would
    // race if two items dispatched the same issue concurrently.
    const firstIndexByIssueId = new Map<string, number>();
    items.forEach((_item, index) => {
      const key = canonicalIssueIds[index];
      if (!firstIndexByIssueId.has(key)) {
        firstIndexByIssueId.set(key, index);
      }
    });

    // Intra-batch dependency edges (queuedAfter naming a sibling issueId).
    // Chains that loop would deadlock the awaits below — flag them up front.
    const siblingDep = items.map((_item, index) => {
      const ref = canonicalQueuedAfter[index];
      if (ref === undefined) return undefined;
      const dep = firstIndexByIssueId.get(ref);
      return dep !== undefined && dep !== index ? dep : undefined;
    });
    const cyclic = new Set<number>();
    for (let i = 0; i < items.length; i += 1) {
      const seen = new Set<number>();
      for (
        let cur: number | undefined = i;
        cur !== undefined;
        cur = siblingDep[cur]
      ) {
        if (!seen.add(cur)) {
          cyclic.add(i);
          break;
        }
      }
    }

    const deferred = items.map(() => {
      let resolve!: (result: DispatchBatchItemResult) => void;
      const promise = new Promise<DispatchBatchItemResult>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    });

    const runItem = async (
      item: (typeof items)[number],
      index: number
    ): Promise<DispatchBatchItemResult> => {
      const issueId = item.issueId;
      const canonicalIssueId = canonicalIssueIds[index];
      const queuedAfter = canonicalQueuedAfter[index];
      try {
        if (firstIndexByIssueId.get(canonicalIssueId) !== index) {
          return dispatchBatchItemError(issueId, "Duplicate issueId in batch");
        }
        if (cyclic.has(index)) {
          return dispatchBatchItemError(
            issueId,
            "queuedAfter forms a dependency cycle in this batch"
          );
        }
        if (queuedAfter !== undefined && queuedAfter === canonicalIssueId) {
          return dispatchBatchItemError(
            issueId,
            "Cannot queue an item behind itself"
          );
        }

        let queueAfter: string | undefined;
        if (queuedAfter !== undefined) {
          const sibling = siblingDep[index];
          if (sibling !== undefined) {
            const upstream = await deferred[sibling].promise;
            if (!upstream.sessionId) {
              return dispatchBatchItemError(
                issueId,
                `queuedAfter target failed to dispatch: ${upstream.error}`
              );
            }
            queueAfter = upstream.sessionId;
          } else {
            // A session id, or the issueId of an issue with a live session.
            // Access-checked the same way as the target issue itself —
            // otherwise the error/success split is a liveness oracle for
            // restricted issues.
            const named = await stub.getAgentSession(queuedAfter);
            const target =
              named ??
              (await stub.getActiveAgentSessionForIssue(queuedAfter))?.session;
            let denied = false;
            if (target) {
              try {
                await assertSessionIssueAccess(db, stub, target, identity);
              } catch (err) {
                if (!(err instanceof VortexError)) throw err;
                denied = true;
              }
            }
            if (!target || denied) {
              return dispatchBatchItemError(
                issueId,
                `queuedAfter target not found: ${item.queuedAfter}`
              );
            }
            if (!["completed", "failed", "canceled"].includes(target.status)) {
              queueAfter = target.id;
            }
          }
        }

        const issue = await stub.getIssue(issueId);
        if (!issue) {
          return dispatchBatchItemError(issueId, "Issue not found");
        }
        let accessible = true;
        try {
          await assertIssueAccess(db, stub, issue, identity);
        } catch (err) {
          if (!(err instanceof VortexError)) throw err;
          accessible = false;
        }
        if (!accessible) {
          return dispatchBatchItemError(issueId, "Issue not found");
        }
        // Same guard as single dispatch: branch is the lane's working branch,
        // so "main"/"master" would fail at push time.
        if (item.branch === "main" || item.branch === "master") {
          return dispatchBatchItemError(
            issueId,
            `"${item.branch}" is a repo default branch — branch sets the lane's working branch (leave empty for issue-<id>)`
          );
        }
        // PILE-321 — repo-less issues inherit the team's defaultRepo, same
        // as single dispatch (batch items carry no repo override of their
        // own).
        const resolvedIssue = await inheritTeamDefaultRepo(
          db,
          stub,
          organizationId,
          issue,
          identity.id
        );
        const target: Issue = {
          ...resolvedIssue,
          branch:
            item.branch === undefined ? resolvedIssue.branch : item.branch,
        };

        // Explicit agentId wins; otherwise the repo's configured default
        // beats the global "devin" fallback — same as single dispatch.
        const repoDefault = target.repo
          ? (
              await db
                .select({
                  defaultAgentId: githubInstallations.defaultAgentId,
                })
                .from(githubInstallations)
                .where(
                  and(
                    eq(githubInstallations.organizationId, organizationId),
                    eq(githubInstallations.repo, target.repo)
                  )
                )
                .get()
            )?.defaultAgentId
          : undefined;
        const resolvedAgentId = item.agentId ?? repoDefault ?? "devin";

        // `.pile/config.json` agent allowlist applies to batch dispatches too.
        const pileConfig = target.repo
          ? await fetchPileRepoConfig(c.env, target.repo, target.branch)
          : null;
        if (
          pileConfig?.agents &&
          pileConfig.agents.length > 0 &&
          !pileConfig.agents.includes(resolvedAgentId)
        ) {
          return dispatchBatchItemError(
            issueId,
            `Agent "${resolvedAgentId}" is not allowed by .pile/config.json (allowed: ${pileConfig.agents.join(", ")})`
          );
        }

        const providerConfig = await loadProviderConfig(
          c.env,
          stub,
          resolvedAgentId
        );
        const effectiveEnv = resolveAgentEnv(
          c.env,
          providerConfig ?? undefined
        );
        const effort = resolveDispatchEffort(item.effort, target);
        const session = await dispatchAgent(
          effectiveEnv,
          resolvedAgentId,
          organizationId,
          target,
          identity,
          pileConfig?.effortModels?.[effort] ?? pileConfig?.model,
          getExecutionCtx(c),
          {
            instructions: item.instructions,
            stepKey: item.stepKey,
            envAllowlist: pileConfig?.env,
            queueAfter,
            secondaryRepos: item.secondaryRepos,
            effort,
            maxDurationMinutes: item.maxDuration,
            resultSchema: item.resultSchema
              ? resolveResultSchema(item.resultSchema)
              : undefined,
          }
        );

        if (target.repo && target.branch && session.status !== "waiting") {
          await createRepoBranch(
            db,
            organizationId,
            target.repo,
            target.branch,
            target.id
          );
        }
        await stub
          .addAgentActivity({
            sessionId: session.id,
            actorId: identity.id,
            type: "thought",
            message:
              session.status === "waiting"
                ? `Queued as part of batch ${batchId} behind session ${queueAfter}`
                : `Dispatched to ${resolvedAgentId} as part of batch ${batchId} (${items.length} items)`,
          })
          .catch(() => {});
        return {
          issueId,
          sessionId: session.id,
          status: session.status,
          error: null,
        };
      } catch (error) {
        return dispatchBatchItemError(
          issueId,
          error instanceof Error ? error.message : String(error)
        );
      }
    };

    const results = await Promise.all(
      items.map(async (item, index) => {
        let result: DispatchBatchItemResult;
        try {
          result = await runItem(item, index);
        } catch (error) {
          result = dispatchBatchItemError(
            item.issueId,
            error instanceof Error ? error.message : String(error)
          );
        }
        deferred[index].resolve(result);
        return result;
      })
    );

    return c.json({ batchId, results }, 200);
  });

  app.openapi(listSessionsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const viewer = await issueViewer(
      createD1(c.env.D1),
      c.get("workspaceIdentity")
    );
    if (isSummaryQuery(query.summary)) {
      const rows = await stub.listAgentSessionSummaries({
        issueId: query.issueId,
        limit: query.limit ? Number(query.limit) : undefined,
        viewer,
      });
      return c.json({ sessions: rows.map(toSessionSummary) }, 200);
    }
    const rows = await stub.listAgentSessions({
      issueId:
        query.issueId === undefined
          ? undefined
          : await resolveIssueRef(stub, query.issueId),
      limit: query.limit ? Number(query.limit) : undefined,
      viewer,
    });
    return c.json(
      {
        sessions: rows.map((row) => toSessionResponse(row, undefined)),
      },
      200
    );
  });

  app.openapi(agentStatsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const rows = await stub.listAgentSessions({
      viewer: await issueViewer(createD1(c.env.D1), c.get("workspaceIdentity")),
    });

    const TERMINAL = new Set(["completed", "failed", "canceled"]);
    const byStatus: Record<string, number> = {};
    const byAgent = new Map<
      string,
      { total: number; completed: number; failed: number; durations: number[] }
    >();
    let infraFailures = 0;
    const durations: number[] = [];

    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
      if (row.infraFailure) infraFailures += 1;
      const agg = byAgent.get(row.agentId) ?? {
        total: 0,
        completed: 0,
        failed: 0,
        durations: [],
      };
      agg.total += 1;
      if (row.status === "completed") agg.completed += 1;
      if (row.status === "failed") agg.failed += 1;
      if (TERMINAL.has(row.status)) {
        const ms = Date.parse(row.updatedAt) - Date.parse(row.createdAt);
        if (Number.isFinite(ms) && ms >= 0) {
          agg.durations.push(ms);
          durations.push(ms);
        }
      }
      byAgent.set(row.agentId, agg);
    }

    return c.json(
      {
        total: rows.length,
        byStatus,
        infraFailures,
        avgDurationSeconds: avgSeconds(durations),
        providers: [...byAgent.entries()].map(([agentId, a]) => ({
          agentId,
          total: a.total,
          completed: a.completed,
          failed: a.failed,
          successRate:
            a.completed + a.failed === 0
              ? null
              : Math.round((a.completed / (a.completed + a.failed)) * 100) /
                100,
          avgDurationSeconds: avgSeconds(a.durations),
        })),
      },
      200
    );
  });

  app.openapi(fleetHealthRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const rows = await stub.listAgentSessions({
      limit: 200,
      viewer: await issueViewer(createD1(c.env.D1), c.get("workspaceIdentity")),
    });

    const TERMINAL = new Set(["completed", "failed", "canceled"]);
    const UNHEALTHY_STREAK = 3;
    const now = Date.now();

    let live = 0;
    let missingEndedAt = 0;
    const kept = new Map<string, number>();
    const streaks = new Map<string, number>();
    const broken = new Set<string>();
    const keepsCache = new Map<string, boolean>();
    const keepsSandbox = (agentId: string): boolean => {
      const cached = keepsCache.get(agentId);
      if (cached !== undefined) return cached;
      const keeps = providerKeepsTerminalSandbox(agentId, c.env);
      keepsCache.set(agentId, keeps);
      return keeps;
    };

    for (const row of rows) {
      // rows arrive newest-first — a provider's streak is consecutive infra
      // deaths from the top (substrate failures AND sweep stall-cancels,
      // both infraFailure=1); any other session (running, completed, …)
      // ends it, matching the sweep's unhealthy check.
      if (!broken.has(row.agentId)) {
        if (row.infraFailure === 1 && TERMINAL.has(row.status)) {
          streaks.set(row.agentId, (streaks.get(row.agentId) ?? 0) + 1);
        } else {
          broken.add(row.agentId);
        }
      }
      if (!TERMINAL.has(row.status)) {
        live += 1;
        continue;
      }
      if (!row.endedAt) missingEndedAt += 1;
      // Same set the kept-sandbox cap enforces (PILE-253): providers that
      // park their sandbox after a terminal result, still inside the resume
      // window, and not yet reaped — reaped rows stop counting the moment
      // the sweep destroys the sandbox, not when they age out.
      if (sessionHoldsKeptSandbox(row, now) && keepsSandbox(row.agentId)) {
        kept.set(row.agentId, (kept.get(row.agentId) ?? 0) + 1);
      }
    }

    const agentIds = new Set([...kept.keys(), ...streaks.keys()]);
    return c.json(
      {
        live,
        missingEndedAt,
        providers: [...agentIds].map((agentId) => ({
          agentId,
          live: rows.filter(
            (r) => r.agentId === agentId && !TERMINAL.has(r.status)
          ).length,
          keptSandboxes: kept.get(agentId) ?? 0,
          infraStreak: streaks.get(agentId) ?? 0,
          unhealthy: (streaks.get(agentId) ?? 0) >= UNHEALTHY_STREAK,
        })),
      },
      200
    );
  });

  app.openapi(issueLiveRoute, async (c) => {
    const { organizationId, issueId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const issue = await stub.getIssue(issueId);
    // Sessions may reference issue refs with no issue row (synthetic
    // sessions, imported lanes) — keep the historical pass-through; only
    // real issues carry grants to check.
    if (issue) {
      await assertIssueAccess(
        createD1(c.env.D1),
        stub,
        issue,
        c.get("workspaceIdentity")
      );
    }
    const live = await stub.getActiveAgentSessionForIssue(issue?.id ?? issueId);
    return c.json({
      session: live ? toSessionResponse(live.session, live.activities) : null,
      activities: live?.activities.map(toActivityResponse) ?? [],
    });
  });

  app.openapi(getSessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const { summary } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    if (isSummaryQuery(summary)) {
      const row = await stub.getAgentSession(sessionId);
      if (!row) {
        return c.json({ message: "Session not found" }, 404);
      }
      return c.json(toSessionSummary(row), 200);
    }
    const session = await stub.getAgentSessionWithActivities(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    await assertSessionIssueAccess(
      createD1(c.env.D1),
      stub,
      session,
      c.var.workspaceIdentity
    );
    // PILE-425 — the run's usage/cost receipt rides the detail response.
    const receipt = await stub.getRunReceipt(sessionId).catch(() => undefined);
    return c.json(
      {
        ...toSessionResponse(session, session.activities),
        receipt: receipt ? toReceiptResponse(receipt) : null,
      },
      200
    );
  });

  app.openapi(getSessionEventsRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    await assertSessionIssueAccess(
      createD1(c.env.D1),
      stub,
      session,
      c.var.workspaceIdentity
    );
    // One stream: activity spans + lifecycle events merged chronologically.
    const timeline = await stub.listAgentTimeline(sessionId, {
      limit: limit ? Number(limit) : undefined,
    });
    return c.json({
      events: timeline.map((row) =>
        row.kind === "activity"
          ? { kind: row.kind, ...toActivityResponse(row) }
          : {
              kind: row.kind,
              id: row.id,
              sessionId: row.sessionId,
              type: row.type,
              message: row.message,
              payload: row.payload ? JSON.parse(row.payload) : null,
              createdAt: row.createdAt,
            }
      ),
    });
  });

  // Lane-facing CI detail (PILE-232): a lane whose PR went red can read
  // back exactly which check-runs failed and where their logs live — the
  // same answer a human gets from the PR checks box. Reachable with a
  // workspace token or the session's lane token (auth bypass validates it).
  app.openapi(getSessionChecksRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    await assertSessionIssueAccess(
      createD1(c.env.D1),
      stub,
      session,
      c.var.workspaceIdentity
    );
    if (!session.prUrl) {
      return c.json({ checks: [], prCheckState: null });
    }
    const parsed = parsePrUrl(session.prUrl);
    if (!parsed) {
      return c.json({ message: "Session prUrl is not a GitHub PR" }, 400);
    }
    const token = await getInstallationTokenForRepo(
      c.env,
      parsed.owner,
      parsed.name
    );
    if (!token) {
      return c.json({ message: "GitHub installation not found" }, 502);
    }
    const pr = await fetchGitHubPull(
      token,
      parsed.owner,
      parsed.name,
      parsed.number
    );
    if (!pr) {
      return c.json({ message: "GitHub pull request lookup failed" }, 502);
    }
    const runs = await fetchGitHubCheckRuns(
      token,
      parsed.owner,
      parsed.name,
      pr.head.sha
    );
    const issue = await stub.getIssue(session.issueId);
    return c.json({
      checks: runs.map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        detailsUrl: run.details_url ?? null,
        htmlUrl: run.html_url ?? null,
      })),
      prCheckState: issue?.prCheckState ?? null,
    });
  });

  app.openapi(addActivityRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    await assertSessionIssueAccess(
      createD1(c.env.D1),
      stub,
      session,
      c.var.workspaceIdentity
    );
    // PILE-420 — a stopped (terminal) session accepts no further activities.
    if (
      session.status === "completed" ||
      session.status === "failed" ||
      session.status === "canceled"
    ) {
      return c.json({ message: "Session is terminal" }, 409);
    }

    const activity = await stub.addAgentActivity({
      sessionId,
      actorId: identity.id,
      type: body.type,
      message: body.message,
      payload: body.payload,
      parentId: body.parentId,
      startedAt: body.startedAt,
      endedAt: body.endedAt,
      durationMs: body.durationMs,
    });
    return c.json(toActivityResponse(activity), 201);
  });

  app.openapi(createArtifactRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    await assertSessionIssueAccess(
      createD1(c.env.D1),
      stub,
      session,
      c.var.workspaceIdentity
    );

    const activity = await stub.addAgentSessionArtifact({
      sessionId,
      actorId: identity.id,
      name: body.name,
      type: body.type,
      content: body.content,
      data: body.data,
      mimeType: body.mimeType,
      url: body.url,
    });
    return c.json(toActivityResponse(activity), 201);
  });

  app.openapi(patchSessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    await assertSessionIssueAccess(
      createD1(c.env.D1),
      stub,
      session,
      c.var.workspaceIdentity
    );

    // Plan lands before the result write so a status transition in the same
    // patch sees (and renders) the final checklist.
    if (body.plan !== undefined) {
      await stub.setAgentSessionPlan(sessionId, body.plan);
    }

    const updated = await stub.applyAgentSessionResult(
      sessionId,
      {
        status: (body.status ?? session.status) as AgentSessionStatus,
        result: body.result,
        url: body.url,
        prUrl: body.prUrl,
        prState: body.prState,
        branch: body.branch,
      },
      identity.id
    );

    const activities = await stub.listAgentActivities(sessionId);
    return c.json(toSessionResponse(updated ?? session, activities));
  });

  // Log ingest for runners: per-session HMAC token auth (middleware bypass
  // in index.ts). Appended lines become session events and fan out over the
  // SSE stream above — push-based, no sandbox file polling needed.
  app.post(
    "/workspaces/:organizationId/agent/sessions/:sessionId/logs",
    async (c) => {
      const { organizationId, sessionId } = c.req.param();
      const expected = await agentLogToken(c.env, organizationId, sessionId);
      const provided = (c.req.header("authorization") ?? "").replace(
        /^Bearer\s+/i,
        ""
      );
      if (!expected || !provided || !timingSafeEqualHex(provided, expected)) {
        return c.json({ message: "Unauthorized" }, 401);
      }

      const stub = getWorkspaceStub(c.env, organizationId);
      const session = await stub.getAgentSession(sessionId);
      if (!session) {
        return c.json({ message: "Session not found" }, 404);
      }
      if (["completed", "failed", "canceled"].includes(session.status)) {
        return c.json({ message: "Session is terminal" }, 409);
      }

      const body: unknown = await c.req.json().catch(() => null);
      const lines =
        body !== null &&
        typeof body === "object" &&
        Array.isArray((body as Record<string, unknown>).lines)
          ? ((body as Record<string, unknown>).lines as unknown[]).filter(
              (l): l is string => typeof l === "string"
            )
          : [];
      const capped = lines.slice(-100);
      // Every ingested line is a heartbeat — keeps the liveness sweep from
      // treating a chatty live lane (or external session) as stalled.
      await stub
        .updateAgentSession(sessionId, {
          lastProgressAt: new Date().toISOString(),
        })
        .catch(() => {});
      await Promise.all(
        capped.map((line) =>
          stub.addAgentSessionEvent({
            sessionId,
            type: "log",
            message: scrubLaneText(line, [expected]).slice(0, 2000),
          })
        )
      );
      return c.json({ ok: true, appended: capped.length });
    }
  );

  // Self-report for externally-registered sessions (PILE-227): the agent
  // pushes its own lifecycle — status, result, PR, branch — with the same
  // per-session HMAC bearer as log ingest. Pile owns no compute here; this
  // is pure observability.
  app.post(
    "/workspaces/:organizationId/agent/sessions/:sessionId/report",
    async (c) => {
      const { organizationId, sessionId } = c.req.param();
      if (
        !(await verifySessionToken(
          c.env,
          c.req.header("authorization"),
          organizationId,
          sessionId
        ))
      ) {
        return c.json({ message: "Unauthorized" }, 401);
      }
      const stub = getWorkspaceStub(c.env, organizationId);
      const session = await stub.getAgentSession(sessionId);
      if (!session) {
        return c.json({ message: "Session not found" }, 404);
      }
      // A lane token can't reopen a terminal session — once a session
      // resolves, reporting stops.
      if (["completed", "failed", "canceled"].includes(session.status)) {
        return c.json({ message: "Session is terminal" }, 409);
      }
      const body: unknown = await c.req.json().catch(() => null);
      if (body === null || typeof body !== "object") {
        return c.json({ message: "Invalid body" }, 400);
      }
      const input = body as Record<string, unknown>;
      const update: {
        status?: AgentSessionStatus;
        result?: string;
        url?: string;
        prUrl?: string;
        branch?: string;
        lastProgressAt?: string;
      } = { lastProgressAt: new Date().toISOString() };
      for (const key of ["result", "url", "prUrl", "branch"] as const) {
        const value = input[key];
        if (typeof value === "string") update[key] = value;
      }
      if (update.result !== undefined) {
        update.result = scrubLaneText(update.result, [
          c.req.header("authorization")?.replace(/^Bearer\s+/i, ""),
        ]);
      }
      if (update.prUrl !== undefined) {
        const issue = await stub.getIssue(session.issueId);
        if (issue?.repo && !prUrlOnRepo(update.prUrl, issue.repo)) {
          return c.json(
            { message: "prUrl is not a pull request on the session repo" },
            400
          );
        }
      }
      if (typeof input.status === "string") {
        const allowed = new Set<string>([
          "created",
          "running",
          "waiting",
          "completed",
          "failed",
          "canceled",
        ]);
        if (!allowed.has(input.status)) {
          return c.json({ message: "Invalid status" }, 400);
        }
        update.status = input.status as AgentSessionStatus;
      }
      // PILE-290 — `step` / `todos` drive the lane's live progress comment
      // on the issue; they land as an `action` activity.
      const step = typeof input.step === "string" ? input.step : undefined;
      let todos: LaneTodo[] | undefined;
      if (input.todos !== undefined) {
        const parsed = laneTodosSchema.safeParse(input.todos);
        if (!parsed.success) {
          return c.json({ message: "Invalid todos" }, 400);
        }
        todos = parsed.data;
      }
      if (step?.trim() || todos) {
        await stub.addAgentActivity({
          sessionId,
          type: "action",
          message: laneReportStepMessage(step, todos).slice(0, 2000),
          payload: todos ? { todos } : undefined,
        });
      }
      // PILE-426 — `plan` publishes/replaces the session checklist; it lands
      // before any status transition so a terminal report carries the final
      // plan state into the frozen progress comment.
      if (input.plan !== undefined) {
        const parsed = sessionPlanSchema.safeParse(input.plan);
        if (!parsed.success) {
          return c.json({ message: "Invalid plan" }, 400);
        }
        await stub.setAgentSessionPlan(sessionId, parsed.data);
      }
      // PILE-425 — cumulative usage snapshot → the session's run receipt.
      // Recorded before the status transition so a terminal report lands
      // usage on the finalized receipt.
      if (input.usage !== undefined) {
        const parsed = runUsageSchema.safeParse(input.usage);
        if (!parsed.success) {
          return c.json({ message: "Invalid usage" }, 400);
        }
        await stub.recordSessionUsage(sessionId, parsed.data);
      }
      if (update.status !== undefined) {
        if (
          ["completed", "failed", "canceled"].includes(update.status) ||
          update.status === "running"
        ) {
          await stub.applyAgentSessionResult(sessionId, {
            status: update.status,
            // Fields not present in this report keep the session's current
            // values — a bare {status:"completed"} must not wipe a prUrl
            // reported earlier.
            result: update.result ?? null,
            url: update.url ?? session.url ?? null,
            prUrl: update.prUrl ?? session.prUrl ?? null,
            branch: update.branch ?? session.branch ?? null,
          });
          await stub.updateAgentSession(sessionId, {
            lastProgressAt: update.lastProgressAt,
          });
          // PILE-223 — an escalated ticket gets the external agent's
          // result posted back to the customer thread.
          if (update.status === "completed" || update.status === "failed") {
            await replyLaneResultToTicket(
              c.env,
              createD1(c.env.D1),
              organizationId,
              session.issueId,
              sessionId,
              update.result ?? session.result
            );
          }
          const updated = await stub.getAgentSession(sessionId);
          return c.json({ session: updated });
        }
      }
      await stub.updateAgentSession(sessionId, update);
      const updated = await stub.getAgentSession(sessionId);
      return c.json({ session: updated });
    }
  );

  // Fresh GitHub installation token for live lanes — the token baked at
  // dispatch expires ~1h in, so the runner re-mints through here right before
  // push. Same per-session HMAC bearer auth as log ingest; returns a token
  // for the session issue's repo, or one of its secondary repos.
  app.post(
    "/workspaces/:organizationId/agent/sessions/:sessionId/github-token",
    async (c) => {
      const { organizationId, sessionId } = c.req.param();
      if (
        !(await verifySessionToken(
          c.env,
          c.req.header("authorization"),
          organizationId,
          sessionId
        ))
      ) {
        return c.json({ message: "Unauthorized" }, 401);
      }
      const stub = getWorkspaceStub(c.env, organizationId);
      const session = await stub.getAgentSession(sessionId);
      if (!session) {
        return c.json({ message: "Session not found" }, 404);
      }
      if (["completed", "failed", "canceled"].includes(session.status)) {
        return c.json({ message: "Session is terminal" }, 409);
      }
      const issue = await stub.getIssue(session.issueId);
      if (!issue?.repo) {
        return c.json({ message: "Session issue has no repository" }, 422);
      }
      // PILE-294 — `?repo=` naming one of the session's secondary repos mints
      // for that repo; anything outside the session's repo set is refused.
      const requested = c.req.query("repo")?.toLowerCase();
      // `?repo=` naming a declared secondary mints for that repo. Any other
      // value — including case-drifting matches to the session repo — falls
      // back to the session's own repo rather than 403ing, so a token refresh
      // can never brick a live lane over naming drift. Either way the minted
      // token is scoped only to repos the session already owns.
      const secondaryRepo = requested
        ? parseStoredSecondaryRepos(session.secondaryRepos).find(
            (entry) => entry.repo.toLowerCase() === requested
          )?.repo
        : undefined;
      const secondary = !!secondaryRepo;
      const targetRepo = secondaryRepo ?? issue.repo;
      // Re-resolve the lane's push tier on every mint so the refreshed token
      // is never broader than the policy (push=disabled → contents:read).
      const { permissions } = await fetchLanePermissions(
        c.env,
        issue.repo,
        session.agentId
      );
      const minted = await mintLaneGithubToken(
        c.env,
        organizationId,
        sessionId,
        targetRepo,
        { secondary, permissions: laneTokenPermissions(permissions.push) }
      );
      if (!minted) {
        return c.json({ message: "No installation token for repository" }, 502);
      }
      return c.json({ token: minted.token, expiresAt: minted.expiresAt });
    }
  );

  app.get(
    "/workspaces/:organizationId/agent/sessions/:sessionId/cache/pnpm-store/:hash",
    async (c) => {
      const { organizationId, sessionId, hash } = c.req.param();
      if (!/^[a-f0-9]{64}$/.test(hash)) {
        return c.json({ message: "Invalid hash" }, 400);
      }
      if (
        !(await verifySessionToken(
          c.env,
          c.req.header("authorization"),
          organizationId,
          sessionId
        ))
      ) {
        return c.json({ message: "Unauthorized" }, 401);
      }
      // Multipart store: manifest lists ordered parts; parts are concatenated
      // on the way out. Falls back to a single-shot object for small stores.
      const bucket = c.env.ATTACHMENTS_BUCKET;
      if (!bucket) return c.json({ message: "Cache storage unavailable" }, 503);
      const manifest = await bucket.get(
        `${pnpmStoreKey(organizationId, hash)}.manifest.json`
      );
      if (manifest) {
        const meta = (await manifest.json()) as { parts?: number };
        const parts = meta.parts ?? 0;
        const stream = new ReadableStream<Uint8Array>({
          start: async (controller) => {
            for (let i = 0; i < parts; i++) {
              const part = await bucket.get(
                `${pnpmStoreKey(organizationId, hash)}.part${i}`
              );
              if (part)
                controller.enqueue(new Uint8Array(await part.arrayBuffer()));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "application/gzip" },
        });
      }
      const obj = await bucket.get(pnpmStoreKey(organizationId, hash));
      if (!obj) return c.json({ message: "Not found" }, 404);
      return new Response(obj.body, {
        headers: { "content-type": "application/gzip" },
      });
    }
  );

  app.put(
    "/workspaces/:organizationId/agent/sessions/:sessionId/cache/pnpm-store/:hash",
    async (c) => {
      const { organizationId, sessionId, hash } = c.req.param();
      if (!/^[a-f0-9]{64}$/.test(hash)) {
        return c.json({ message: "Invalid hash" }, 400);
      }
      if (
        !(await verifySessionToken(
          c.env,
          c.req.header("authorization"),
          organizationId,
          sessionId
        ))
      ) {
        return c.json({ message: "Unauthorized" }, 401);
      }
      return putStoreObject(
        c.env,
        c.req.raw,
        pnpmStoreKey(organizationId, hash)
      );
    }
  );

  app.put(
    "/workspaces/:organizationId/agent/sessions/:sessionId/cache/pnpm-store/:hash/parts/:index",
    async (c) => {
      const { organizationId, sessionId, hash, index } = c.req.param();
      if (!/^[a-f0-9]{64}$/.test(hash) || !/^\d{1,3}$/.test(index)) {
        return c.json({ message: "Invalid key" }, 400);
      }
      if (
        !(await verifySessionToken(
          c.env,
          c.req.header("authorization"),
          organizationId,
          sessionId
        ))
      ) {
        return c.json({ message: "Unauthorized" }, 401);
      }
      return putStoreObject(
        c.env,
        c.req.raw,
        `${pnpmStoreKey(organizationId, hash)}.part${Number(index)}`
      );
    }
  );

  app.put(
    "/workspaces/:organizationId/agent/sessions/:sessionId/cache/pnpm-store/:hash/manifest",
    async (c) => {
      const { organizationId, sessionId, hash } = c.req.param();
      if (!/^[a-f0-9]{64}$/.test(hash)) {
        return c.json({ message: "Invalid hash" }, 400);
      }
      if (
        !(await verifySessionToken(
          c.env,
          c.req.header("authorization"),
          organizationId,
          sessionId
        ))
      ) {
        return c.json({ message: "Unauthorized" }, 401);
      }
      const body: unknown = await c.req.json().catch(() => null);
      const parts =
        body !== null &&
        typeof body === "object" &&
        typeof (body as Record<string, unknown>).parts === "number"
          ? (body as { parts: number }).parts
          : null;
      if (!parts || parts < 1 || parts > 100) {
        return c.json({ message: "Invalid manifest" }, 400);
      }
      const manifestBucket = c.env.ATTACHMENTS_BUCKET;
      if (!manifestBucket) {
        return c.json({ message: "Cache storage unavailable" }, 503);
      }
      await manifestBucket.put(
        `${pnpmStoreKey(organizationId, hash)}.manifest.json`,
        JSON.stringify({ parts }),
        { httpMetadata: { contentType: "application/json" } }
      );
      return c.json({ ok: true });
    }
  );

  // Server-sent event stream of agent session deltas. Supports Last-Event-ID
  // for reconnect/replay and emits one event per changed field/activity.
  app.get(
    "/workspaces/:organizationId/agent/sessions/:sessionId/stream",
    async (c) => {
      const organizationId = c.req.param("organizationId");
      const sessionId = c.req.param("sessionId");
      const stub = getWorkspaceStub(c.env, organizationId);

      const session = await stub.getAgentSession(sessionId);
      if (!session) {
        return c.json({ message: "Session not found" }, 404);
      }

      const lastEventIdRaw =
        c.req.header("Last-Event-ID") ?? c.req.query("lastEventId");
      let afterId = 0;
      if (lastEventIdRaw === undefined) {
        const latest = await stub.listAgentSessionEvents(sessionId, {
          limit: 1,
        });
        afterId = latest[0]?.id ?? 0;
      } else {
        afterId = Number(lastEventIdRaw);
        if (Number.isNaN(afterId)) afterId = 0;
      }

      const encoder = new TextEncoder();
      let lastEmittedId = afterId;
      const terminal = new Set(["completed", "failed", "canceled"]);
      let closed = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let streamController:
        | ReadableStreamDefaultController<Uint8Array>
        | undefined;

      const safeClose = () => {
        if (!closed) {
          closed = true;
          if (timeoutId) clearTimeout(timeoutId);
          try {
            streamController?.close();
          } catch {
            /* already closed */
          }
        }
      };

      const sendEvent = (event: {
        id: number;
        type: string;
        message: string;
        payload: unknown;
        createdAt: string;
      }) => {
        if (closed) return;
        const lines = [
          `id: ${event.id}`,
          `event: ${event.type}`,
          `data: ${JSON.stringify(event)}`,
          "",
        ].join("\n");
        streamController?.enqueue(encoder.encode(lines));
      };

      const tick = async () => {
        if (closed) return;
        const current = await stub.getAgentSession(sessionId).catch(() => null);
        if (!current) {
          safeClose();
          return;
        }

        const events = await stub
          .listAgentSessionEvents(sessionId, {
            afterId: lastEmittedId,
            limit: 100,
          })
          .catch(() => []);

        for (const row of events) {
          const payload = row.payload ? JSON.parse(row.payload) : null;
          sendEvent({
            id: row.id,
            type: row.type,
            message: row.message,
            payload,
            createdAt: row.createdAt,
          });
          lastEmittedId = row.id;
        }

        if (terminal.has(current.status)) {
          safeClose();
          return;
        }

        timeoutId = setTimeout(tick, 1_000);
      };

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          tick().catch(() => safeClose());
        },
        cancel() {
          closed = true;
          if (timeoutId) clearTimeout(timeoutId);
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }
  );

  app.openapi(cancelSessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    await assertSessionIssueAccess(
      createD1(c.env.D1),
      stub,
      session,
      c.var.workspaceIdentity
    );
    const terminal =
      session.status === "completed" ||
      session.status === "failed" ||
      session.status === "canceled";

    const providerConfig = await loadProviderConfig(
      c.env,
      stub,
      session.agentId
    );
    const effectiveEnv = resolveAgentEnv(c.env, providerConfig ?? undefined);
    const provider = getAgentProvider(session.agentId, effectiveEnv);
    if (provider.cancel) {
      const remote = session.providerSessionId ?? sessionId;
      await provider
        .cancel(remote)
        .catch((err) => console.error("provider cancel failed", err));
    }

    // Terminal sessions keep their status — this call only cleans up any
    // kept sandbox the lane left behind.
    if (terminal) {
      const activities = await stub.listAgentActivities(sessionId);
      return c.json(toSessionResponse(session, activities));
    }

    const updated = await stub.applyAgentSessionResult(
      sessionId,
      { status: "canceled" },
      identity.id
    );
    const activities = await stub.listAgentActivities(sessionId);
    return c.json(toSessionResponse(updated ?? session, activities));
  });

  // PILE-420 — the human Stop action: `session.stopped` on the event stream
  // first (a wedged provider call must not lose it), provider cancel kills
  // in-flight runtime work, then the row lands terminal — `canceled` with
  // the stopped reason — and the action is audit-logged with actor+reason.
  app.openapi(stopSessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    await assertSessionIssueAccess(
      createD1(c.env.D1),
      stub,
      session,
      c.var.workspaceIdentity
    );
    const terminal =
      session.status === "completed" ||
      session.status === "failed" ||
      session.status === "canceled";
    if (terminal) {
      const activities = await stub.listAgentActivities(sessionId);
      return c.json(toSessionResponse(session, activities));
    }

    await stub
      .addAgentSessionEvent({
        sessionId,
        type: "session.stopped",
        message: reason ? `Session stopped: ${reason}` : "Session stopped",
        payload: {
          actorId: identity.id,
          actorType: identity.type,
          reason: reason ?? null,
        },
      })
      .catch(() => {});

    // Cancel in-flight runtime work — the provider's cancel tears down the
    // remote session/sandbox within seconds. Externally-registered sessions
    // have no provider to reach: the terminal write is still the record.
    try {
      const providerConfig = await loadProviderConfig(
        c.env,
        stub,
        session.agentId
      );
      const provider = getAgentProvider(
        session.agentId,
        resolveAgentEnv(c.env, providerConfig ?? undefined)
      );
      if (provider.cancel) {
        await provider.cancel(session.providerSessionId ?? sessionId);
      }
    } catch (err) {
      console.error("stop provider cancel failed", {
        session: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const stoppedResult = `Stopped by ${identity.id}${reason ? `: ${reason}` : ""}`;
    const updated = await stub.applyAgentSessionResult(
      sessionId,
      { status: "canceled", result: stoppedResult },
      identity.id
    );
    await stub.recordAudit(
      "agent_session.stopped",
      "agent_session",
      sessionId,
      identity.id,
      null,
      { actorType: identity.type }
    );
    const activities = await stub.listAgentActivities(sessionId);
    return c.json(toSessionResponse(updated ?? session, activities));
  });

  app.openapi(listAgentPausesRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json({ pauses: await stub.listAgentPauses() }, 200);
  });

  app.openapi(pauseAgentTypeRoute, async (c) => {
    const { organizationId, agentId } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const pause = await stub.pauseAgentType(agentId, {
      reason: reason ?? null,
      actorId: identity.id,
      actorType: identity.type,
    });
    return c.json(pause, 200);
  });

  // Resume drains held sessions oldest-first. The drain runs even when the
  // pause row is already gone — a hold can outlive a row deleted out-of-
  // band, and releasing is the only way those lanes move.
  app.openapi(resumeAgentTypeRoute, async (c) => {
    const { organizationId, agentId } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const wasPaused = await stub.resumeAgentType(agentId, {
      actorId: identity.id,
      actorType: identity.type,
    });
    const released = await releasePausedSessions(
      c.env,
      stub,
      organizationId,
      agentId,
      getExecutionCtx(c)
    );
    if (!wasPaused && released.length === 0) {
      return c.json({ message: "Agent type is not paused" }, 404);
    }
    return c.json({ ok: true, released }, 200);
  });

  app.openapi(listSpendCapsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    return c.json({ caps: await stub.listAgentSpendCaps() }, 200);
  });

  app.openapi(upsertSpendCapRoute, async (c) => {
    const { organizationId, agentId } = c.req.valid("param");
    const input = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const caps = await stub.upsertAgentSpendCap(agentId, input, {
      id: identity.id,
      type: identity.type,
    });
    return c.json(caps, 200);
  });

  app.openapi(deleteSpendCapRoute, async (c) => {
    const { organizationId, agentId } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const deleted = await stub.deleteAgentSpendCap(agentId, {
      id: identity.id,
      type: identity.type,
    });
    if (!deleted) {
      return c.json({ message: "No caps configured for this agent type" }, 404);
    }
    return c.json({ ok: true }, 200);
  });

  app.openapi(listRunReceiptsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const query = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const receipts = await stub.listRunReceipts({
      sessionId: query.sessionId,
      agentId: query.agentId,
      issueId: query.issueId,
      stepKey: query.stepKey,
      dealId: query.dealId,
      since: query.since,
      until: query.until,
      limit: query.limit ? Number(query.limit) : undefined,
    });
    return c.json({ receipts: receipts.map(toReceiptResponse) }, 200);
  });

  app.openapi(summarizeRunReceiptsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const { groupBy, ...query } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const summary = await stub.summarizeRunReceipts({
      groupBy,
      sessionId: query.sessionId,
      agentId: query.agentId,
      issueId: query.issueId,
      stepKey: query.stepKey,
      dealId: query.dealId,
      since: query.since,
      until: query.until,
      limit: query.limit ? Number(query.limit) : undefined,
    });
    return c.json({ summary }, 200);
  });

  app.openapi(pollSessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    await assertSessionIssueAccess(
      createD1(c.env.D1),
      stub,
      session,
      c.var.workspaceIdentity
    );

    const providerConfig = await loadProviderConfig(
      c.env,
      stub,
      session.agentId
    );
    const effectiveEnv = resolveAgentEnv(c.env, providerConfig ?? undefined);
    const provider = getAgentProvider(session.agentId, effectiveEnv);
    const polled = await provider.poll(session.providerSessionId ?? sessionId);

    const updated = await stub.applyAgentSessionResult(
      sessionId,
      {
        status: polled.status,
        result: polled.result,
        url: polled.url,
        providerSessionId: polled.id,
        prUrl: polled.prUrl,
        prState: polled.prState,
        branch: polled.branch,
      },
      identity.id
    );

    await captureSessionPrArtifact(stub, sessionId, identity.id, polled.prUrl);

    const activities = await stub.listAgentActivities(sessionId);
    return c.json(toSessionResponse(updated ?? session, activities));
  });

  app.openapi(getSessionStateRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    await assertSessionIssueAccess(
      createD1(c.env.D1),
      stub,
      session,
      c.var.workspaceIdentity
    );

    const providerConfig = await loadProviderConfig(
      c.env,
      stub,
      session.agentId
    );
    const effectiveEnv = resolveAgentEnv(c.env, providerConfig ?? undefined);
    const provider = getAgentProvider(session.agentId, effectiveEnv);

    if (!provider.getState) {
      return c.json(
        { message: "Live state not supported for this agent" },
        400
      );
    }

    const remoteId = session.providerSessionId ?? sessionId;
    const state = await provider.getState(remoteId, sessionId);
    if (!state) {
      return c.json(
        { message: "Provider or compute not configured for this agent" },
        400
      );
    }

    const activities = await stub.listAgentActivities(sessionId);
    return c.json({
      session: toSessionResponse(session, activities),
      provider: state.provider ?? null,
      compute: state.compute ?? null,
    });
  });

  app.openapi(createChildSessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    await assertSessionIssueAccess(
      createD1(c.env.D1),
      stub,
      session,
      c.var.workspaceIdentity
    );

    const parentIssue = await stub.getIssue(session.issueId);
    if (!parentIssue) {
      return c.json({ message: "Parent issue not found" }, 404);
    }
    if (!parentIssue.repo) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Parent issue has no repository",
      });
    }

    const active = await stub.countActiveChildSessions(parentIssue.id);
    const max = await stub.getMaxConcurrentAgentChildren();
    if (active >= max) {
      throw new VortexError({
        code: "TOO_MANY_REQUESTS",
        status: 429,
        message: `Maximum concurrent child sessions (${max}) reached`,
      });
    }

    // PILE-211 spawn guardrails: bound chain depth and total live descendants
    // of the whole spawn tree, not just direct children.
    const spawnLimits = await stub.getAgentSpawnLimits();
    const nextDepth = session.spawnDepth + 1;
    if (nextDepth > spawnLimits.maxSpawnDepth) {
      throw new VortexError({
        code: "TOO_MANY_REQUESTS",
        status: 429,
        message: `Maximum spawn depth (${spawnLimits.maxSpawnDepth}) reached`,
      });
    }
    // Root of the tree = walk up parentSessionId until null (depth ≤
    // maxSpawnDepth, so this is at most a couple of lookups).
    let rootId = session.id;
    let cursor: typeof session | null | undefined = session;
    while (cursor?.parentSessionId) {
      cursor = await stub.getAgentSession(cursor.parentSessionId);
      if (!cursor) break;
      rootId = cursor.id;
    }
    const descendants = await stub.countActiveDescendantSessions(rootId);
    if (descendants >= spawnLimits.maxActiveDescendants) {
      throw new VortexError({
        code: "TOO_MANY_REQUESTS",
        status: 429,
        message: `Maximum active descendant sessions (${spawnLimits.maxActiveDescendants}) reached`,
      });
    }

    const child = await stub.createIssue(
      {
        title: body.title,
        description: body.description,
        parentId: parentIssue.id,
        teamId: parentIssue.teamId,
        repo: body.repo ?? parentIssue.repo,
        priority: parentIssue.priority,
        status: "backlog",
      },
      identity.id
    );

    const resolvedAgentId = body.agentId ?? "devin";
    const providerConfig = await loadProviderConfig(
      c.env,
      stub,
      resolvedAgentId
    );
    const effectiveEnv = resolveAgentEnv(c.env, providerConfig ?? undefined);

    const childSession = await dispatchAgent(
      effectiveEnv,
      resolvedAgentId,
      organizationId,
      child,
      identity,
      body.model,
      getExecutionCtx(c),
      {
        parentSessionId: session.id,
        spawnDepth: nextDepth,
        effort: body.effort,
        maxDurationMinutes: body.maxDuration,
        stepKey: body.stepKey ?? session.stepKey ?? undefined,
      }
    );

    const childAfter = await stub.getIssue(child.id);
    if (childAfter?.repo && childAfter?.branch) {
      await createRepoBranch(
        db,
        organizationId,
        childAfter.repo,
        childAfter.branch,
        childAfter.id
      );
    }

    return c.json(
      { session: toSessionResponse(childSession), issue: childAfter ?? child },
      201
    );
  });

  app.openapi(promptSessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const { prompt } = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    await assertSessionIssueAccess(
      createD1(c.env.D1),
      stub,
      session,
      c.var.workspaceIdentity
    );
    const issue = await stub.getIssue(session.issueId);
    if (!issue) {
      return c.json({ message: "Issue not found" }, 404);
    }

    // Externally-managed sessions (a local coding agent registered itself
    // via /sessions/register; no providerSessionId, no kept sandbox) can't
    // receive a live sendPrompt — the reply is queued as a readable event
    // and the agent picks it up by polling /events or the SSE stream.
    const externallyManaged = session.providerSessionId === null;
    // PILE-419 — the human→agent direction is a first-class activity too
    // (Linear's `prompt` type): the ask is auditable, not just the answers.
    const recordPromptActivity = () =>
      stub
        .addAgentActivity({
          sessionId,
          actorId: identity.id,
          type: "prompt",
          message: prompt.slice(0, 2000),
        })
        .catch(() => null);
    if (externallyManaged) {
      await stub.addAgentSessionEvent({
        sessionId,
        type: "prompt.followup",
        message: `Follow-up prompt queued (${prompt.length} chars)`,
        payload: { prompt: prompt.slice(0, 2000), delivery: "queued" },
      });
      await recordPromptActivity();
      const queued = await stub.applyAgentSessionResult(
        sessionId,
        { status: "running", result: null },
        identity.id
      );
      const queuedActivities = await stub.listAgentActivities(sessionId);
      return c.json(
        toSessionResponse(queued ?? session, queuedActivities),
        200
      );
    }

    const providerConfig = await loadProviderConfig(
      c.env,
      stub,
      session.agentId
    );
    const effectiveEnv = resolveAgentEnv(c.env, providerConfig ?? undefined);
    const provider = getAgentProvider(session.agentId, effectiveEnv);

    // Live follow-up needs both provider support and a kept sandbox — else
    // the caller should hit /retry for a cold dispatch with context.
    const gitIdentity = issue.repo
      ? ((await stub.getGitIdentityByRepo(issue.repo)) ??
        (await stub.getGitIdentityByRepo(DEFAULT_GIT_IDENTITY_REPO)) ??
        null)
      : null;
    const delivered = provider.sendPrompt
      ? await provider.sendPrompt(
          session.providerSessionId ?? sessionId,
          prompt,
          issue,
          gitIdentity,
          {
            organizationId,
            backupRef: session.sandboxBackupRef ?? null,
          }
        )
      : false;
    if (!delivered) {
      return c.json(
        {
          message:
            "Session sandbox is gone or busy — retry for a cold dispatch with context",
        },
        409
      );
    }

    await stub
      .addAgentSessionEvent({
        sessionId,
        type: "prompt.followup",
        message: `Follow-up prompt delivered (${prompt.length} chars)`,
        payload: { prompt: prompt.slice(0, 2000) },
      })
      .catch(() => {});
    await recordPromptActivity();
    const updated = await stub.applyAgentSessionResult(
      sessionId,
      { status: "running", result: null },
      identity.id
    );
    const activities = await stub.listAgentActivities(sessionId);
    return c.json(toSessionResponse(updated ?? session, activities), 200);
  });

  // PILE-419 — the human's answer to an open elicitation resumes the
  // session. Provider lanes get the answer pushed into their live sandbox
  // via sendPrompt (a dead/busy sandbox 409s without closing the question —
  // cold-dispatch through /retry instead). Externally-managed lanes pick the
  // answer up off the event stream (`elicitation.response`); a lane still
  // queue-parked behind a blocker stays `waiting` with the marker cleared.
  app.openapi(respondSessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const { answer } = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    await assertSessionIssueAccess(
      createD1(c.env.D1),
      stub,
      session,
      c.var.workspaceIdentity
    );
    if (!session.awaitingActivityId) {
      return c.json({ message: "Session is not awaiting input" }, 409);
    }
    const issue = await stub.getIssue(session.issueId);
    if (!issue) {
      return c.json({ message: "Issue not found" }, 404);
    }

    let delivery: "sent" | "queued" = "queued";
    if (session.providerSessionId !== null && !session.queuedAfter) {
      const providerConfig = await loadProviderConfig(
        c.env,
        stub,
        session.agentId
      );
      const effectiveEnv = resolveAgentEnv(c.env, providerConfig ?? undefined);
      const provider = getAgentProvider(session.agentId, effectiveEnv);
      const gitIdentity = issue.repo
        ? ((await stub.getGitIdentityByRepo(issue.repo)) ??
          (await stub.getGitIdentityByRepo(DEFAULT_GIT_IDENTITY_REPO)) ??
          null)
        : null;
      const delivered = provider.sendPrompt
        ? await provider.sendPrompt(
            session.providerSessionId,
            answer,
            issue,
            gitIdentity,
            {
              organizationId,
              backupRef: session.sandboxBackupRef ?? null,
            }
          )
        : false;
      if (!delivered) {
        return c.json(
          {
            message:
              "Session sandbox is gone or busy — retry for a cold dispatch with the answer as context",
          },
          409
        );
      }
      delivery = "sent";
    }

    const updated = await stub.respondToElicitation(sessionId, {
      answer,
      actorId: identity.id,
      delivery,
    });
    const activities = await stub.listAgentActivities(sessionId);
    return c.json(toSessionResponse(updated ?? session, activities), 200);
  });

  app.openapi(retrySessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const db = createD1(c.env.D1);
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    await assertSessionIssueAccess(
      createD1(c.env.D1),
      stub,
      session,
      c.var.workspaceIdentity
    );
    const issue = await stub.getIssue(session.issueId);
    if (!issue) {
      return c.json({ message: "Issue not found" }, 404);
    }
    // PILE-321 — retrying a lane dispatched before the issue had a repo
    // inherits the team's defaultRepo, same as a fresh dispatch.
    const retryIssue = await inheritTeamDefaultRepo(
      db,
      stub,
      organizationId,
      issue,
      identity.id
    );

    const agentId = body.agentId ?? session.agentId;
    const providerConfig = await loadProviderConfig(c.env, stub, agentId);
    const effectiveEnv = resolveAgentEnv(c.env, providerConfig ?? undefined);

    // Nudge = retry with context (PILE-209): prior result + caller context
    // become dispatch instructions; one-shot sessions are never mutated.
    const instructions = [
      session.result
        ? `Previous attempt result: ${session.result.slice(0, 2000)}`
        : null,
      body.context,
    ]
      .filter((part): part is string => !!part)
      .join("\n\n");

    const retried = await dispatchAgent(
      effectiveEnv,
      agentId,
      organizationId,
      retryIssue,
      identity,
      body.model,
      getExecutionCtx(c),
      {
        instructions: instructions || undefined,
        // A lane that was queued behind a blocker re-enters the queue on
        // retry — the edge survives promotion on the session row (PILE-260).
        queueAfter: session.queuedAfter ?? undefined,
        // PILE-423 — retries resolve the same step scope as the original.
        stepKey: session.stepKey ?? undefined,
        secondaryRepos: parseStoredSecondaryRepos(session.secondaryRepos),
        effort: body.effort ?? session.effort ?? undefined,
        maxDurationMinutes:
          body.maxDuration ?? session.maxDurationMinutes ?? undefined,
      }
    );
    await stub.updateAgentSession(retried.id, {
      retryOf: session.id,
      retryCount: (session.retryCount ?? 0) + 1,
    });
    // Lanes parked behind the dead one re-anchor on its retry so they can't
    // promote off the corpse and race the redispatch (PILE-260).
    await stub
      .reanchorQueuedDependents(session.id, retried.id)
      .catch((err: unknown) =>
        console.error("queued session re-anchor failed", {
          session: session.id,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    const activities = await stub.listAgentActivities(retried.id);
    return c.json(toSessionResponse(retried, activities), 201);
  });

  app.openapi(listAutomationsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const automations = await stub.listAgentAutomations({});
    // Automations bound to restricted issues are hidden entirely — their
    // prompts and issue links embed issue context.
    const hidden = new Set(
      await stub.hiddenIssueIdsFor(
        await issueViewer(createD1(c.env.D1), c.var.workspaceIdentity)
      )
    );
    return c.json(
      {
        automations: automations.filter(
          (a) => !a.issueId || !hidden.has(a.issueId)
        ),
      },
      200
    );
  });

  app.openapi(createAutomationRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);
    const automation = await stub.createAgentAutomation({
      ...body,
      issueId:
        body.issueId === undefined
          ? undefined
          : await resolveVisibleIssueRef(
              createD1(c.env.D1),
              stub,
              body.issueId,
              identity
            ),
      enabled: true,
      createdBy: identity.id,
    });
    return c.json(automation, 201);
  });

  app.openapi(deleteAutomationRoute, async (c) => {
    const { organizationId, automationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const existing = await stub.getAgentAutomation(automationId);
    if (!existing) {
      return c.json({ message: "Automation not found" }, 404);
    }
    // An automation bound to a restricted issue is invisible to members
    // without a grant — deleting it is gated the same way.
    if (existing.issueId) {
      const bound = await stub.getIssue(existing.issueId);
      if (bound) {
        const db = createD1(c.env.D1);
        try {
          await assertIssueAccess(db, stub, bound, c.var.workspaceIdentity);
        } catch (err) {
          if (!(err instanceof VortexError)) throw err;
          return c.json({ message: "Automation not found" }, 404);
        }
      }
    }
    await stub.deleteAgentAutomation(automationId);
    return c.json({ ok: true }, 200);
  });
}
