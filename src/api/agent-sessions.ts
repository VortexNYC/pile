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
  agentReportUrl,
  loadProviderConfig,
  verifySessionToken,
} from "../agents/credentials.js";
import { resolveAgentEnv } from "../agents/daytona.js";
import {
  dispatchAgent,
  getAgentProvider,
  providerKeepsTerminalSandbox,
} from "../agents/index.js";
import { mintLaneGithubToken } from "../agents/lane-github-token.js";
import {
  laneReportStepMessage,
  laneTodosSchema,
  type LaneTodo,
} from "../agents/lane-progress.js";
import { resolveResultSchema, sessionLabel } from "../agents/lane-result.js";
import { sessionHoldsKeptSandbox } from "../agents/sweep.js";
import { consumeUsage } from "../global/billing.js";
import { timingSafeEqualHex } from "../global/crypto.js";
import { createD1 } from "../global/db.js";
import { getInstallationTokenForRepo } from "../global/github-auth.js";
import { prUrlOnRepo } from "../global/lane-guard.js";
import { fetchPileRepoConfig } from "../global/pile-repo-config.js";
import { scrubLaneText } from "../global/redact.js";
import { createRepoBranch } from "../global/repo-branches.js";
import { githubInstallations } from "../global/schema.js";
import { replyLaneResultToTicket } from "../global/support-escalation.js";
import { canAccessTeam } from "../global/teams.js";
import { VortexError } from "../platform/errors.js";
import type { AppContext, WorkerEnv } from "../platform/middleware.js";
import { rls } from "../platform/rls.js";
import {
  DEFAULT_GIT_IDENTITY_REPO,
  type AgentSessionStatus,
  type Issue,
} from "../types/workspace.js";
import type { AgentSessionSummary } from "../workspace/data/index.js";
import type {
  workspaceAgentActivities,
  workspaceAgentSessions,
} from "../workspace/schema.js";
import { captureSessionPrArtifact } from "./agent-artifacts.js";
import { getExecutionCtx } from "./execution-ctx.js";
import { fetchGitHubCheckRuns, fetchGitHubPull, parsePrUrl } from "./pr.js";
import { getWorkspaceStub, resolveIssueRef } from "./stub.js";

const agentActivityTypeSchema = z.enum([
  "thought",
  "response",
  "error",
  "elicitation",
  "action",
  "status",
  "artifact",
]);

type AgentSession = InferSelectModel<typeof workspaceAgentSessions>;
type AgentActivity = InferSelectModel<typeof workspaceAgentActivities>;

const agentSessionStatusSchema = z.enum([
  "created",
  "running",
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
  /** Read-time derivation (PILE-209): `stalled` = running, stale progress,
   *  no PR; `needs_input` = latest activity is an elicitation. Never stored. */
  derivedStatus: z.enum(["stalled", "needs_input"]).nullable().optional(),
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
  row: Pick<AgentSession, "status" | "prUrl" | "lastProgressAt">,
  activities?: AgentActivity[]
): "stalled" | "needs_input" | null {
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

export function toSessionResponse(
  row: AgentSession,
  activities?: AgentActivity[]
) {
  return {
    ...row,
    resultSchema: parseJsonObject(row.resultSchema),
    structuredResult: parseJsonColumn(row.structuredResult),
    resultSchemaErrors: parseStringArray(row.resultSchemaErrors),
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
  middleware: [rls("read", "agent:read")],
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
  middleware: [rls("read", "agent:read")],
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
  middleware: [rls("read", "agent:read")],
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
  middleware: [rls("read", "agent:read")],
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
  middleware: [rls("read", "agent:read")],
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
  middleware: [rls("read", "agent:read")],
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
  middleware: [rls("read", "agent:read")],
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
  middleware: [rls("write", "agent:write")],
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
    url: z.string().optional(),
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
  middleware: [rls("write", "agent:write")],
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
  middleware: [rls("write", "agent:write")],
  request: {
    params: z.object({ organizationId: z.string(), sessionId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            status: agentSessionStatusSchema.optional(),
            result: z.string().optional(),
            url: z.string().optional(),
            prUrl: z.string().optional(),
            prState: z.string().optional(),
            branch: z.string().optional(),
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
  middleware: [rls("write", "agent:write")],
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

const pollSessionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/poll",
  tags: ["agent-sessions"],
  middleware: [rls("write", "agent:write")],
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
  middleware: [rls("read", "agent:read")],
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
  middleware: [rls("write", "agent:write")],
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
  middleware: [rls("write", "agent:write")],
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
              url: z.string().optional(),
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
    queuedAfter: z.string().optional(),
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
  middleware: [rls("write", "agent:write")],
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
  middleware: [rls("write", "agent:write")],
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

const retrySessionRoute = createRoute({
  method: "post",
  path: "/workspaces/{organizationId}/agent/sessions/{sessionId}/retry",
  tags: ["agent-sessions"],
  middleware: [rls("write", "agent:write")],
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
  middleware: [rls("read", "agent:read")],
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
  middleware: [rls("write", "agent:write")],
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
  middleware: [rls("write", "agent:write")],
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

    const laneUrls = async (sessionId: string) => ({
      laneToken: await agentLogToken(c.env, organizationId, sessionId),
      logUrl: agentLogUrl(c.env, organizationId, sessionId),
      reportUrl: agentReportUrl(c.env, organizationId, sessionId),
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
            const named = await stub.getAgentSession(queuedAfter);
            if (named) {
              if (!["completed", "failed", "canceled"].includes(named.status)) {
                queueAfter = named.id;
              }
            } else {
              const live =
                await stub.getActiveAgentSessionForIssue(queuedAfter);
              if (!live) {
                return dispatchBatchItemError(
                  issueId,
                  `queuedAfter target not found: ${item.queuedAfter}`
                );
              }
              queueAfter = live.session.id;
            }
          }
        }

        const issue = await stub.getIssue(issueId);
        if (!issue) {
          return dispatchBatchItemError(issueId, "Issue not found");
        }
        if (!(await canAccessTeam(db, issue.teamId, identity))) {
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
        const target: Issue = {
          ...issue,
          branch: item.branch === undefined ? issue.branch : item.branch,
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
            envAllowlist: pileConfig?.env,
            queueAfter,
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
    if (isSummaryQuery(query.summary)) {
      const rows = await stub.listAgentSessionSummaries({
        issueId: query.issueId,
        limit: query.limit ? Number(query.limit) : undefined,
      });
      return c.json({ sessions: rows.map(toSessionSummary) }, 200);
    }
    const rows = await stub.listAgentSessions({
      issueId:
        query.issueId === undefined
          ? undefined
          : await resolveIssueRef(stub, query.issueId),
      limit: query.limit ? Number(query.limit) : undefined,
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
    const rows = await stub.listAgentSessions({});

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
    const rows = await stub.listAgentSessions({ limit: 200 });

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
    const live = await stub.getActiveAgentSessionForIssue(
      await resolveIssueRef(stub, issueId)
    );
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
    return c.json(toSessionResponse(session, session.activities), 200);
  });

  app.openapi(getSessionEventsRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const { limit } = c.req.valid("query");
    const stub = getWorkspaceStub(c.env, organizationId);
    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
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
  // scoped to the session issue's repo only.
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
      const minted = await mintLaneGithubToken(
        c.env,
        organizationId,
        sessionId,
        issue.repo
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

  app.openapi(pollSessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }

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
    const issue = await stub.getIssue(session.issueId);
    if (!issue) {
      return c.json({ message: "Issue not found" }, 404);
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
          gitIdentity
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
    const updated = await stub.applyAgentSessionResult(
      sessionId,
      { status: "running", result: null },
      identity.id
    );
    const activities = await stub.listAgentActivities(sessionId);
    return c.json(toSessionResponse(updated ?? session, activities), 200);
  });

  app.openapi(retrySessionRoute, async (c) => {
    const { organizationId, sessionId } = c.req.valid("param");
    const body = c.req.valid("json");
    const identity = c.var.workspaceIdentity;
    const stub = getWorkspaceStub(c.env, organizationId);

    const session = await stub.getAgentSession(sessionId);
    if (!session) {
      return c.json({ message: "Session not found" }, 404);
    }
    const issue = await stub.getIssue(session.issueId);
    if (!issue) {
      return c.json({ message: "Issue not found" }, 404);
    }

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
      issue,
      identity,
      body.model,
      getExecutionCtx(c),
      {
        instructions: instructions || undefined,
        effort: body.effort ?? session.effort ?? undefined,
        maxDurationMinutes:
          body.maxDuration ?? session.maxDurationMinutes ?? undefined,
      }
    );
    await stub.updateAgentSession(retried.id, {
      retryOf: session.id,
      retryCount: (session.retryCount ?? 0) + 1,
    });
    const activities = await stub.listAgentActivities(retried.id);
    return c.json(toSessionResponse(retried, activities), 201);
  });

  app.openapi(listAutomationsRoute, async (c) => {
    const { organizationId } = c.req.valid("param");
    const stub = getWorkspaceStub(c.env, organizationId);
    const automations = await stub.listAgentAutomations({});
    return c.json({ automations }, 200);
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
          : await resolveIssueRef(stub, body.issueId),
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
    await stub.deleteAgentAutomation(automationId);
    return c.json({ ok: true }, 200);
  });
}
