import { DurableObject } from "cloudflare:workers";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  ne,
  not,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import {
  LANE_PROGRESS_HEARTBEAT_MS,
  LANE_PROGRESS_THROTTLE_MS,
  laneProgressExternalId,
  laneProgressFromActivities,
  renderLaneProgressComment,
  typicalLaneDurationMs,
} from "../agents/lane-progress.js";
import { evaluateLaneResult } from "../agents/lane-result.js";
import {
  extractPlanText,
  formatPlanComment,
  PLAN_COMMENT_SOURCE,
  PLAN_PURPOSE,
} from "../agents/plan.js";
import { parseSessionPlan, type SessionPlan } from "../agents/session-plan.js";
import {
  computeCostMicros,
  type CapBreach,
  dayWindowStart,
  evaluateSpendCaps,
  monthWindowStart,
  type AgentRunUsage,
  type SpendWindowUsage,
} from "../agents/spend.js";
import {
  dispatchTriageLane,
  formatTriageComment,
  parseTriageReport,
  planTriageApplication,
  TRIAGE_PURPOSE,
} from "../agents/triage.js";
import { sendEmail } from "../email/send.js";
import {
  hmacSha256Hex,
  sha256Hex,
  timingSafeEqualHex,
} from "../global/crypto.js";
import { createD1 } from "../global/db.js";
import { sanitizeLaneResult } from "../global/lane-guard.js";
import {
  attachments as globalAttachments,
  agentActivities as globalAgentActivities,
  agentSessions as globalAgentSessions,
  comments as globalComments,
  cycles,
  githubUsers,
  issueApprovals as globalIssueApprovals,
  issueHistory as globalIssueHistory,
  issueRelations as globalIssueRelations,
  issueSubscribers as globalIssueSubscribers,
  linearUsers as globalLinearUsers,
  notifications as globalNotifications,
  organization,
  outboundWebhookDeliveries as globalOutboundDeliveries,
  reactions as globalReactions,
  savedViews as globalSavedViews,
  user as globalUser,
  userWorkspacePreferences as globalUserPrefs,
  viewFavorites as globalViewFavorites,
  webhookSubscriptions as globalWebhookSubs,
} from "../global/schema.js";
import { safeJSON } from "../global/team-metadata.js";
import { getDefaultTeam, getTeamById } from "../global/teams.js";
import { listLabels } from "../global/workspace-entities.js";
import { getWorkspaceMembership } from "../global/workspaces.js";
import { getWorkspaceById } from "../global/workspaces.js";
import { VortexError } from "../platform/errors.js";
import type { WorkerEnv } from "../platform/middleware.js";
import { createPhaseTimer, logSlowPhases } from "../platform/phase-timer.js";
import { notifySlack } from "../slack/bot.js";
import type { AppEnv } from "../types/env.js";
import {
  ISSUE_RESOLUTIONS,
  type AgentSession,
  type AgentSessionResult,
  type AgentSessionStatus,
  type Comment,
  type DraftCommentPayload,
  type DraftFieldChangePayload,
  type DraftOutput,
  type DraftOutputStatus,
  type ExternalEventDeliveryStatus,
  type ExternalEventIngestInput,
  type ExternalEventIngestResult,
  type GitIdentity,
  type Issue,
  type IssueClaim,
  type IssueInput,
  type IssuePatch,
  type IssueResolution,
  type IssueStatus,
  type IssueViewer,
  type ListIssuesArgs,
  type RealtimeEvent,
} from "../types/workspace.js";
import * as data from "./data/index.js";
import { encryptSecret } from "../agents/credentials.js";
import { filterToSql } from "./filter.js";
import { workspaceMigrations } from "./migrations.js";
import { type ReviewVerdict, rollReviewSummary } from "./review-summary.js";
import { workspaceSchema } from "./schema-map.js";
import {
  workspaceAgentActivities,
  workspaceAgentSessions,
  workspaceAttachments,
  workspaceComments,
  workspaceDocuments,
  workspaceDocumentPermissions,
  workspaceDraftOutputs,
  workspaceGitIdentities,
  workspaceIssueApprovals,
  workspaceIssueHistory,
  workspaceEntityLinks,
  workspaceAuditLog,
  externalLinks,
  workspaceSubscriptions,
  workspaceIssues,
  workspaceLinearUsers,
  workspaceNotifications,
  workspaceOutboundWebhookDeliveries,
  workspaceReactions,
  workspaceSavedViews,
  workspaceMcpServers,
  workspaceUserPreferences,
  workspaceViewFavorites,
  workspaceWebhookSubscriptions,
} from "./schema.js";
import {
  blockNoteToPlainText,
  commentToSearchDocument,
  createWorkspaceSearchIndex,
  indexCommentDocument,
  indexIssueDocument,
  indexDocumentSearchDocument,
  documentToSearchDocument,
  DUPLICATE_MIN_SCORE,
  findDuplicateCandidates,
  findSimilarIssues,
  insertMultiple as insertSearchDocs,
  issueToSearchDocument,
  normalizeIssueTitle,
  removeIssueDocuments,
  similarityTerms,
  titleOverlapScore,
  searchDocuments,
  searchIssues,
  type CommentForSearch,
  type WorkspaceSearchIndex,
} from "./search.js";
import { deliverWebhooks, retryWebhookDeliveries } from "./webhooks.js";

type IssueKey = keyof Issue & keyof IssuePatch;

const TERMINAL_STATUSES: ReadonlyArray<IssueStatus> = ["done", "canceled"];

// PATCHes slower than this log a per-phase breakdown (issue.update.slow).
const SLOW_ISSUE_UPDATE_MS = 500;

/** Canonical prState → issue status mapping shared by every prState writer
 *  (webhooks, reconcile, PATCH). */
const PR_STATE_TO_STATUS: Record<string, Issue["status"] | undefined> = {
  draft: "backlog",
  open: "in_progress",
  merged: "done",
  closed: "canceled",
};

function chunk<T>(arr: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
    arr.slice(i * size, (i + 1) * size)
  );
}

function isTerminalStatus(status: IssueStatus): boolean {
  return status === "done" || status === "canceled";
}

async function resolveParent(
  getIssue: (id: string) => Promise<Issue | undefined>,
  parentId: string | null,
  issueId: string
): Promise<Issue | null> {
  if (parentId === null) return null;
  const parent = await getIssue(parentId);
  if (!parent) {
    throw VortexError.fromCode("BAD_REQUEST", "Parent issue not found");
  }
  // Compare canonical ids — a parentId given as the issue's own identifier
  // (KEY-123) must not slip past the self-parent check.
  if (parent.id === issueId) {
    throw VortexError.fromCode(
      "BAD_REQUEST",
      "An issue cannot be its own parent"
    );
  }
  return parent;
}

async function wouldCreateCycle(
  getIssue: (id: string) => Promise<Issue | undefined>,
  issueId: string,
  parentId: string,
  seen: Set<string>
): Promise<boolean> {
  if (parentId === issueId) return true;
  if (seen.has(parentId)) return true;
  seen.add(parentId);
  const issue = await getIssue(parentId);
  const next = issue?.parentId ?? null;
  if (next === null) return false;
  return wouldCreateCycle(getIssue, issueId, next, seen);
}

// PILE-422 — cap on the raw payload retained on a delivery row (evidence).
const EXTERNAL_EVENT_PAYLOAD_MAX_CHARS = 64_000;
// Cap on the payload quoted into the evidence comment on the completed
// sub-step — the full body stays on the delivery row.
const EXTERNAL_EVENT_COMMENT_PAYLOAD_CHARS = 2_000;

/** Signature headers carry provider-specific envelopes — bare hex,
 *  "sha256=<hex>" (GitHub-style), or "t=<ms>,v1=<hex>" (Stripe-style). The
 *  verification contract is one MAC — hex HMAC-SHA256 of the raw body — so a
 *  presented signature matches when any 64-hex token in it equals it. */
function externalSignatureTokens(headers: string[]): string[] {
  const tokens: string[] = [];
  for (const header of headers) {
    for (const match of header.matchAll(/[0-9a-fA-F]{64}/g)) {
      tokens.push(match[0].toLowerCase());
    }
  }
  return tokens;
}

function validateIssueResolution(
  status: IssueStatus,
  resolution: IssueResolution | null,
  resolutionReason?: string | null
): IssueResolution | null {
  if (resolution === null) {
    if (resolutionReason) {
      throw VortexError.fromCode(
        "BAD_REQUEST",
        "resolutionReason requires a resolution"
      );
    }
    return null;
  }
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
  // PILE-412 — a skipped sub-step is the gate's "deliberately not done"
  // outcome; without a recorded reason it is indistinguishable from a dodge.
  if (resolution === "skipped" && !resolutionReason) {
    throw VortexError.fromCode(
      "BAD_REQUEST",
      "resolution 'skipped' requires a resolutionReason"
    );
  }
  return resolution;
}

/** PILE-412 — a required sub-step stops blocking its parent's stage
 *  transition when the work happened (done) or was deliberately skipped
 *  with a reason (canceled + resolution skipped). Any other terminal or
 *  non-terminal state still blocks. */
function subStepSatisfied(child: Issue): boolean {
  return (
    child.status === "done" ||
    (child.status === "canceled" && child.resolution === "skipped")
  );
}

/** The 409 every gated transition shares — issue status, customer status,
 *  and deal stage all answer the same body shape so clients (and the web
 *  UI's blocking list) handle one error form. */
function stageGateConflict(
  blocked: { parent: Issue; steps: Issue[] }[]
): VortexError {
  const count = blocked.reduce((n, b) => n + b.steps.length, 0);
  return new VortexError({
    code: "CONFLICT",
    status: 409,
    message: `${count} required sub-step${count === 1 ? "" : "s"} still open`,
    hint: "Complete them, or cancel with resolution 'skipped' and a resolutionReason",
    details: {
      blockingSubSteps: blocked.flatMap(({ parent, steps }) =>
        steps.map((child) => ({
          id: child.id,
          identifier: child.identifier,
          stepKey: child.stepKey,
          ownerAgent: child.ownerAgent,
          parentIssueId: parent.id,
        }))
      ),
    },
  });
}

function hasWorkspaceNamespace(env: AppEnv): env is WorkerEnv {
  return "WORKSPACE_DURABLE_OBJECT" in env;
}

const LANE_GITHUB_TOKEN_PREFIX = "laneGithubToken:";

// Viewer stamped on each websocket at connect (x-pile-ws-viewer) — used to
// filter issue-bearing realtime events for restricted issues.
const wsViewerSchema = z.object({
  actorId: z.string(),
  teamIds: z.array(z.string()),
  admin: z.boolean(),
});
type WsViewer = z.infer<typeof wsViewerSchema>;

export class WorkspaceDO extends DurableObject<AppEnv> {
  private organizationId: string;
  private readonly ready: Promise<void>;
  private searchIndex: WorkspaceSearchIndex | null = null;
  private searchIndexBuild: Promise<WorkspaceSearchIndex> | null = null;
  private readonly db = drizzle(this.ctx.storage, {
    schema: workspaceSchema,
  });

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    // `idFromName(organizationId)` ids carry the name — that's the real
    // org id. Only `newUniqueId` ids lack it and fall back to the hex id.
    this.organizationId = ctx.id.name ?? ctx.id.toString();
    this.ready = this.initialize();
  }

  /** Wipes all workspace state (issues, sessions, config). Called only by the
   *  workspace-deletion path after the D1 rows are gone. */
  async destroy() {
    await this.ready;
    await this.ctx.storage.deleteAll();
  }

  private async initialize() {
    const [stored, , backfilled] = await Promise.all([
      this.ctx.storage.get<string>("organizationId"),
      this.runMigrations(),
      this.ctx.storage.get<boolean>("workspaceDataBackfilled"),
    ]);
    if (stored && !this.ctx.id.name) {
      // Name-less DOs (newUniqueId) still need the stored org id; named
      // ids already have it via ctx.id.name.
      this.organizationId = stored;
    }
    if (!backfilled) {
      await this.backfillLegacyData();
      await this.ctx.storage.put("workspaceDataBackfilled", true);
    }
  }

  // One-time copy of legacy D1 workspace-content rows into this DO. After
  // this runs the workspace is fully self-contained; D1 keeps only registry
  // data (orgs, members, teams, config) and lookup indexes.
  private async backfillLegacyData(): Promise<void> {
    const d1 = createD1(this.env.D1);
    const org = this.organizationId;
    const ts = new Date().toISOString();

    const [
      history,
      commentRows,
      subscribers,
      relations,
      approvals,
      reactionRows,
      attachmentRows,
      notificationRows,
      viewRows,
      favoriteRows,
      prefRows,
      linearRows,
      sessionRows,
      activityRows,
      subRows,
      deliveryRows,
    ] = await Promise.all([
      d1
        .select()
        .from(globalIssueHistory)
        .where(eq(globalIssueHistory.organizationId, org))
        .all(),
      d1
        .select()
        .from(globalComments)
        .where(eq(globalComments.organizationId, org))
        .all(),
      d1
        .select()
        .from(globalIssueSubscribers)
        .where(eq(globalIssueSubscribers.organizationId, org))
        .all(),
      d1
        .select()
        .from(globalIssueRelations)
        .where(eq(globalIssueRelations.organizationId, org))
        .all(),
      d1
        .select()
        .from(globalIssueApprovals)
        .where(eq(globalIssueApprovals.organizationId, org))
        .all(),
      d1
        .select()
        .from(globalReactions)
        .where(eq(globalReactions.organizationId, org))
        .all(),
      d1
        .select()
        .from(globalAttachments)
        .where(eq(globalAttachments.organizationId, org))
        .all(),
      d1
        .select()
        .from(globalNotifications)
        .where(eq(globalNotifications.organizationId, org))
        .all(),
      d1
        .select()
        .from(globalSavedViews)
        .where(eq(globalSavedViews.organizationId, org))
        .all(),
      d1
        .select()
        .from(globalViewFavorites)
        .where(eq(globalViewFavorites.organizationId, org))
        .all(),
      d1
        .select()
        .from(globalUserPrefs)
        .where(eq(globalUserPrefs.organizationId, org))
        .all(),
      d1
        .select()
        .from(globalLinearUsers)
        .where(eq(globalLinearUsers.organizationId, org))
        .all(),
      d1
        .select()
        .from(globalAgentSessions)
        .where(eq(globalAgentSessions.organizationId, org))
        .all(),
      d1.select().from(globalAgentActivities).all(),
      d1
        .select()
        .from(globalWebhookSubs)
        .where(eq(globalWebhookSubs.organizationId, org))
        .all(),
      d1
        .select()
        .from(globalOutboundDeliveries)
        .where(eq(globalOutboundDeliveries.organizationId, org))
        .all(),
    ]);

    const sessionIds = new Set(sessionRows.map((row) => row.id));

    if (history.length > 0) {
      await this.db.insert(workspaceIssueHistory).values(history);
    }
    if (commentRows.length > 0) {
      await this.db.insert(workspaceComments).values(commentRows);
    }
    if (subscribers.length > 0) {
      await this.db.insert(workspaceSubscriptions).values(
        subscribers.map((s) => ({
          id: s.id,
          organizationId: this.organizationId,
          entityType: "issue",
          entityId: s.issueId,
          userId: s.linearUserId,
          createdAt: s.createdAt,
        }))
      );
    }
    if (relations.length > 0) {
      await this.db.insert(workspaceEntityLinks).values(
        relations.map((r) => ({
          id: r.id,
          organizationId: this.organizationId,
          fromType: "issue",
          fromId: r.fromIssueId,
          toType: "issue",
          toId: r.toIssueId,
          kind: r.type,
          createdAt: r.createdAt,
        }))
      );
    }
    if (approvals.length > 0) {
      await this.db.insert(workspaceIssueApprovals).values(approvals);
    }
    if (reactionRows.length > 0) {
      await this.db.insert(workspaceReactions).values(reactionRows);
    }
    if (attachmentRows.length > 0) {
      await this.db.insert(workspaceAttachments).values(attachmentRows);
    }
    if (notificationRows.length > 0) {
      await this.db.insert(workspaceNotifications).values(notificationRows);
    }
    if (viewRows.length > 0) {
      await this.db.insert(workspaceSavedViews).values(viewRows);
    }
    if (favoriteRows.length > 0) {
      await this.db.insert(workspaceViewFavorites).values(favoriteRows);
    }
    if (prefRows.length > 0) {
      for (const row of prefRows) {
        row.updatedAt = row.updatedAt ?? ts;
      }
      await this.db.insert(workspaceUserPreferences).values(prefRows);
    }
    if (linearRows.length > 0) {
      await this.db.insert(workspaceLinearUsers).values(linearRows);
    }
    if (sessionRows.length > 0) {
      await this.db.insert(workspaceAgentSessions).values(sessionRows);
    }
    const ownedActivities = activityRows.filter((row) =>
      sessionIds.has(row.sessionId)
    );
    if (ownedActivities.length > 0) {
      await this.db.insert(workspaceAgentActivities).values(ownedActivities);
    }
    if (subRows.length > 0) {
      await this.db.insert(workspaceWebhookSubscriptions).values(subRows);
    }
    if (deliveryRows.length > 0) {
      await this.db
        .insert(workspaceOutboundWebhookDeliveries)
        .values(deliveryRows);
    }
  }

  async setOrganizationId(id: string) {
    this.organizationId = id;
    await this.ctx.storage.put("organizationId", id);
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return new Response("WorkspaceDO");
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);

    // The API layer stamps the connecting identity on `x-pile-ws-viewer`;
    // issue-bearing events are filtered per socket so restricted issues
    // (issue_permissions) never reach members without a grant. Grants
    // changed after connect apply on the next connection. A missing or
    // unparseable stamp is a non-admin nobody (open issues only) — never
    // unfiltered.
    const viewerHeader = request.headers.get("x-pile-ws-viewer");
    let wsViewer: WsViewer = { actorId: "", teamIds: [], admin: false };
    if (viewerHeader) {
      try {
        wsViewer = wsViewerSchema.parse(JSON.parse(viewerHeader));
      } catch {
        // keep the nobody default
      }
    }
    server.serializeAttachment(wsViewer);

    await this.emit({
      type: "connected",
      organizationId: this.organizationId,
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    if (typeof message !== "string") return;
    try {
      const parsed = z
        .object({ type: z.string() })
        .safeParse(JSON.parse(message));
      if (parsed.success && parsed.data.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    } catch {
      // ignore malformed messages
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close();
  }

  private async runMigrations() {
    await migrate(this.db, workspaceMigrations);
    // PILE-438 — persist keys on statuses that predate the column so a
    // rename can no longer orphan the stage bindings that reference them.
    await data.backfillCustomerStatusKeys(this.db, this.organizationId);
    await data.markTerminalStatuses(this.db, this.organizationId);
  }

  private async ensureSearchIndex(): Promise<WorkspaceSearchIndex> {
    if (this.searchIndex) return this.searchIndex;
    this.searchIndexBuild ??= this.buildSearchIndex().finally(() => {
      this.searchIndexBuild = null;
    });
    return this.searchIndexBuild;
  }

  // Test seam — resolves once an in-flight background index build settles.
  async flushSearchIndex(): Promise<void> {
    await this.searchIndexBuild?.catch(() => undefined);
  }

  // Write paths keep a built index current but never pay for the cold
  // build (seconds on a mature workspace) — the build reads current rows,
  // so it picks this write up on its own. A build already in flight may
  // have read the pre-write row, so that case queues the apply behind the
  // build rather than awaiting it inline — writes must not hang on it.
  private async syncSearchIndex(
    apply: (index: WorkspaceSearchIndex) => Promise<void>
  ): Promise<void> {
    if (this.searchIndex) {
      await apply(this.searchIndex);
      return;
    }
    // Don't await an in-flight build on the write path — it's slow on
    // mature workspaces and would hang the request. Queue the apply so the
    // entry lands once the build completes (the build may have read rows
    // pre-write, so skipping entirely could lose the write from the index).
    const build = this.searchIndexBuild;
    if (build) {
      this.ctx.waitUntil(build.then(apply).catch(() => undefined));
    }
  }

  private async buildSearchIndex(): Promise<WorkspaceSearchIndex> {
    const index = await createWorkspaceSearchIndex();
    const [issues, commentRows, documentRows] = await Promise.all([
      this.db.select().from(workspaceIssues).all(),
      this.db
        .select({
          id: workspaceComments.id,
          issueId: workspaceComments.entityId,
          body: workspaceComments.body,
          createdAt: workspaceComments.createdAt,
        })
        .from(workspaceComments)
        .all(),
      this.db
        .select({
          id: workspaceDocuments.id,
          title: workspaceDocuments.title,
          content: workspaceDocuments.content,
          createdAt: workspaceDocuments.createdAt,
        })
        .from(workspaceDocuments)
        .where(isNull(workspaceDocuments.trashedAt))
        .all(),
    ]);

    const issueById = new Map(issues.map((issue) => [issue.id, issue]));
    const docs: Array<ReturnType<typeof issueToSearchDocument>> = [];
    for (const issue of issues) {
      docs.push(issueToSearchDocument(issue));
    }
    for (const comment of commentRows) {
      if (!comment.issueId) continue;
      const issue = issueById.get(comment.issueId);
      docs.push(
        commentToSearchDocument({
          id: comment.id,
          issueId: comment.issueId,
          teamId: issue?.teamId ?? "",
          body: comment.body,
          createdAt: comment.createdAt,
        })
      );
    }
    for (const doc of documentRows) {
      docs.push(documentToSearchDocument(doc));
    }
    // Index in batches and yield between them — a mature workspace's build
    // is tens of seconds of tokenization; one synchronous insertMultiple
    // starves the DO's event loop and every concurrent request hangs past
    // the request budget (issue-create 500s, ~40s).
    // insertSearchDocs resolves after yielding the event loop, so the
    // sequential batches never starve concurrent DO requests.
    const insertBatch = async (start: number) => {
      await insertSearchDocs(index, docs.slice(start, start + 250));
      await Promise.resolve();
    };
    await docs
      .map((_, i) => i)
      .filter((i) => i % 250 === 0)
      .reduce(
        (chain, i) => chain.then(() => insertBatch(i)),
        Promise.resolve()
      );

    this.searchIndex = index;
    return index;
  }

  private emitWebSockets(event: RealtimeEvent): void {
    const eventIssueId =
      "issue" in event
        ? event.issue.id
        : "issueId" in event
          ? event.issueId
          : event.type === "audit.entry" && event.entry.entityType === "issue"
            ? event.entry.entityId
            : undefined;
    for (const ws of this.ctx.getWebSockets()) {
      try {
        if (eventIssueId !== undefined) {
          const viewer = ws.deserializeAttachment() as WsViewer | null;
          if (
            viewer &&
            !viewer.admin &&
            !data.hasIssueAccess(
              this.db,
              eventIssueId,
              viewer.actorId,
              viewer.teamIds
            )
          ) {
            continue;
          }
        }
        ws.send(JSON.stringify(event));
      } catch {
        // socket may be closing
      }
    }
  }

  async emit(event: RealtimeEvent) {
    this.emitWebSockets(event);
    this.ctx.waitUntil(this.sendWebhookEvent(event));
  }

  async broadcast(event: RealtimeEvent): Promise<void> {
    this.emitWebSockets(event);
  }

  private async sendWebhookEvent(event: RealtimeEvent) {
    const result = await deliverWebhooks(
      this.db,
      this.env,
      this.organizationId,
      event
    );
    if (result.needsRetry && result.retryAt) {
      await this.ctx.storage.setAlarm(result.retryAt);
    }
    try {
      await notifySlack(this.env, this.organizationId, event);
    } catch {
      // Slack delivery is best-effort; failures must not affect webhook retries
    }
  }

  async alarm() {
    const result = await retryWebhookDeliveries(
      this.db,
      this.env,
      this.organizationId
    );
    if (result.hasMore && result.retryAt) {
      await this.ctx.storage.setAlarm(result.retryAt);
    }
  }

  async listComments(issueId: string) {
    await this.ready;
    return this.db
      .select()
      .from(workspaceComments)
      .where(
        and(
          eq(workspaceComments.entityType, "issue"),
          eq(workspaceComments.entityId, issueId)
        )
      )
      .all();
  }

  async listDocumentComments(documentId: string) {
    await this.ready;
    return this.db
      .select()
      .from(workspaceComments)
      .where(
        and(
          eq(workspaceComments.entityType, "document"),
          eq(workspaceComments.entityId, documentId)
        )
      )
      .all();
  }

  // CRM notes — same comments table, keyed by the record's own type.
  async listEntityComments(entityType: string, entityId: string) {
    await this.ready;
    return this.db
      .select()
      .from(workspaceComments)
      .where(
        and(
          eq(workspaceComments.entityType, entityType),
          eq(workspaceComments.entityId, entityId)
        )
      )
      .all();
  }

  async resolveComment(id: string, actorId: string) {
    await this.ready;
    await this.db
      .update(workspaceComments)
      .set({
        resolvedAt: new Date().toISOString(),
        resolvedById: actorId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(workspaceComments.id, id));
    return this.getComment(id);
  }

  async unresolveComment(id: string) {
    await this.ready;
    await this.db
      .update(workspaceComments)
      .set({
        resolvedAt: null,
        resolvedById: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(workspaceComments.id, id));
    return this.getComment(id);
  }

  async getComment(id: string) {
    await this.ready;
    return this.db
      .select()
      .from(workspaceComments)
      .where(eq(workspaceComments.id, id))
      .get();
  }

  async findCommentByExternalId(externalSource: string, externalId: string) {
    await this.ready;
    return this.db
      .select({ id: workspaceComments.id })
      .from(workspaceComments)
      .where(
        and(
          eq(workspaceComments.externalSource, externalSource),
          eq(workspaceComments.externalId, externalId)
        )
      )
      .get();
  }

  async createComment(values: {
    issueId?: string | null;
    documentId?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    mentions?: string[];
    authorId?: string | null;
    body: string;
    internal?: boolean;
    externalId?: string;
    externalSource?: string;
    externalAuthor?: string;
    createdAt?: string;
    updatedAt?: string;
  }) {
    await this.ready;
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    await this.db.insert(workspaceComments).values({
      id,
      organizationId: this.organizationId,
      entityType: values.entityType ?? (values.issueId ? "issue" : "document"),
      entityId: values.entityId ?? values.issueId ?? values.documentId ?? null,
      authorId: values.authorId ?? null,
      body: values.body,
      internal: values.internal ?? false,
      externalId: values.externalId ?? null,
      externalSource: values.externalSource ?? null,
      externalAuthor: values.externalAuthor ?? null,
      createdAt: values.createdAt ?? ts,
      updatedAt: values.updatedAt ?? ts,
    });
    const subjectId = values.documentId ?? values.issueId;
    if (subjectId) {
      const notified = new Set<string>();
      if (values.documentId) {
        await Promise.all(
          data
            .listDocumentWatchers(this.db, subjectId)
            .map(async (watcherId) => {
              if (watcherId === values.authorId || notified.has(watcherId))
                return;
              notified.add(watcherId);
              await this.deliverNotification({
                recipientId: watcherId,
                recipientType: "user",
                issueId: subjectId,
                type: "document_commented",
                metadata: { documentId: subjectId, commentId: id },
              });
            })
        );
      }
      await Promise.all(
        (values.mentions ?? []).map(async (mentionId) => {
          if (mentionId === values.authorId || notified.has(mentionId)) return;
          notified.add(mentionId);
          await this.deliverNotification({
            recipientId: mentionId,
            recipientType: "user",
            issueId: subjectId,
            type: "mention",
            metadata: {
              documentId: values.documentId ?? null,
              issueId: values.issueId ?? null,
              commentId: id,
            },
          });
        })
      );
    }
    return this.getComment(id);
  }

  async updateComment(
    id: string,
    values: {
      body: string;
      externalId?: string;
      externalSource?: string;
      externalAuthor?: string;
      updatedAt?: string;
    }
  ) {
    await this.ready;
    const ts = new Date().toISOString();
    await this.db
      .update(workspaceComments)
      .set({
        body: values.body,
        externalId: values.externalId,
        externalSource: values.externalSource,
        externalAuthor: values.externalAuthor,
        updatedAt: values.updatedAt ?? ts,
      })
      .where(eq(workspaceComments.id, id));
    return this.getComment(id);
  }

  async deleteComment(id: string) {
    await this.ready;
    await this.db.delete(workspaceComments).where(eq(workspaceComments.id, id));
  }

  // ---- PILE-428 draft outputs ----
  // Agent-produced writes on sensitive records land here as `pending`
  // instead of going live; a human publishes (the payload replays through
  // the same write path the agent would have hit) or discards (the row is
  // retained for inspection — drafts are never deleted).

  async createDraftOutput(input: {
    entityType: string;
    entityId: string;
    issueId?: string | null;
    kind: DraftOutput["kind"];
    payload:
      | DraftCommentPayload
      | DraftFieldChangePayload
      | Record<string, unknown>;
    createdById?: string | null;
    sessionId?: string | null;
    /** PILE-404 — provenance for evals: which agent + prompt produced
     *  this draft. */
    agentSlug?: string | null;
    promptVersion?: string | null;
  }): Promise<DraftOutput> {
    await this.ready;
    const id = crypto.randomUUID();
    const ts = new Date().toISOString();
    const row = await this.db
      .insert(workspaceDraftOutputs)
      .values({
        id,
        organizationId: this.organizationId,
        entityType: input.entityType,
        entityId: input.entityId,
        issueId: input.issueId ?? null,
        kind: input.kind,
        payload: JSON.stringify(input.payload),
        status: "pending",
        createdById: input.createdById ?? null,
        sessionId: input.sessionId ?? null,
        agentSlug: input.agentSlug ?? null,
        promptVersion: input.promptVersion ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning()
      .get();
    this.audit(
      "draft_output.created",
      "draft_output",
      id,
      input.createdById ?? null,
      { kind: { from: null, to: input.kind } },
      { actorType: "agent" }
    );
    // The gate only works if a human sees the queue — the record issue's
    // subscribers hear draft_pending (in-app + default email).
    if (input.issueId) {
      const issue = await this.getIssue(input.issueId);
      if (issue) {
        await this.notifyIssueEvent(
          issue,
          "draft_pending",
          input.createdById ?? undefined
        );
      }
    }
    return row;
  }

  async getDraftOutput(id: string) {
    await this.ready;
    return this.db
      .select()
      .from(workspaceDraftOutputs)
      .where(eq(workspaceDraftOutputs.id, id))
      .get();
  }

  async listDraftOutputs(filter?: {
    issueId?: string;
    entityType?: string;
    entityId?: string;
    status?: DraftOutputStatus;
  }): Promise<DraftOutput[]> {
    await this.ready;
    const conditions = [
      eq(workspaceDraftOutputs.organizationId, this.organizationId),
    ];
    if (filter?.issueId) {
      conditions.push(eq(workspaceDraftOutputs.issueId, filter.issueId));
    }
    if (filter?.entityType) {
      conditions.push(eq(workspaceDraftOutputs.entityType, filter.entityType));
    }
    if (filter?.entityId) {
      conditions.push(eq(workspaceDraftOutputs.entityId, filter.entityId));
    }
    if (filter?.status) {
      conditions.push(eq(workspaceDraftOutputs.status, filter.status));
    }
    return this.db
      .select()
      .from(workspaceDraftOutputs)
      .where(and(...conditions))
      .all();
  }

  private async requirePendingDraft(id: string): Promise<DraftOutput> {
    const draft = await this.getDraftOutput(id);
    if (!draft) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Draft output not found",
      });
    }
    if (draft.status !== "pending") {
      throw new VortexError({
        code: "CONFLICT",
        status: 409,
        message: `Draft output is already ${draft.status}`,
      });
    }
    return draft;
  }

  /** Edit the held payload while the draft is pending — the human "edit"
   *  half of approve/edit/skip. The prior payload is kept in the audit
   *  trail (edits are the signal that teaches the prompt). */
  async updateDraftOutputPayload(
    id: string,
    payload:
      | DraftCommentPayload
      | DraftFieldChangePayload
      | Record<string, unknown>,
    actorId?: string
  ): Promise<DraftOutput> {
    await this.ready;
    const draft = await this.requirePendingDraft(id);
    const serialized = JSON.stringify(payload);
    await this.db
      .update(workspaceDraftOutputs)
      .set({
        payload: serialized,
        // PILE-404 — the first human edit preserves the agent's original
        // payload so the diff (draft vs. what shipped) survives.
        originalPayload: draft.originalPayload ?? draft.payload,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(workspaceDraftOutputs.id, id));
    this.audit(
      "draft_output.updated",
      "draft_output",
      id,
      actorId ?? null,
      { payload: { from: draft.payload, to: serialized } },
      { actorType: "user" }
    );
    const updated = await this.getDraftOutput(id);
    if (!updated) throw new Error("Draft output vanished mid-update");
    return updated;
  }

  /** Publish = replay the held write through the same path the agent
   *  would have taken: comment drafts post via createComment (+ the usual
   *  comment.created fanout), field_change drafts replay through
   *  updateIssue. The audit row records both the producing agent
   *  (`producedBy`) and the publishing human (actorId). */
  async publishDraftOutput(
    id: string,
    reviewerId: string,
    note?: string
  ): Promise<DraftOutput> {
    await this.ready;
    const draft = await this.requirePendingDraft(id);
    const payload: unknown = JSON.parse(draft.payload);
    let publishedCommentId: string | null = null;
    if (draft.kind === "comment") {
      const p = payload as DraftCommentPayload;
      const comment = await this.createComment({
        entityType: draft.entityType,
        entityId: draft.entityId,
        issueId:
          draft.entityType === "issue"
            ? draft.entityId
            : (draft.issueId ?? undefined),
        authorId: p.authorId ?? undefined,
        body: p.body,
        internal: p.internal,
        mentions: p.mentions,
        externalId: p.externalId ?? undefined,
        externalSource: p.externalSource ?? undefined,
        externalAuthor: p.externalAuthor ?? undefined,
      });
      publishedCommentId = comment?.id ?? null;
      if (comment && draft.issueId) {
        const issue = await this.getIssue(draft.issueId);
        if (issue) {
          await this.emitCommentCreated(comment, issue, reviewerId);
        }
      }
    } else if (draft.kind === "field_change" && draft.entityType === "issue") {
      const p = payload as DraftFieldChangePayload;
      await this.updateIssue(draft.entityId, p.fields, reviewerId);
    }
    const ts = new Date().toISOString();
    await this.db
      .update(workspaceDraftOutputs)
      .set({
        status: "published",
        reviewedById: reviewerId,
        reviewedAt: ts,
        reviewNote: note ?? null,
        publishedCommentId,
        updatedAt: ts,
      })
      .where(eq(workspaceDraftOutputs.id, id));
    this.audit(
      "draft_output.published",
      "draft_output",
      id,
      reviewerId,
      {
        status: { from: "pending", to: "published" },
        producedBy: { from: null, to: draft.createdById },
        ...(publishedCommentId
          ? { publishedCommentId: { from: null, to: publishedCommentId } }
          : {}),
      },
      { actorType: "user" }
    );
    const updated = await this.getDraftOutput(id);
    if (!updated) throw new Error("Draft output vanished mid-update");
    return updated;
  }

  /** Discard keeps the row — rejected drafts are review history and the
   *  record of what the agent tried to say. */
  async discardDraftOutput(
    id: string,
    reviewerId: string,
    note?: string
  ): Promise<DraftOutput> {
    await this.ready;
    const draft = await this.requirePendingDraft(id);
    const ts = new Date().toISOString();
    await this.db
      .update(workspaceDraftOutputs)
      .set({
        status: "discarded",
        reviewedById: reviewerId,
        reviewedAt: ts,
        reviewNote: note ?? null,
        updatedAt: ts,
      })
      .where(eq(workspaceDraftOutputs.id, id));
    this.audit(
      "draft_output.discarded",
      "draft_output",
      id,
      reviewerId,
      {
        status: { from: "pending", to: "discarded" },
        producedBy: { from: null, to: draft.createdById },
        ...(note ? { reviewNote: { from: null, to: note } } : {}),
      },
      { actorType: "user" }
    );
    const updated = await this.getDraftOutput(id);
    if (!updated) throw new Error("Draft output vanished mid-update");
    return updated;
  }

  /** PILE-428 — lane-authored comments on sensitive issues are drafted
   *  for human review instead of posting; everywhere else they post and
   *  fan out exactly as before. */
  private async recordLaneComment(
    issue: Issue,
    values: {
      body: string;
      externalAuthor: string;
      externalSource: string;
      externalId: string;
    },
    session: AgentSession,
    actorId?: string
  ): Promise<void> {
    if (issue.sensitive) {
      await this.createDraftOutput({
        entityType: "issue",
        entityId: issue.id,
        issueId: issue.id,
        kind: "comment",
        payload: values,
        createdById: session.agentId,
        sessionId: session.id,
      });
      return;
    }
    const comment = await this.createComment({ issueId: issue.id, ...values });
    if (comment) {
      await this.emitCommentCreated(comment, issue, actorId);
    }
  }

  async listWorkspaceComments() {
    await this.ready;
    return this.db.select().from(workspaceComments).all();
  }

  // Recipients live partly in the registry (memberships, GitHub/user
  // mappings) and partly in workspace tables (subscribers, linear_users).
  // `assigneeUserId` lets a caller that already resolved issue.assigneeId
  // skip the repeat lookup.
  private async resolveIssueRecipients(
    issue: { id: string; assigneeId: string | null },
    excludeRecipientId?: string,
    extraExcludeRecipientId?: string,
    assigneeUserId?: string | null
  ): Promise<string[]> {
    const [assignee, subscriberUserIds] = await Promise.all([
      assigneeUserId !== undefined
        ? assigneeUserId
        : this.resolveAssigneeUserId(issue.assigneeId),
      this.resolveSubscriberUserIds(issue.id),
    ]);
    const recipients = new Set<string>(subscriberUserIds);
    if (assignee) {
      recipients.add(assignee);
    }
    if (excludeRecipientId) {
      recipients.delete(excludeRecipientId);
    }
    if (extraExcludeRecipientId) {
      recipients.delete(extraExcludeRecipientId);
    }
    return [...recipients];
  }

  private async resolveSubscriberUserIds(issueId: string): Promise<string[]> {
    const subscribers = await this.db
      .select({ linearUserId: workspaceSubscriptions.userId })
      .from(workspaceSubscriptions)
      .where(
        and(
          eq(workspaceSubscriptions.entityType, "issue"),
          eq(workspaceSubscriptions.entityId, issueId)
        )
      )
      .all();
    if (subscribers.length === 0) return [];
    const linearIds = subscribers.map((sub) => sub.linearUserId);
    const linearRows = await this.db
      .select({ email: workspaceLinearUsers.email })
      .from(workspaceLinearUsers)
      .where(inArray(workspaceLinearUsers.linearId, linearIds))
      .all();
    const emails = linearRows
      .map((row) => row.email)
      .filter(
        (email): email is string =>
          typeof email === "string" && email.length > 0
      );
    if (emails.length === 0) return [];
    const matchedUsers = await createD1(this.env.D1)
      .select({ id: globalUser.id })
      .from(globalUser)
      .where(inArray(globalUser.email, emails))
      .all();
    return matchedUsers.map((matchedUser) => matchedUser.id);
  }

  // Webhook syncs write with machine actors ("gitlab"/"github"/
  // undefined) — those can't mass-email real users on assign. Only a
  // workspace-member actor triggers the directed notify. Importers run as
  // the importing member, so they suppress via options.notify instead.
  private async isMemberActor(actorId?: string): Promise<boolean> {
    if (!actorId) return false;
    const d1 = createD1(this.env.D1);
    const membership = await getWorkspaceMembership(
      d1,
      this.organizationId,
      actorId
    );
    return Boolean(membership);
  }

  // assigneeId may be a user id, a GitHub login, or a Linear id — resolve
  // to the workspace user id so directed notifications and exclusions use
  // the same identity as the recipients fan-out.
  private async resolveAssigneeUserId(
    assigneeId: string | null
  ): Promise<string | null> {
    if (!assigneeId) return null;
    const d1 = createD1(this.env.D1);
    const org = this.organizationId;
    // The candidate lookups are independent — run them in one round trip
    // and keep the original precedence (member → GitHub → Linear).
    const [membership, github, linear] = await Promise.all([
      getWorkspaceMembership(d1, org, assigneeId),
      d1
        .select({ userId: githubUsers.userId })
        .from(githubUsers)
        .where(
          and(
            eq(githubUsers.organizationId, org),
            eq(githubUsers.githubLogin, assigneeId)
          )
        )
        .get(),
      this.db
        .select({ email: workspaceLinearUsers.email })
        .from(workspaceLinearUsers)
        .where(
          and(
            eq(workspaceLinearUsers.organizationId, org),
            eq(workspaceLinearUsers.linearId, assigneeId)
          )
        )
        .get(),
    ]);
    if (membership) return assigneeId;
    if (github) return github.userId;
    if (!linear?.email) return null;
    const matchedUser = await d1
      .select({ id: globalUser.id })
      .from(globalUser)
      .where(eq(globalUser.email, linear.email))
      .get();
    return matchedUser?.id ?? null;
  }

  // Types a member should hear about even before they touch notification
  // prefs — each one means "a human needs you", not background chatter.
  private static EMAIL_BY_DEFAULT_TYPES = new Set<data.NotificationType>([
    "issue_assigned",
    "mention",
    "lane_needs_input",
    "lane_elicitation_escalated",
    // A pending agent draft is the same "needs a human" signal as a lane
    // waiting on input — email by default (PILE-428).
    "draft_pending",
  ]);

  // Single notification path: preference-gated in-app row + email fanout.
  // `options.issue` lets callers that already loaded the subject pass it
  // through so the email path doesn't re-fetch; `options.email === false`
  // suppresses only the email leg (batch updates still write in-app rows);
  // `options.linkIssue === false` keeps the subject's title/identifier in
  // the email but drops the link (issue_deleted — it would 404).
  private async deliverNotification(
    input: Omit<data.NotificationInput, "organizationId">,
    options?: { email?: boolean; issue?: Issue; linkIssue?: boolean }
  ): Promise<void> {
    const prefs = data.getNotificationPreferences(
      this.db,
      this.organizationId,
      input.recipientId
    );
    const muted = prefs?.mutedTypes?.split(",") ?? [];
    if (muted.includes(input.type)) return;
    if (!prefs || prefs.inApp) {
      await data.createNotification(this.db, {
        ...input,
        organizationId: this.organizationId,
      });
    }
    // No explicit choice: email defaults on for high-signal types
    // (assigned an issue, @mentioned, a lane needs you) — a member who
    // never visits the prefs page still hears about the things that need
    // them. An explicit email pref always wins; a prefs row written
    // without touching email (emailExplicit false) keeps the default.
    const wantsEmail =
      options?.email !== false &&
      (prefs?.emailExplicit
        ? Boolean(prefs.email)
        : WorkspaceDO.EMAIL_BY_DEFAULT_TYPES.has(input.type));
    const emailFrom = this.env.EMAIL_FROM;
    if (wantsEmail && this.env.EMAIL && emailFrom) {
      // PILE-330 — a stalled provider send used to sit on the mutation's
      // critical path: PATCHes timed out (~40s) and the DO's uncommitted
      // write rolled back. Email is best-effort; it runs in waitUntil so a
      // slow/hung provider can never block or lose the write.
      const task = this.sendNotificationEmail(
        input,
        this.env.EMAIL,
        emailFrom,
        options
      ).catch((err: unknown) => {
        console.warn(
          `notification email failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      this.pendingEmailTasks.add(task);
      void task.finally(() => this.pendingEmailTasks.delete(task));
      this.ctx.waitUntil(task);
    }
  }

  private readonly pendingEmailTasks = new Set<Promise<void>>();

  // Resolves once every in-flight notification email settles — the seam
  // tests use to assert deferred sends deterministically.
  async flushNotificationEmails(): Promise<void> {
    const batch = [...this.pendingEmailTasks];
    if (batch.length === 0) return;
    await Promise.allSettled(batch);
    // Sends can enqueue follow-ups; re-drain until the set is empty.
    await this.flushNotificationEmails();
  }

  private async sendNotificationEmail(
    input: Omit<data.NotificationInput, "organizationId">,
    emailBinding: SendEmail,
    emailFrom: string,
    options?: { issue?: Issue; linkIssue?: boolean }
  ): Promise<void> {
    const d1 = createD1(this.env.D1);
    const recipient = await d1
      .select({ email: globalUser.email })
      .from(globalUser)
      .where(eq(globalUser.id, input.recipientId))
      .get();
    if (!recipient?.email) return;
    const typeLabel = input.type.replace(/_/g, " ");
    // metadata.documentId marks a document-scoped notification — for
    // comments/mentions input.issueId holds the document id, for
    // document_updated it holds a linked issue. Either way the email
    // should name and link the document, not the related issue.
    const documentId =
      typeof input.metadata?.documentId === "string"
        ? input.metadata.documentId
        : null;
    const doc = documentId === null ? null : await this.getDocument(documentId);
    let subject = `Pile: ${typeLabel}`;
    let text = `You have a new ${typeLabel} notification in workspace ${this.organizationId}.\n`;
    // BETTER_AUTH_URL is the product origin — PUBLIC_API_URL is the
    // agent-callback API origin and may not serve the UI.
    const origin = this.env.BETTER_AUTH_URL;
    if (doc) {
      subject = `Pile: ${doc.title} ${typeLabel}`;
      const link =
        options?.linkIssue === false
          ? ""
          : `${origin}/${this.organizationId}/documents/${doc.id}\n`;
      text = `${doc.title}\n\n${text}${link}`;
    } else {
      const issue = options?.issue ?? (await this.getIssue(input.issueId));
      if (issue) {
        const link =
          options?.linkIssue === false
            ? ""
            : `${origin}/${this.organizationId}/issues/${issue.identifier ?? issue.id}\n`;
        subject = issue.identifier
          ? `Pile: ${issue.identifier} ${typeLabel}`
          : subject;
        // A bulk assign emails only the first id's issue — say how many
        // the batch moved so the recipient knows it's not just this one.
        const batchSize =
          input.type === "issue_assigned" &&
          typeof input.metadata?.batchSize === "number"
            ? input.metadata.batchSize
            : 0;
        const more =
          batchSize > 1
            ? `+${batchSize - 1} more issue${batchSize === 2 ? "" : "s"} assigned in this update\n`
            : "";
        text = `${issue.identifier ? `${issue.identifier}: ` : ""}${issue.title}\n\n${text}${more}${link}`;
      }
    }
    await sendEmail(
      this.env,
      {
        from: emailFrom,
        to: recipient.email,
        subject,
        text,
      },
      emailBinding
    );
  }

  private async notifyIssueEvent(
    issue: Issue,
    type: data.NotificationType,
    actorId?: string,
    extraExcludeRecipientId?: string,
    assigneeUserId?: string | null,
    options?: { email?: boolean; linkIssue?: boolean }
  ): Promise<void> {
    const recipients = await this.resolveIssueRecipients(
      issue,
      actorId,
      extraExcludeRecipientId,
      assigneeUserId
    );
    await Promise.all(
      recipients.map(async (recipientId) => {
        await this.deliverNotification(
          {
            recipientId,
            recipientType: "user",
            issueId: issue.id,
            type,
          },
          { email: options?.email, issue, linkIssue: options?.linkIssue }
        );
      })
    );
  }

  // ---- notification preferences ----
  getNotificationPreferences(userId: string) {
    return data.getNotificationPreferences(
      this.db,
      this.organizationId,
      userId
    );
  }

  upsertNotificationPreferences(
    userId: string,
    input: data.NotificationPreferenceInput
  ) {
    return data.upsertNotificationPreferences(
      this.db,
      this.organizationId,
      userId,
      input
    );
  }

  // ---- notifications ----
  createNotification(input: Omit<data.NotificationInput, "organizationId">) {
    return this.deliverNotification(input);
  }

  listNotificationsForRecipient(
    recipientId: string,
    recipientType: data.RecipientType,
    options: {
      unreadOnly?: boolean;
      snoozedOnly?: boolean;
      includeSnoozed?: boolean;
      limit?: number;
    } = {},
    viewer?: IssueViewer
  ) {
    return data.getNotificationsForRecipient(
      this.db,
      this.organizationId,
      recipientId,
      recipientType,
      {
        ...options,
        excludeIssueCondition: this.hiddenIssueConditionFor(
          viewer,
          workspaceNotifications.issueId
        ),
      }
    );
  }

  unreadNotificationCount(
    recipientId: string,
    recipientType: data.RecipientType,
    viewer?: IssueViewer
  ) {
    return data.getUnreadNotificationCount(
      this.db,
      this.organizationId,
      recipientId,
      recipientType,
      this.hiddenIssueConditionFor(viewer, workspaceNotifications.issueId)
    );
  }

  markNotificationRead(
    recipientId: string,
    recipientType: data.RecipientType,
    notificationId: string
  ) {
    return data.markNotificationRead(
      this.db,
      this.organizationId,
      recipientId,
      recipientType,
      notificationId
    );
  }

  markNotificationUnread(
    recipientId: string,
    recipientType: data.RecipientType,
    notificationId: string
  ) {
    return data.markNotificationUnread(
      this.db,
      this.organizationId,
      recipientId,
      recipientType,
      notificationId
    );
  }

  snoozeNotification(
    recipientId: string,
    recipientType: data.RecipientType,
    notificationId: string,
    until: string | null
  ) {
    return data.snoozeNotification(
      this.db,
      this.organizationId,
      recipientId,
      recipientType,
      notificationId,
      until
    );
  }

  markAllNotificationsRead(
    recipientId: string,
    recipientType: data.RecipientType
  ) {
    return data.markAllNotificationsRead(
      this.db,
      this.organizationId,
      recipientId,
      recipientType
    );
  }

  listWorkspaceNotifications() {
    return this.db.select().from(workspaceNotifications).all();
  }

  // ---- issue subscribers ----
  listIssueSubscribers(issueId: string) {
    return data.listIssueSubscribers(this.db, this.organizationId, issueId);
  }

  getIssueSubscriber(id: string) {
    return data.getIssueSubscriber(this.db, this.organizationId, id);
  }

  createIssueSubscriber(values: { issueId: string; linearUserId: string }) {
    return data.createIssueSubscriber(this.db, this.organizationId, values);
  }

  deleteIssueSubscriber(id: string) {
    return data.deleteIssueSubscriber(this.db, this.organizationId, id);
  }

  listWorkspaceIssueSubscribers() {
    return this.db
      .select()
      .from(workspaceSubscriptions)
      .where(eq(workspaceSubscriptions.entityType, "issue"))
      .all();
  }

  // ---- issue relations ----
  listIssueRelations(fromIssueId: string) {
    return data.listIssueRelations(this.db, this.organizationId, fromIssueId);
  }

  listInverseIssueRelations(toIssueId: string) {
    return data.listInverseIssueRelations(
      this.db,
      this.organizationId,
      toIssueId
    );
  }

  getIssueRelation(id: string) {
    return data.getIssueRelation(this.db, this.organizationId, id);
  }

  createIssueRelation(values: {
    fromIssueId: string;
    toIssueId: string;
    type: string;
  }) {
    return data.createIssueRelation(this.db, this.organizationId, values);
  }

  deleteIssueRelation(id: string) {
    return data.deleteIssueRelation(this.db, this.organizationId, id);
  }

  listWorkspaceIssueRelations() {
    return this.db
      .select()
      .from(workspaceEntityLinks)
      .where(
        and(
          eq(workspaceEntityLinks.organizationId, this.organizationId),
          eq(workspaceEntityLinks.fromType, "issue"),
          eq(workspaceEntityLinks.toType, "issue")
        )
      )
      .all();
  }

  // ---- issue approvals ----
  listIssueApprovals(issueId: string) {
    return data.listIssueApprovals(this.db, this.organizationId, issueId);
  }

  getIssueApproval(id: string) {
    return data.getIssueApproval(this.db, this.organizationId, id);
  }

  createIssueApproval(input: {
    issueId: string;
    requestedById: string;
    approverId: string;
    comment?: string;
  }) {
    return data.createIssueApproval(this.db, this.organizationId, input);
  }

  resolveIssueApproval(id: string, status: "approved" | "rejected") {
    return data.resolveIssueApproval(this.db, this.organizationId, id, status);
  }

  listWorkspaceIssueApprovals() {
    return this.db.select().from(workspaceIssueApprovals).all();
  }

  // ---- reactions ----
  createReaction(input: {
    targetType: string;
    targetId: string;
    actorId: string;
    emoji: string;
  }) {
    return data.createReaction(this.db, {
      ...input,
      organizationId: this.organizationId,
    });
  }

  listReactions(targetType: string, targetId: string) {
    return data.listReactions(
      this.db,
      this.organizationId,
      targetType,
      targetId
    );
  }

  getReaction(id: string) {
    return data.getReaction(this.db, this.organizationId, id);
  }

  deleteReaction(id: string) {
    return data.deleteReaction(this.db, this.organizationId, id);
  }

  listWorkspaceReactions() {
    return this.db.select().from(workspaceReactions).all();
  }

  // ---- attachments ----
  listAttachments(issueId: string) {
    return data.listAttachments(this.db, this.organizationId, issueId);
  }

  getAttachment(id: string) {
    return data.getAttachment(this.db, this.organizationId, id);
  }

  createAttachment(values: {
    issueId: string;
    linearId: string;
    url: string;
    title?: string | null;
    subtitle?: string | null;
    r2Key?: string | null;
    createdAt?: string;
  }) {
    return data.createAttachment(this.db, this.organizationId, values);
  }

  setAttachmentR2Key(id: string, r2Key: string) {
    return data.setAttachmentR2Key(this.db, this.organizationId, id, r2Key);
  }

  deleteAttachment(id: string) {
    return data.deleteAttachment(this.db, this.organizationId, id);
  }

  listWorkspaceAttachments() {
    return this.db.select().from(workspaceAttachments).all();
  }

  // ---- deals ----
  createDeal(
    input: Omit<data.DealInput, "organizationId"> & {
      customFields?: Record<string, string | null>;
    }
  ) {
    const { customFields, ...dealInput } = input;
    const deal = data.createDeal(this.db, {
      ...dealInput,
      organizationId: this.organizationId,
    });
    // Runs on the dedupe-return path too — a replayed create still gets
    // its field values applied to the existing record.
    this.applyCustomFields("deal", deal.id, customFields);
    this.audit("deal.created", "deal", deal.id);
    return this.withEntityFields("deal", deal);
  }

  listDeals(opts?: {
    includeArchived?: boolean;
    stage?: data.DealStage;
    dueBefore?: string;
    cold?: boolean;
    needsHuman?: boolean;
  }) {
    return this.withEntityFieldsList(
      "deal",
      data.listDeals(this.db, this.organizationId, opts)
    );
  }

  getDeal(id: string) {
    const deal = data.getDeal(this.db, this.organizationId, id);
    return deal ? this.withEntityFields("deal", deal) : undefined;
  }

  getDealByExternalId(externalId: string) {
    const deal = data.getDealByExternalId(
      this.db,
      this.organizationId,
      externalId
    );
    return deal ? this.withEntityFields("deal", deal) : undefined;
  }

  async updateDeal(
    id: string,
    patch: Partial<Omit<data.DealInput, "organizationId" | "contactIds">> & {
      contactIds?: string[];
      archivedAt?: string | null;
      customFields?: Record<string, string | null>;
      // PILE-412 — admin stage-gate override (the API refuses it for
      // non-admins); the reason is required and lands in audit + history.
      stageGateOverride?: { reason: string };
    },
    actorId?: string
  ) {
    const { customFields, ...dealPatch } = patch;
    const before = data.getDeal(this.db, this.organizationId, id);
    if (!before) return undefined;
    if (
      patch.stageGateOverride !== undefined &&
      !patch.stageGateOverride.reason
    ) {
      throw VortexError.fromCode(
        "BAD_REQUEST",
        "stageGateOverride requires a non-empty reason"
      );
    }
    // PILE-412 — leaving the deal's stage is refused while a linked parent
    // issue still has open required sub-steps.
    let gateOverride:
      | { reason: string; blocked: { parent: Issue; steps: Issue[] }[] }
      | undefined;
    if (patch.stage !== undefined && patch.stage !== before.stage) {
      const blocked = await this.blockingSubStepParents(
        await this.linkedParentIssues("deal", id)
      );
      if (blocked.length > 0) {
        if (!patch.stageGateOverride) {
          throw stageGateConflict(blocked);
        }
        gateOverride = { reason: patch.stageGateOverride.reason, blocked };
      }
    }
    const deal = data.updateDeal(this.db, this.organizationId, id, dealPatch);
    if (!deal) return undefined;
    this.applyCustomFields("deal", id, customFields);
    this.audit("deal.updated", "deal", id, actorId);
    if (gateOverride) {
      const transition = {
        field: "stage",
        from: before.stage,
        to: deal.stage,
      };
      for (const { parent, steps } of gateOverride.blocked) {
        await this.recordStageGateOverride(
          parent,
          steps,
          gateOverride.reason,
          actorId,
          transition
        );
      }
    }
    // PILE-411 — entering a templated stage materializes sub-steps under the
    // deal's linked parent issues.
    if (dealPatch.stage !== undefined && deal.stage !== before.stage) {
      await this.applyStageTemplates(
        "deal",
        deal.stage,
        deal,
        await this.linkedParentIssues("deal", deal.id),
        actorId
      );
    }
    // PILE-401 — the stage-entered event drives stage-owner dispatch +
    // downstream stage policy in the worker drainer.
    if (dealPatch.stage !== undefined && deal.stage !== before.stage) {
      await this.emitDomainEvent(
        "record.stage_entered",
        {
          entityType: "deal",
          entityId: deal.id,
          from: before.stage,
          to: deal.stage,
        },
        `stage:${deal.id}:${deal.stage}`
      );
    }
    return this.withEntityFields("deal", deal);
  }

  linkDealIssue(dealId: string, issueId: string) {
    data.linkDealIssue(this.db, this.organizationId, dealId, issueId);
    return { ok: true };
  }

  unlinkDealIssue(dealId: string, issueId: string) {
    data.unlinkDealIssue(this.db, dealId, issueId);
    return { ok: true };
  }

  listDealIssueIds(dealId: string) {
    return data.listDealIssueIds(this.db, dealId);
  }

  listDealsForIssue(issueId: string) {
    return this.withEntityFieldsList(
      "deal",
      data.listDealsForIssue(this.db, this.organizationId, issueId)
    );
  }

  deleteDeal(id: string, actorId?: string) {
    const ok = data.deleteDeal(this.db, this.organizationId, id);
    if (ok) this.audit("deal.deleted", "deal", id, actorId);
    return ok;
  }

  // ---- entity links — the graph ----
  linkEntities(input: Omit<data.EntityLinkInput, "organizationId">) {
    return data.linkEntities(this.db, {
      ...input,
      organizationId: this.organizationId,
    });
  }

  unlinkEntities(id: string) {
    return data.unlinkEntities(this.db, this.organizationId, id);
  }

  listEntityLinks(type: string, id: string) {
    return data.listEntityLinks(this.db, this.organizationId, type, id);
  }

  // ---- custom fields ----
  createFieldDefinition(
    input: Omit<data.FieldDefinitionInput, "organizationId">
  ) {
    return data.createFieldDefinition(this.db, {
      ...input,
      organizationId: this.organizationId,
    });
  }

  listFieldDefinitions(entityType?: string) {
    return data.listFieldDefinitions(this.db, this.organizationId, entityType);
  }

  deleteFieldDefinition(id: string) {
    return data.deleteFieldDefinition(this.db, this.organizationId, id);
  }

  setFieldValue(fieldId: string, entityId: string, value: string | null) {
    data.setFieldValue(this.db, this.organizationId, fieldId, entityId, value);
    return { ok: true };
  }

  listFieldValues(entityId: string) {
    return data.listFieldValues(this.db, this.organizationId, entityId);
  }

  // ---- entity attachments (R2-backed, scoped to entityType + entityId) ----
  listEntityAttachments(entityType: string, entityId: string) {
    return data.listEntityAttachments(
      this.db,
      this.organizationId,
      entityType,
      entityId
    );
  }

  getEntityAttachment(id: string) {
    return data.getEntityAttachment(this.db, this.organizationId, id);
  }

  async storeEntityAttachment(input: {
    entityType: string;
    entityId: string;
    fileName: string;
    contentType?: string;
    dataBase64: string;
    createdById?: string;
  }) {
    const bucket = this.env.ATTACHMENTS_BUCKET;
    if (!bucket) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 503,
        message: "File storage not configured",
      });
    }
    const id = crypto.randomUUID();
    const contentType = input.contentType ?? "application/octet-stream";
    const bytes = new Uint8Array(
      Array.from(atob(input.dataBase64), (char) => char.charCodeAt(0))
    );
    const r2Key = `attachments/${this.organizationId}/${input.entityType}/${input.entityId}/${id}`;
    await bucket.put(r2Key, bytes, { httpMetadata: { contentType } });
    return data.createEntityAttachment(this.db, this.organizationId, {
      id,
      entityType: input.entityType,
      entityId: input.entityId,
      fileName: input.fileName,
      contentType,
      size: bytes.length,
      r2Key,
      createdById: input.createdById,
    });
  }

  async deleteEntityAttachment(id: string) {
    const row = data.deleteEntityAttachment(this.db, this.organizationId, id);
    if (row && this.env.ATTACHMENTS_BUCKET) {
      await this.env.ATTACHMENTS_BUCKET.delete(row.r2Key);
    }
    return row;
  }

  // ---- saved views / favorites / prefs ----
  createSavedView(input: Omit<data.SavedViewInput, "organizationId">) {
    return data.createSavedView(this.db, {
      ...input,
      organizationId: this.organizationId,
    });
  }

  listSavedViews(userId?: string) {
    return data.listSavedViews(this.db, this.organizationId, userId);
  }

  getSavedView(id: string) {
    return data.getSavedView(this.db, id, this.organizationId);
  }

  updateSavedView(id: string, update: data.SavedViewUpdate) {
    return data.updateSavedView(this.db, id, this.organizationId, update);
  }

  deleteSavedView(id: string) {
    return data.deleteSavedView(this.db, id, this.organizationId);
  }

  favoriteView(viewId: string, userId: string) {
    return data.favoriteView(this.db, this.organizationId, viewId, userId);
  }

  unfavoriteView(viewId: string, userId: string) {
    return data.unfavoriteView(this.db, viewId, userId);
  }

  listFavoriteViewIds(userId: string) {
    return data.listFavoriteViewIds(this.db, this.organizationId, userId);
  }

  getUserViewPreferences(userId: string) {
    return data.getUserViewPreferences(this.db, this.organizationId, userId);
  }

  // ---- documents ----
  async createDocument(input: Omit<data.DocumentInput, "organizationId">) {
    // Insert and extracted links commit atomically so a link-sync failure
    // cannot leave an orphaned document that a retry would duplicate.
    const doc = this.ctx.storage.transactionSync(() => {
      const created = data.createDocument(this.db, {
        ...input,
        organizationId: this.organizationId,
      });
      this.syncDocumentLinks(
        created.id,
        created.content,
        created.contentFormat
      );
      return created;
    });
    this.audit("document.created", "document", doc.id, input.createdById);
    if (this.searchIndex) {
      await indexDocumentSearchDocument(this.searchIndex, doc);
    }
    await this.emit({
      type: "document.updated",
      organizationId: this.organizationId,
      documentId: doc.id,
    });
    return doc;
  }

  listDocuments(args: data.ListDocumentsArgs = {}) {
    return data.listDocuments(this.db, this.organizationId, args);
  }

  getDocument(id: string) {
    return data.getDocument(this.db, this.organizationId, id);
  }

  async updateDocument(
    id: string,
    update: data.DocumentUpdate,
    actorId: string
  ) {
    const doc = this.ctx.storage.transactionSync(() => {
      const updated = data.updateDocument(
        this.db,
        this.organizationId,
        id,
        update,
        actorId
      );
      if (updated && update.content !== undefined) {
        this.syncDocumentLinks(id, updated.content, updated.contentFormat);
      }
      return updated;
    });
    if (doc) {
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const [key, value] of Object.entries(update)) {
        if (key === "content") {
          changes.content = { from: null, to: "<updated>" };
        } else {
          changes[key] = { from: null, to: value };
        }
      }
      this.audit("document.updated", "document", id, actorId, changes);
      if (this.searchIndex) {
        await indexDocumentSearchDocument(this.searchIndex, doc);
      }
      await Promise.all(
        data.listDocumentWatchers(this.db, id).map(async (watcherId) => {
          if (watcherId === actorId) return;
          await this.deliverNotification({
            recipientId: watcherId,
            recipientType: "user",
            issueId: doc.issueId ?? doc.id,
            type: "document_updated",
            metadata: { documentId: doc.id },
          });
        })
      );
      await this.emit({
        type: "document.updated",
        organizationId: this.organizationId,
        documentId: doc.id,
      });
    }
    return doc;
  }

  async deleteDocument(id: string, actorId?: string) {
    const deleted = data.deleteDocument(this.db, this.organizationId, id);
    if (deleted) {
      this.audit("document.deleted", "document", id, actorId);
      if (this.searchIndex) {
        const { remove } = await import("@orama/orama");
        try {
          await remove(this.searchIndex, id);
        } catch {
          // Not indexed; ignore.
        }
      }
      await this.emit({
        type: "document.deleted",
        organizationId: this.organizationId,
        documentId: id,
      });
    }
    return deleted;
  }

  listDocumentHistory(documentId: string) {
    return data.listDocumentHistory(this.db, this.organizationId, documentId);
  }

  async restoreDocumentVersion(
    documentId: string,
    entryId: string,
    actorId: string
  ) {
    const entry = data.getDocumentHistoryEntry(
      this.db,
      this.organizationId,
      documentId,
      entryId
    );
    if (!entry) return undefined;
    const doc = await this.updateDocument(
      documentId,
      {
        content: entry.content,
        contentFormat: entry.contentFormat,
      },
      actorId
    );
    if (doc) {
      this.audit("document.restored", "document", documentId, actorId, {
        historyEntryId: { from: null, to: entryId },
      });
    }
    return doc;
  }

  // ---- time schedules ----

  listTimeSchedules() {
    return data.listTimeSchedules(this.db, this.organizationId);
  }

  getTimeSchedule(id: string) {
    return data.getTimeSchedule(this.db, this.organizationId, id);
  }

  async createTimeSchedule(input: data.TimeScheduleInput, actorId?: string) {
    const ts = await data.createTimeSchedule(
      this.db,
      this.organizationId,
      input
    );
    if (ts)
      this.audit("time_schedule.created", "time_schedule", ts.id, actorId);
    return ts;
  }

  async updateTimeSchedule(
    id: string,
    input: Partial<data.TimeScheduleInput>,
    actorId?: string
  ) {
    const ts = await data.updateTimeSchedule(
      this.db,
      this.organizationId,
      id,
      input
    );
    if (ts) this.audit("time_schedule.updated", "time_schedule", id, actorId);
    return ts;
  }

  async deleteTimeSchedule(id: string, actorId?: string) {
    const ok = await data.deleteTimeSchedule(this.db, this.organizationId, id);
    if (ok) this.audit("time_schedule.deleted", "time_schedule", id, actorId);
    return ok;
  }

  // ---- git automation ----

  listGitAutomationStates() {
    return data.listGitAutomationStates(this.db, this.organizationId);
  }

  getGitAutomationState(id: string) {
    return data.getGitAutomationState(this.db, this.organizationId, id);
  }

  async createGitAutomationState(
    input: data.GitAutomationStateInput,
    actorId?: string
  ) {
    const state = await data.createGitAutomationState(
      this.db,
      this.organizationId,
      input
    );
    if (state)
      this.audit(
        "git_automation_state.created",
        "git_automation_state",
        state.id,
        actorId
      );
    return state;
  }

  async updateGitAutomationState(
    id: string,
    input: Partial<data.GitAutomationStateInput>,
    actorId?: string
  ) {
    const state = await data.updateGitAutomationState(
      this.db,
      this.organizationId,
      id,
      input
    );
    if (state)
      this.audit(
        "git_automation_state.updated",
        "git_automation_state",
        state.id,
        actorId
      );
    return state;
  }

  async deleteGitAutomationState(id: string, actorId?: string) {
    const existing = await data.getGitAutomationState(
      this.db,
      this.organizationId,
      id
    );
    const ok = await data.deleteGitAutomationState(
      this.db,
      this.organizationId,
      id
    );
    if (ok && existing)
      this.audit(
        "git_automation_state.deleted",
        "git_automation_state",
        existing.id,
        actorId
      );
    return ok;
  }

  listGitAutomationTargetBranches() {
    return data.listGitAutomationTargetBranches(this.db, this.organizationId);
  }

  getGitAutomationTargetBranch(id: string) {
    return data.getGitAutomationTargetBranch(this.db, this.organizationId, id);
  }

  async createGitAutomationTargetBranch(
    input: data.GitAutomationTargetBranchInput,
    actorId?: string
  ) {
    const branch = await data.createGitAutomationTargetBranch(
      this.db,
      this.organizationId,
      input
    );
    if (branch)
      this.audit(
        "git_automation_target_branch.created",
        "git_automation_target_branch",
        branch.id,
        actorId
      );
    return branch;
  }

  async updateGitAutomationTargetBranch(
    id: string,
    input: Partial<data.GitAutomationTargetBranchInput>,
    actorId?: string
  ) {
    const branch = await data.updateGitAutomationTargetBranch(
      this.db,
      this.organizationId,
      id,
      input
    );
    if (branch)
      this.audit(
        "git_automation_target_branch.updated",
        "git_automation_target_branch",
        branch.id,
        actorId
      );
    return branch;
  }

  async deleteGitAutomationTargetBranch(id: string, actorId?: string) {
    const existing = await data.getGitAutomationTargetBranch(
      this.db,
      this.organizationId,
      id
    );
    const ok = await data.deleteGitAutomationTargetBranch(
      this.db,
      this.organizationId,
      id
    );
    if (ok && existing)
      this.audit(
        "git_automation_target_branch.deleted",
        "git_automation_target_branch",
        existing.id,
        actorId
      );
    return ok;
  }

  // ---- issue external links ----

  listExternalLinks(
    args: { entityType?: string; entityId?: string } = {},
    viewer?: IssueViewer
  ) {
    return data.listExternalLinks(this.db, this.organizationId, {
      ...args,
      excludeIssueCondition: this.hiddenIssueConditionFor(
        viewer,
        externalLinks.entityId
      ),
    });
  }

  getExternalLink(id: string) {
    return data.getExternalLink(this.db, this.organizationId, id);
  }

  async createExternalLink(input: data.ExternalLinkInput, actorId?: string) {
    const link = await data.createExternalLink(
      this.db,
      this.organizationId,
      input
    );
    if (link)
      this.audit(
        "external_link.created",
        input.entityType,
        input.entityId,
        actorId
      );
    return link;
  }

  async updateExternalLink(
    id: string,
    input: {
      url?: string;
      label?: string | null;
      verification?: data.ExternalLinkVerification;
    },
    actorId?: string
  ) {
    const link = await data.updateExternalLink(
      this.db,
      this.organizationId,
      id,
      input
    );
    if (link)
      this.audit(
        "external_link.updated",
        link.entityType,
        link.entityId,
        actorId
      );
    return link;
  }

  async deleteExternalLink(id: string, actorId?: string) {
    const existing = await data.getExternalLink(
      this.db,
      this.organizationId,
      id
    );
    const ok = await data.deleteExternalLink(this.db, this.organizationId, id);
    if (ok && existing)
      this.audit(
        "external_link.deleted",
        existing.entityType,
        existing.entityId,
        actorId
      );
    return ok;
  }

  // ---- customers ----
  /** Name-keyed custom field values folded onto entity records — the
   *  API/MCP surface speaks field names ("processor", "batch_week"), not
   *  definition uuids (PILE-383). */
  private withEntityFields<T extends { id: string }>(
    entityType: string,
    record: T
  ): T & { customFields: Record<string, string> } {
    return {
      ...record,
      customFields: data.customFieldMap(
        this.db,
        this.organizationId,
        entityType,
        record.id
      ),
    };
  }

  private withEntityFieldsList<T extends { id: string }>(
    entityType: string,
    records: T[]
  ): Array<T & { customFields: Record<string, string> }> {
    const maps = data.customFieldMaps(
      this.db,
      this.organizationId,
      entityType,
      records.map((r) => r.id)
    );
    return records.map((r) => ({
      ...r,
      customFields: maps.get(r.id) ?? {},
    }));
  }

  private applyCustomFields(
    entityType: string,
    entityId: string,
    fields: Record<string, string | null> | undefined
  ) {
    if (!fields || Object.keys(fields).length === 0) return;
    try {
      data.setFieldValuesByName(
        this.db,
        this.organizationId,
        entityType,
        entityId,
        fields
      );
    } catch (error) {
      if (error instanceof data.FieldValueError) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: error.message,
        });
      }
      throw error;
    }
  }

  createCustomer(
    input: Omit<data.CustomerInput, "organizationId"> & {
      customFields?: Record<string, string | null>;
    }
  ) {
    const { customFields, ...customerInput } = input;
    const customer = data.createCustomer(this.db, {
      ...customerInput,
      organizationId: this.organizationId,
    });
    // Runs on the dedupe-return path too — a replayed create still gets
    // its field values applied to the existing record.
    this.applyCustomFields("customer", customer.id, customFields);
    this.audit("customer.created", "customer", customer.id, input.ownerId);
    return this.withEntityFields("customer", customer);
  }

  listCustomers(opts?: {
    cold?: boolean;
    dueBefore?: string;
    needsHuman?: boolean;
  }) {
    return this.withEntityFieldsList(
      "customer",
      data.listCustomers(this.db, this.organizationId, opts)
    );
  }

  getCustomerByDomain(domain: string) {
    const customer = data.getCustomerByDomain(
      this.db,
      this.organizationId,
      domain
    );
    return customer ? this.withEntityFields("customer", customer) : undefined;
  }

  getCustomerByExternalId(externalId: string) {
    const customer = data.getCustomerByExternalId(
      this.db,
      this.organizationId,
      externalId
    );
    return customer ? this.withEntityFields("customer", customer) : undefined;
  }

  getCustomer(id: string) {
    const customer = data.getCustomer(this.db, this.organizationId, id);
    return customer ? this.withEntityFields("customer", customer) : undefined;
  }

  async updateCustomer(
    id: string,
    patch: Partial<Omit<data.CustomerInput, "organizationId">> & {
      customFields?: Record<string, string | null>;
      // PILE-412 — admin stage-gate override (the API refuses it for
      // non-admins); the reason is required and lands in audit + history.
      stageGateOverride?: { reason: string };
    },
    actorId?: string
  ) {
    const { customFields, ...customerPatch } = patch;
    const before = data.getCustomer(this.db, this.organizationId, id);
    if (!before) return undefined;
    if (
      patch.stageGateOverride !== undefined &&
      !patch.stageGateOverride.reason
    ) {
      throw VortexError.fromCode(
        "BAD_REQUEST",
        "stageGateOverride requires a non-empty reason"
      );
    }
    // PILE-412 — the merchant's stage is the customer status: leaving it is
    // refused while a linked deal issue still has open required sub-steps.
    let gateOverride:
      | { reason: string; blocked: { parent: Issue; steps: Issue[] }[] }
      | undefined;
    if (patch.statusId !== undefined && patch.statusId !== before.statusId) {
      const blocked = await this.blockingSubStepParents(
        await this.linkedParentIssues("customer", id)
      );
      if (blocked.length > 0) {
        if (!patch.stageGateOverride) {
          throw stageGateConflict(blocked);
        }
        gateOverride = { reason: patch.stageGateOverride.reason, blocked };
      }
    }
    const customer = data.updateCustomer(
      this.db,
      this.organizationId,
      id,
      customerPatch
    );
    if (!customer) return undefined;
    this.applyCustomFields("customer", id, customFields);
    this.audit("customer.updated", "customer", id, actorId);
    if (gateOverride) {
      const stageName = (statusId: string | null) =>
        statusId === null
          ? null
          : (data.getCustomerStatus(this.db, this.organizationId, statusId)
              ?.name ?? statusId);
      const transition = {
        field: "stage",
        from: stageName(before.statusId),
        to: stageName(customer.statusId),
      };
      for (const { parent, steps } of gateOverride.blocked) {
        await this.recordStageGateOverride(
          parent,
          steps,
          gateOverride.reason,
          actorId,
          transition
        );
      }
    }
    // PILE-411 — the merchant's stage is its customer status: entering a
    // templated status materializes sub-steps under the linked deal issues.
    // Templates key on the status's name, not the statusId uuid.
    if (
      customerPatch.statusId !== undefined &&
      customer.statusId !== before.statusId &&
      customer.statusId
    ) {
      const status = data.getCustomerStatus(
        this.db,
        this.organizationId,
        customer.statusId
      );
      await this.applyStageTemplates(
        "customer",
        status?.name ?? customer.statusId,
        customer,
        await this.linkedParentIssues("customer", customer.id),
        actorId
      );
      // PILE-401 — stage-entered event for the customer pipeline stage.
      await this.emitDomainEvent(
        "record.stage_entered",
        {
          entityType: "customer",
          entityId: customer.id,
          from: before.statusId,
          to: customer.statusId,
          toName: status?.name ?? customer.statusId,
        },
        `stage:${customer.id}:${customer.statusId}`
      );
    }
    return this.withEntityFields("customer", customer);
  }

  // Bulk customer import — Scout's write path (PILE-403). Idempotent on
  // externalId ("gplace:<place_id>"), lands a durable per-row receipt.
  importCustomers(
    input: {
      source?: string | null;
      corridor?: string | null;
      rows: data.ImportCustomerRow[];
    },
    actorId?: string
  ) {
    const receipt = data.importCustomers(this.db, this.organizationId, {
      ...input,
      createdById: actorId,
    });
    this.audit("customers.imported", "import_receipt", receipt.id, actorId);
    return receipt;
  }

  getImportReceipt(id: string) {
    return data.getImportReceipt(this.db, this.organizationId, id);
  }

  listImportReceipts() {
    return data.listImportReceipts(this.db, this.organizationId);
  }

  async deleteCustomer(id: string, actorId?: string) {
    const r2Keys = data
      .listEntityAttachments(this.db, this.organizationId, "customer", id)
      .map((a) => a.r2Key);
    const deleted = data.deleteCustomer(this.db, this.organizationId, id);
    if (deleted) {
      this.audit("customer.deleted", "customer", id, actorId);
      if (r2Keys.length > 0 && this.env.ATTACHMENTS_BUCKET) {
        try {
          await this.env.ATTACHMENTS_BUCKET.delete(r2Keys);
        } catch (err) {
          console.error("customer attachment R2 cleanup failed", {
            customerId: id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return deleted;
  }

  createCustomerTier(input: {
    name: string;
    color?: string | null;
    position?: number;
  }) {
    return data.createCustomerTier(this.db, this.organizationId, input);
  }

  listCustomerTiers() {
    return data.listCustomerTiers(this.db, this.organizationId);
  }

  getCustomerTier(id: string) {
    return data.getCustomerTier(this.db, this.organizationId, id);
  }

  updateCustomerTier(
    id: string,
    input: { name?: string; color?: string | null; position?: number }
  ) {
    return data.updateCustomerTier(this.db, this.organizationId, id, input);
  }

  deleteCustomerTier(id: string) {
    return data.deleteCustomerTier(this.db, this.organizationId, id);
  }

  createCustomerStatus(input: {
    name: string;
    color?: string | null;
    position?: number;
    key?: string;
    type?: "active" | "terminal";
  }) {
    return data.createCustomerStatus(this.db, this.organizationId, input);
  }

  listCustomerStatuses() {
    return data.listCustomerStatuses(this.db, this.organizationId);
  }

  getCustomerStatus(id: string) {
    return data.getCustomerStatus(this.db, this.organizationId, id);
  }

  updateCustomerStatus(
    id: string,
    input: {
      name?: string;
      color?: string | null;
      position?: number;
      type?: "active" | "terminal";
    }
  ) {
    return data.updateCustomerStatus(this.db, this.organizationId, id, input);
  }

  deleteCustomerStatus(id: string) {
    return data.deleteCustomerStatus(this.db, this.organizationId, id);
  }

  createCustomerNeed(input: data.CustomerNeedInput, actorId?: string) {
    const need = data.createCustomerNeed(this.db, this.organizationId, input);
    this.audit("customer_need.created", "customer", need.customerId, actorId);
    return need;
  }

  listCustomerNeeds(
    args: { customerId?: string; issueId?: string; projectId?: string } = {}
  ) {
    return data.listCustomerNeeds(this.db, this.organizationId, args);
  }

  getCustomerNeed(id: string) {
    return data.getCustomerNeed(this.db, this.organizationId, id);
  }

  updateCustomerNeed(
    id: string,
    input: data.CustomerNeedUpdateInput,
    actorId?: string
  ) {
    const need = data.updateCustomerNeed(
      this.db,
      this.organizationId,
      id,
      input
    );
    if (need)
      this.audit("customer_need.updated", "customer", need.customerId, actorId);
    return need;
  }

  deleteCustomerNeed(id: string) {
    return data.deleteCustomerNeed(this.db, this.organizationId, id);
  }

  // ---- customer email intake (PILE-325) ----
  resolveCustomerForEmail(input: data.ResolveCustomerForEmailInput) {
    const result = data.resolveCustomerForEmail(
      this.db,
      this.organizationId,
      input
    );
    if (result.created) {
      this.audit(
        "customer.created",
        "customer",
        result.customer.id,
        undefined,
        undefined,
        { actorType: "automation" }
      );
    }
    return result;
  }

  fileCustomerIntakeItem(input: data.CustomerIntakeItemInput) {
    const result = data.fileCustomerIntakeItem(
      this.db,
      this.organizationId,
      input
    );
    if (result.isNew && result.item) {
      this.audit(
        "customer_intake.filed",
        "customer",
        result.item.customerId,
        undefined,
        undefined,
        { actorType: "automation" }
      );
    }
    return result;
  }

  listCustomerIntakeItems(customerId: string) {
    return data.listCustomerIntakeItems(
      this.db,
      this.organizationId,
      customerId
    );
  }

  // ---- releases ----
  createReleasePipeline(input: { name: string; stages?: string[] }) {
    return data.createReleasePipeline(this.db, this.organizationId, input);
  }

  listReleasePipelines() {
    return data.listReleasePipelines(this.db, this.organizationId);
  }

  deleteReleasePipeline(id: string) {
    return data.deleteReleasePipeline(this.db, this.organizationId, id);
  }

  createRelease(input: Omit<data.ReleaseInput, "organizationId">) {
    const release = data.createRelease(this.db, {
      ...input,
      organizationId: this.organizationId,
    });
    this.audit("release.created", "release", release.id, input.createdById);
    return release;
  }

  listReleases(args: { projectId?: string } = {}) {
    return data.listReleases(this.db, this.organizationId, args);
  }

  getRelease(id: string) {
    return data.getRelease(this.db, this.organizationId, id);
  }

  updateRelease(
    id: string,
    patch: Partial<Omit<data.ReleaseInput, "organizationId">>,
    actorId?: string
  ) {
    const release = data.updateRelease(this.db, this.organizationId, id, patch);
    if (release) this.audit("release.updated", "release", id, actorId);
    return release;
  }

  deleteRelease(id: string, actorId?: string) {
    const deleted = data.deleteRelease(this.db, this.organizationId, id);
    if (deleted) this.audit("release.deleted", "release", id, actorId);
    return deleted;
  }

  // ---- document spaces / shares / watchers ----
  createDocumentSpace(input: {
    name: string;
    description?: string | null;
    icon?: string | null;
    publicSharing?: boolean;
    restricted?: boolean;
    createdById: string;
  }) {
    return data.createDocumentSpace(this.db, this.organizationId, input);
  }

  listDocumentSpaces() {
    return data.listDocumentSpaces(this.db, this.organizationId);
  }

  getDocumentSpace(id: string) {
    return data.getDocumentSpace(this.db, this.organizationId, id);
  }

  updateDocumentSpace(
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      icon?: string | null;
      publicSharing?: boolean;
      restricted?: boolean;
    }
  ) {
    return data.updateDocumentSpace(this.db, this.organizationId, id, patch);
  }

  deleteDocumentSpace(id: string) {
    return data.deleteDocumentSpace(this.db, this.organizationId, id);
  }

  createIssueShare(input: {
    issueId: string;
    createdById: string;
    expiresAt?: string | null;
  }) {
    return data.createIssueShare(this.db, this.organizationId, input);
  }

  getIssueShare(issueId: string) {
    return data.getIssueShare(this.db, this.organizationId, issueId);
  }

  getIssueShareByToken(token: string) {
    return data.getIssueShareByToken(this.db, token);
  }

  deleteIssueShare(token: string) {
    return data.deleteIssueShare(this.db, this.organizationId, token);
  }

  createDocumentShare(input: {
    documentId: string;
    includeChildren?: boolean;
    createdById: string;
    expiresAt?: string | null;
  }) {
    return data.createDocumentShare(this.db, this.organizationId, input);
  }

  getDocumentShare(documentId: string) {
    return data.getDocumentShare(this.db, this.organizationId, documentId);
  }

  getDocumentShareByToken(token: string) {
    return data.getDocumentShareByToken(this.db, token);
  }

  deleteDocumentShare(token: string) {
    return data.deleteDocumentShare(this.db, this.organizationId, token);
  }

  watchDocument(documentId: string, userId: string) {
    return data.watchDocument(this.db, this.organizationId, documentId, userId);
  }

  unwatchDocument(documentId: string, userId: string) {
    return data.unwatchDocument(this.db, documentId, userId);
  }

  listDocumentWatchers(documentId: string) {
    return data.listDocumentWatchers(this.db, documentId);
  }

  async searchDocuments(query: string, limit = 50): Promise<string[]> {
    const index = await this.ensureSearchIndex();
    return searchDocuments(index, query, limit);
  }

  // `teamIds` is the caller's resolved visibility set — an empty array means
  // no issues are in scope (never "unfiltered").
  async searchAll(
    query: string,
    teamIds: string[],
    limit = 50,
    viewer?: IssueViewer,
    docViewer?: { actorId: string; admin: boolean }
  ): Promise<{ issueIds: string[]; documentIds: string[] }> {
    const index = await this.ensureSearchIndex();
    const [issueIds, documentIds] = await Promise.all([
      teamIds.length > 0
        ? searchIssues(index, query, teamIds, limit)
        : Promise.resolve([]),
      searchDocuments(index, query, limit),
    ]);
    const hidden = new Set(this.hiddenIssueIdsFor(viewer));
    let visibleDocs = documentIds;
    // PILE-409: restricted-space docs and grant-gated docs don't leak
    // through search. Admins see everything; others need a grant.
    if (documentIds.length > 0 && docViewer && !docViewer.admin) {
      const restrictedSpaces = data.restrictedSpaceIds(
        this.db,
        this.organizationId
      );
      const grants = await this.db
        .select()
        .from(workspaceDocumentPermissions)
        .all();
      const actorSet = new Set([docViewer.actorId, ...teamIds]);
      const granted = new Set(
        grants.filter((g) => actorSet.has(g.actorId)).map((g) => g.documentId)
      );
      const grantGated = new Set(grants.map((g) => g.documentId));
      const spaceByDoc = new Map(
        (
          await this.db
            .select({
              id: workspaceDocuments.id,
              spaceId: workspaceDocuments.spaceId,
            })
            .from(workspaceDocuments)
            .where(inArray(workspaceDocuments.id, documentIds))
            .all()
        ).map((d) => [d.id, d.spaceId])
      );
      visibleDocs = documentIds.filter((id) => {
        if (granted.has(id)) return true;
        const spaceId = spaceByDoc.get(id);
        if (spaceId && restrictedSpaces.has(spaceId)) return false;
        if (grantGated.has(id)) return false;
        return true;
      });
    }
    return {
      issueIds: issueIds.filter((id) => !hidden.has(id)),
      documentIds: visibleDocs,
    };
  }

  async findSimilarIssues(
    issueId: string,
    teamIds: string[],
    limit = 10,
    viewer?: IssueViewer
  ): Promise<Array<{ issue: Issue; score: number }>> {
    await this.ready;
    const issue = await this.getIssue(issueId);
    if (!issue) return [];
    const index = await this.ensureSearchIndex();
    const hits = await findSimilarIssues(index, issue, teamIds, limit);
    const matches = await Promise.all(
      hits.map((hit) => this.getIssue(hit.issueId))
    );
    const hidden = new Set(this.hiddenIssueIdsFor(viewer));
    return hits.flatMap((hit, i) => {
      const match = matches[i];
      return match && !hidden.has(match.id)
        ? [{ issue: match, score: hit.score }]
        : [];
    });
  }

  // PILE-163 — open issues in `teamIds` whose titles closely match a title
  // about to be created. Index rows are re-read so stale status/title never
  // surface.
  async findPossibleDuplicates(
    title: string,
    teamIds: string[],
    limit = 5,
    viewer?: IssueViewer
  ): Promise<Array<{ issue: Issue; score: number }>> {
    await this.ready;
    if (teamIds.length === 0) return [];
    const hidden = new Set(this.hiddenIssueIdsFor(viewer));
    if (similarityTerms(title).length === 0) {
      // No indexable terms — the index can't help, and generic titles like
      // "Fix it" are the likeliest collisions. Match them verbatim instead.
      const wanted = title.toLowerCase();
      const normalized = normalizeIssueTitle(title);
      const rows = await this.db
        .select()
        .from(workspaceIssues)
        .where(inArray(workspaceIssues.teamId, teamIds))
        .all();
      return rows
        .flatMap((issue) => {
          if (
            hidden.has(issue.id) ||
            issue.status === "done" ||
            issue.status === "canceled"
          )
            return [];
          const sameTitle =
            issue.title.toLowerCase() === wanted ||
            (normalized !== "" &&
              normalizeIssueTitle(issue.title) === normalized);
          return sameTitle ? [{ issue, score: 1 }] : [];
        })
        .slice(0, limit);
    }
    const index = await this.ensureSearchIndex();
    const hits = await findDuplicateCandidates(index, title, teamIds);
    const matches = await Promise.all(
      hits.map((hit) => this.getIssue(hit.issueId))
    );
    return matches
      .flatMap((issue) => {
        if (
          !issue ||
          hidden.has(issue.id) ||
          !teamIds.includes(issue.teamId) ||
          issue.status === "done" ||
          issue.status === "canceled"
        )
          return [];
        const score = titleOverlapScore(title, issue.title);
        return score >= DUPLICATE_MIN_SCORE ? [{ issue, score }] : [];
      })
      .toSorted((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // Extract [[doc slug/id]] and ISSUE-KEY references from content.
  // Runs synchronously inside the caller's transactionSync block.
  private syncDocumentLinks(
    documentId: string,
    content: string,
    contentFormat: string
  ) {
    const text =
      contentFormat === "markdown" ? content : blockNoteToPlainText(content);
    // Dedupe before resolving: a repeated ref must produce a single link.
    const docRefs = [
      ...new Set([...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1])),
    ];
    const issueKeys = [
      ...new Set(
        [...text.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g)].map((m) => m[1])
      ),
    ];
    // One bounded query per target type per chunk. DO SQLite caps bound
    // variables per statement at ~100: docRefs bind 2 params each (slug +
    // id OR), issueKeys bind 1 — chunk to stay under.
    const docTargets = chunk(docRefs, 48).flatMap((refs) =>
      refs.length === 0
        ? []
        : this.db
            .select({ id: workspaceDocuments.id })
            .from(workspaceDocuments)
            .where(
              or(
                inArray(workspaceDocuments.slug, refs),
                inArray(workspaceDocuments.id, refs)
              )
            )
            .all()
    );
    const issueTargets = chunk(issueKeys, 64).flatMap((keys) =>
      keys.length === 0
        ? []
        : this.db
            .select({ id: workspaceIssues.id })
            .from(workspaceIssues)
            .where(inArray(workspaceIssues.identifier, keys))
            .all()
    );
    const links: Array<{ targetType: string; targetId: string }> = [];
    for (const target of docTargets) {
      links.push({ targetType: "document", targetId: target.id });
    }
    for (const issue of issueTargets) {
      links.push({ targetType: "issue", targetId: issue.id });
    }
    data.replaceDocumentLinks(this.db, this.organizationId, documentId, links);
  }

  setDocumentPermission(
    documentId: string,
    actorId: string,
    actorType: string,
    level: "view" | "edit"
  ) {
    return data.setDocumentPermission(
      this.db,
      this.organizationId,
      documentId,
      actorId,
      actorType,
      level
    );
  }

  revokeDocumentPermission(documentId: string, actorId: string) {
    return data.revokeDocumentPermission(this.db, documentId, actorId);
  }

  documentAccessLevel(
    documentId: string,
    actorId: string,
    teamIds: string[] = [],
    defaultDenied = false
  ) {
    return data.documentAccessLevel(
      this.db,
      documentId,
      actorId,
      teamIds,
      defaultDenied
    );
  }

  listDocumentPermissions(documentId: string) {
    return data.listDocumentPermissions(this.db, documentId);
  }

  listDocumentsVisibleTo(
    actorId: string,
    teamIds: string[] = [],
    args: data.ListDocumentsArgs = {}
  ) {
    return data.listDocumentsVisibleTo(
      this.db,
      this.organizationId,
      actorId,
      teamIds,
      args
    );
  }

  listDocumentsForActor(actorId: string, args: data.ListDocumentsArgs = {}) {
    return data.listDocumentsForActor(
      this.db,
      this.organizationId,
      actorId,
      args
    );
  }

  // ---- issue permissions (PILE-328) ----
  // Same grant model as documents: no rows = open to the workspace; any row
  // restricts the issue to listed actors (+ workspace admins, bypassed by
  // callers).

  setIssuePermission(
    issueId: string,
    actorId: string,
    actorType: string,
    grantedBy?: string
  ) {
    const grant = data.setIssuePermission(
      this.db,
      this.organizationId,
      issueId,
      actorId,
      actorType
    );
    if (grant) {
      // Restricted-issue grant changes stay out of ungranted members' audit
      // feeds — the entry itself asserts entityType "issue" on this issueId.
      this.audit("issue.permission.granted", "issue", issueId, grantedBy, {
        grant: { from: null, to: `${actorType}:${actorId}` },
      });
    }
    return grant;
  }

  revokeIssuePermission(issueId: string, actorId: string, revokedBy?: string) {
    const removed = data.revokeIssuePermission(this.db, issueId, actorId);
    if (removed) {
      this.audit("issue.permission.revoked", "issue", issueId, revokedBy, {
        grant: { from: actorId, to: null },
      });
    }
    return removed;
  }

  listIssuePermissions(issueId: string) {
    return data.listIssuePermissions(this.db, issueId);
  }

  issueVisibleTo(
    issueId: string,
    actorId: string,
    teamIds: string[] = [],
    grantedOnly = false
  ) {
    return data.hasIssueAccess(this.db, issueId, actorId, teamIds, grantedOnly);
  }

  hiddenIssueIdsFor(viewer?: IssueViewer): string[] {
    if (!viewer) return [];
    return data.hiddenIssueIds(
      this.db,
      viewer.actorId,
      viewer.teamIds,
      viewer.grantedOnly
    );
  }

  // SQL-side exclusion predicate — grantedOnly enumerates every issue
  // and overflows the SQLite variable cap when inlined as ids.
  hiddenIssueConditionFor(
    viewer: IssueViewer | undefined,
    col: Parameters<typeof data.hiddenIssueCondition>[1]
  ) {
    if (!viewer) return undefined;
    return data.hiddenIssueCondition(
      this.db,
      col,
      viewer.actorId,
      viewer.teamIds,
      viewer.grantedOnly
    );
  }

  listDocumentLinks(
    args: { documentId?: string; targetType?: string; targetId?: string } = {}
  ) {
    return data.listDocumentLinks(this.db, this.organizationId, args);
  }

  setHiddenSurfaces(userId: string, hiddenSurfaces: string[] | null) {
    return data.setHiddenSurfaces(
      this.db,
      this.organizationId,
      userId,
      hiddenSurfaces
    );
  }

  setFavorites(userId: string, favorites: data.EntityFavorite[] | null) {
    return data.setFavorites(this.db, this.organizationId, userId, favorites);
  }

  setDefaultView(userId: string, defaultViewId: string | null) {
    return data.setDefaultView(
      this.db,
      this.organizationId,
      userId,
      defaultViewId
    );
  }

  // ---- linear_users ----
  listLinearUsers() {
    return data.listLinearUsers(this.db, this.organizationId);
  }

  getLinearUser(linearId: string) {
    return data.getLinearUser(this.db, this.organizationId, linearId);
  }

  createLinearUser(values: {
    linearId: string;
    name?: string;
    email?: string;
  }) {
    return data.createLinearUser(this.db, this.organizationId, values);
  }

  // ---- agent sessions ----
  async createAgentSession(
    input: Omit<data.AgentSessionInput, "organizationId">
  ) {
    const session = await data.createAgentSession(this.db, {
      ...input,
      organizationId: this.organizationId,
    });
    const issue = await this.getIssue(session.issueId);
    if (issue) {
      // PILE-417: dispatching an agent is delegation — the human assignee
      // stays accountable while delegateId records the agent doing the
      // work. Supersedes the PILE-229 `lane:{id}` assignee marker, which
      // clobbered the human assignee for the run's duration; rows written
      // before delegate_id existed are still released by
      // applyAgentSessionResult's legacy lane-marker cleanup.
      await this.updateIssue(issue.id, {
        delegateId: session.agentId,
      }).catch(() => null);
      await this.emit({
        type: "agent_session.created",
        organizationId: this.organizationId,
        session,
        issue,
      });
    }
    return session;
  }

  getAgentSession(id: string) {
    return data.getAgentSession(this.db, this.organizationId, id);
  }

  getAgentSessionByConversationKey(conversationKey: string) {
    return data.getAgentSessionByConversationKey(
      this.db,
      this.organizationId,
      conversationKey
    );
  }

  // Encrypted GitHub installation token currently held by each lane, keyed by
  // session. Swapping returns the previous one so callers can revoke it; the
  // reaper takes and revokes whatever is left once a session is terminal.
  async swapLaneGithubToken(
    sessionId: string,
    encrypted: string
  ): Promise<string | null> {
    const key = `${LANE_GITHUB_TOKEN_PREFIX}${sessionId}`;
    const previous = await this.ctx.storage.get<string>(key);
    await this.ctx.storage.put(key, encrypted);
    return previous ?? null;
  }

  async takeLaneGithubToken(sessionId: string): Promise<string | null> {
    const key = `${LANE_GITHUB_TOKEN_PREFIX}${sessionId}`;
    const encrypted = await this.ctx.storage.get<string>(key);
    if (encrypted === undefined) return null;
    await this.ctx.storage.delete(key);
    return encrypted;
  }

  async listLaneGithubTokenSessions(): Promise<string[]> {
    const entries = await this.ctx.storage.list({
      prefix: LANE_GITHUB_TOKEN_PREFIX,
    });
    return [...entries.keys()].map((key) =>
      key.slice(LANE_GITHUB_TOKEN_PREFIX.length)
    );
  }

  getAgentSessionByProviderSessionId(providerSessionId: string) {
    return data.getAgentSessionByProviderSessionId(
      this.db,
      this.organizationId,
      providerSessionId
    );
  }

  listAgentSessions(
    options: {
      issueId?: string;
      status?: AgentSessionStatus;
      openPr?: boolean;
      retryOf?: string;
      limit?: number;
      viewer?: IssueViewer;
    } = {}
  ) {
    const { viewer, ...rest } = options;
    return data.listAgentSessions(this.db, this.organizationId, {
      ...rest,
      excludeIssueCondition: this.hiddenIssueConditionFor(
        viewer,
        workspaceAgentSessions.issueId
      ),
    });
  }

  listAgentSessionSummaries(
    options: {
      issueId?: string;
      status?: AgentSessionStatus;
      openPr?: boolean;
      limit?: number;
      viewer?: IssueViewer;
    } = {}
  ) {
    const { viewer, ...rest } = options;
    return data.listAgentSessionSummaries(this.db, this.organizationId, {
      ...rest,
      excludeIssueCondition: this.hiddenIssueConditionFor(
        viewer,
        workspaceAgentSessions.issueId
      ),
    });
  }

  async getMaxConcurrentAgentChildren(): Promise<number> {
    const d1 = createD1(this.env.D1);
    const row = await d1
      .select({ metadata: organization.metadata })
      .from(organization)
      .where(eq(organization.id, this.organizationId))
      .get();
    const parsed = safeJSON(row?.metadata ?? null) as Record<
      string,
      unknown
    > | null;
    const value = parsed?.maxConcurrentAgentChildren;
    return typeof value === "number" ? value : 10;
  }

  listQueuedAgentSessions() {
    return data.listQueuedAgentSessions(this.db, this.organizationId);
  }

  reanchorQueuedDependents(fromSessionId: string, toSessionId: string) {
    return data.reanchorQueuedDependents(
      this.db,
      this.organizationId,
      fromSessionId,
      toSessionId
    );
  }

  listChildAgentSessions(parentSessionId: string) {
    return data.listChildAgentSessions(
      this.db,
      this.organizationId,
      parentSessionId
    );
  }

  countActiveDescendantSessions(rootSessionId: string) {
    return data.countActiveDescendantSessions(
      this.db,
      this.organizationId,
      rootSessionId
    );
  }

  /** Spawn guardrails for agent-created lanes. Depth is read off the
   *  session's spawnDepth column; the descendant cap counts every active
   *  session in the root's tree. Both overridable via org metadata. */
  async getAgentSpawnLimits(): Promise<{
    maxSpawnDepth: number;
    maxActiveDescendants: number;
  }> {
    const d1 = createD1(this.env.D1);
    const row = await d1
      .select({ metadata: organization.metadata })
      .from(organization)
      .where(eq(organization.id, this.organizationId))
      .get();
    const parsed = safeJSON(row?.metadata ?? null) as Record<
      string,
      unknown
    > | null;
    const maxSpawnDepth = parsed?.maxAgentSpawnDepth;
    const maxActiveDescendants = parsed?.maxActiveAgentDescendants;
    return {
      maxSpawnDepth: typeof maxSpawnDepth === "number" ? maxSpawnDepth : 2,
      maxActiveDescendants:
        typeof maxActiveDescendants === "number" ? maxActiveDescendants : 20,
    };
  }

  // ---- agent type pauses (PILE-420) ----

  listAgentPauses() {
    return data.listAgentPauses(this.db, this.organizationId);
  }

  getAgentPause(agentId: string) {
    return data.getAgentPause(this.db, this.organizationId, agentId);
  }

  listPauseHeldSessions(agentId: string) {
    return data.listPauseHeldSessions(this.db, this.organizationId, agentId);
  }

  /** Pause an agent type workspace-wide: new dispatches of `agentId` park
   *  as `waiting` + `paused` until resume. Upserts — re-pausing refreshes
   *  the reason/actor. Audited with actor and reason (operator action). */
  async pauseAgentType(
    agentId: string,
    input: {
      reason?: string | null;
      actorId?: string | null;
      actorType?: string | null;
    }
  ) {
    await this.ready;
    const existing = await data.getAgentPause(
      this.db,
      this.organizationId,
      agentId
    );
    const row = await data.upsertAgentPause(
      this.db,
      this.organizationId,
      agentId,
      { reason: input.reason, createdBy: input.actorId }
    );
    this.audit(
      "agent_type.paused",
      "agent_type",
      agentId,
      input.actorId,
      {
        reason: { from: existing?.reason ?? null, to: row?.reason ?? null },
      },
      { actorType: input.actorType }
    );
    return row;
  }

  /** Resume an agent type: deletes the pause row (the caller drains held
   *  sessions in order). Returns false when nothing was paused. */
  async resumeAgentType(
    agentId: string,
    input: { actorId?: string | null; actorType?: string | null }
  ): Promise<boolean> {
    await this.ready;
    const ok = await data.deleteAgentPause(
      this.db,
      this.organizationId,
      agentId
    );
    if (ok) {
      this.audit(
        "agent_type.resumed",
        "agent_type",
        agentId,
        input.actorId,
        null,
        { actorType: input.actorType }
      );
    }
    return ok;
  }

  // ---- spend caps + run receipts (PILE-425 — per-agent token/$ budgets
  // and the per-run usage record every terminal lane writes) ----

  listAgentSpendCaps() {
    return data.listAgentSpendCaps(this.db, this.organizationId);
  }

  getAgentSpendCap(agentId: string) {
    return data.getAgentSpendCap(this.db, this.organizationId, agentId);
  }

  /** The caps an agent type actually runs under — its own row, else the
   *  workspace default "*" row, else undefined (uncapped). */
  resolveAgentSpendCap(agentId: string) {
    return data.resolveAgentSpendCap(this.db, this.organizationId, agentId);
  }

  async upsertAgentSpendCap(
    agentId: string,
    input: data.AgentSpendCapPatch,
    actor?: { id?: string | null; type?: string | null }
  ) {
    await this.ready;
    const existing = await data.getAgentSpendCap(
      this.db,
      this.organizationId,
      agentId
    );
    const row = await data.upsertAgentSpendCap(
      this.db,
      this.organizationId,
      agentId,
      { ...input, createdBy: actor?.id }
    );
    this.audit(
      existing ? "agent_spend_cap.updated" : "agent_spend_cap.created",
      "agent_spend_cap",
      agentId,
      actor?.id,
      { caps: { from: existing ?? null, to: row ?? null } },
      { actorType: actor?.type }
    );
    return row;
  }

  async deleteAgentSpendCap(
    agentId: string,
    actor?: { id?: string | null; type?: string | null }
  ): Promise<boolean> {
    await this.ready;
    const ok = await data.deleteAgentSpendCap(
      this.db,
      this.organizationId,
      agentId
    );
    if (ok) {
      this.audit(
        "agent_spend_cap.deleted",
        "agent_spend_cap",
        agentId,
        actor?.id,
        null,
        { actorType: actor?.type }
      );
    }
    return ok;
  }

  /** Caps + observed window usage for an agent type, evaluated to breach
   *  list. `runUsage` adds a live lane's per-run numbers so the sweep can
   *  enforce the per-run caps against a mid-flight receipt. */
  async evaluateAgentSpendCaps(
    agentId: string,
    runUsage?: {
      totalTokens?: number | null;
      costMicros?: number | null;
    }
  ): Promise<{
    caps: data.AgentSpendCap | undefined;
    usage: SpendWindowUsage | null;
    breaches: CapBreach[];
  }> {
    await this.ready;
    const caps = await data.resolveAgentSpendCap(
      this.db,
      this.organizationId,
      agentId
    );
    if (!caps) return { caps: undefined, usage: null, breaches: [] };
    const now = new Date();
    const dayStart = dayWindowStart(now);
    const monthStart = monthWindowStart(now);
    const [runsPerDay, runsPerMonth, daySums, monthSums] = await Promise.all([
      data.countAgentSessionsSince(
        this.db,
        this.organizationId,
        agentId,
        dayStart
      ),
      data.countAgentSessionsSince(
        this.db,
        this.organizationId,
        agentId,
        monthStart
      ),
      data.sumRunReceipts(this.db, this.organizationId, {
        agentId,
        since: dayStart,
      }),
      data.sumRunReceipts(this.db, this.organizationId, {
        agentId,
        since: monthStart,
      }),
    ]);
    const usage: SpendWindowUsage = {
      runsPerDay,
      runsPerMonth,
      tokensPerDay: daySums.totalTokens,
      tokensPerMonth: monthSums.totalTokens,
      costMicrosPerDay: daySums.costMicros + daySums.externalSpendMicros,
      costMicrosPerMonth: monthSums.costMicros + monthSums.externalSpendMicros,
      runTokens: runUsage?.totalTokens ?? undefined,
      runCostMicros: runUsage?.costMicros ?? undefined,
    };
    return { caps, usage, breaches: evaluateSpendCaps(caps, usage) };
  }

  /** Write the caps-row alert stamp and report whether a CoS alert is due —
   *  once per UTC day per breached caps row, so a breach that persists for
   *  days alerts daily rather than every sweep pass. */
  async claimSpendCapAlert(agentId: string): Promise<boolean> {
    await this.ready;
    const caps = await data.resolveAgentSpendCap(
      this.db,
      this.organizationId,
      agentId
    );
    if (!caps) return false;
    const alertedToday =
      caps.lastCapAlertAt !== null &&
      caps.lastCapAlertAt >= dayWindowStart(new Date());
    if (alertedToday) return false;
    await data.markAgentSpendCapAlerted(this.db, this.organizationId, agentId);
    return true;
  }

  // ---- run receipts ----

  getRunReceipt(sessionId: string) {
    return data.getRunReceipt(this.db, this.organizationId, sessionId);
  }

  listRunReceipts(filter: data.RunReceiptFilter = {}) {
    return data.listRunReceipts(this.db, this.organizationId, filter);
  }

  summarizeRunReceipts(
    input: data.RunReceiptFilter & { groupBy: data.RunReceiptGroupBy }
  ) {
    return data.summarizeRunReceipts(this.db, this.organizationId, input);
  }

  /** The deal a receipt rolls up to: an explicit entity_links deal edge on
   *  the issue, else the parent ticket (merchant deal = parent issue in the
   *  pipeline model). */
  private async resolveReceiptDealId(
    issue: Pick<Issue, "id" | "parentId">
  ): Promise<string | null> {
    const links = await data.listEntityLinks(
      this.db,
      this.organizationId,
      "issue",
      issue.id
    );
    for (const link of links) {
      if (link.fromType === "deal") return link.fromId;
      if (link.toType === "deal") return link.toId;
    }
    return issue.parentId ?? null;
  }

  /** Record a cumulative usage snapshot on the session's receipt. Values
   *  are run-totals, not deltas — each write replaces the usage fields.
   *  `costSource` is "reported" when the lane/provider supplies costMicros,
   *  else "rate_map" when the model is known. */
  async recordSessionUsage(
    sessionId: string,
    usage: AgentRunUsage
  ): Promise<data.AgentRunReceipt | undefined> {
    await this.ready;
    const session = await this.getAgentSession(sessionId);
    if (!session) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Session not found",
      });
    }
    const existing = await data.getRunReceipt(
      this.db,
      this.organizationId,
      sessionId
    );
    const inputTokens = usage.inputTokens ?? existing?.inputTokens ?? null;
    const outputTokens = usage.outputTokens ?? existing?.outputTokens ?? null;
    const totalTokens =
      usage.totalTokens ??
      (inputTokens !== null || outputTokens !== null
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : (existing?.totalTokens ?? null));
    const model = usage.model ?? existing?.model ?? null;
    let costMicros = usage.costMicros ?? null;
    let costSource = costMicros !== null ? "reported" : existing?.costSource;
    if (costMicros === null) {
      costMicros =
        computeCostMicros(model, inputTokens, outputTokens) ??
        existing?.costMicros ??
        null;
      if (costMicros !== null && costSource !== "reported") {
        costSource = "rate_map";
      }
    }
    const issue = await this.getIssue(session.issueId);
    return data.upsertRunReceipt(this.db, this.organizationId, {
      sessionId,
      issueId: session.issueId,
      agentId: session.agentId,
      stepKey: session.stepKey,
      dealId:
        existing?.dealId ??
        (issue ? await this.resolveReceiptDealId(issue) : null),
      status: session.status,
      model,
      effort: session.effort,
      inputTokens,
      outputTokens,
      totalTokens,
      toolCalls: usage.toolCalls ?? existing?.toolCalls ?? null,
      costMicros,
      externalSpendMicros:
        usage.externalSpendMicros ?? existing?.externalSpendMicros ?? null,
      costSource,
      startedAt: session.startedAt ?? session.createdAt,
    });
  }

  /** Guarantee a receipt row for a terminal session and stamp outcome
   *  fields. Runs that never reported usage still get a receipt — the spec's
   *  "each run writes a receipt". */
  private async finalizeRunReceipt(session: AgentSession): Promise<void> {
    const existing = await data.getRunReceipt(
      this.db,
      this.organizationId,
      session.id
    );
    const issue = await this.getIssue(session.issueId);
    const endedAt = session.endedAt ?? new Date().toISOString();
    const start = Date.parse(session.startedAt ?? session.createdAt ?? "");
    const end = Date.parse(endedAt);
    let costMicros = existing?.costMicros ?? null;
    let costSource = existing?.costSource ?? null;
    if (costMicros === null) {
      costMicros = computeCostMicros(
        existing?.model ?? null,
        existing?.inputTokens ?? null,
        existing?.outputTokens ?? null
      );
      if (costMicros !== null) costSource = "rate_map";
    }
    await data.upsertRunReceipt(this.db, this.organizationId, {
      sessionId: session.id,
      issueId: session.issueId,
      agentId: session.agentId,
      stepKey: session.stepKey,
      dealId:
        existing?.dealId ??
        (issue ? await this.resolveReceiptDealId(issue) : null),
      status: session.status,
      effort: session.effort,
      costMicros,
      costSource,
      startedAt: session.startedAt ?? session.createdAt,
      endedAt,
      durationMs:
        Number.isFinite(start) && Number.isFinite(end)
          ? Math.max(0, end - start)
          : null,
    });
  }

  /** Mark the receipt as stopped by a per-run cap — "the receipt shows
   *  why" per the spec's acceptance criteria. */
  async markRunReceiptStopped(
    sessionId: string,
    stopReason: string
  ): Promise<data.AgentRunReceipt | undefined> {
    await this.ready;
    const session = await this.getAgentSession(sessionId);
    if (!session) return undefined;
    return data.upsertRunReceipt(this.db, this.organizationId, {
      sessionId,
      issueId: session.issueId,
      agentId: session.agentId,
      capExceeded: 1,
      stopReason,
    });
  }

  // ---- guidance packs (PILE-423 — scoped instruction packs injected into
  // the dispatch prompt envelope, most specific last) ----

  listGuidancePacks(filter?: {
    scope?: data.GuidanceScope;
    scopeKey?: string;
  }) {
    return data.listGuidancePacks(this.db, this.organizationId, filter);
  }

  getGuidancePack(id: string) {
    return data.getGuidancePack(this.db, this.organizationId, id);
  }

  listGuidancePackVersions(packId: string) {
    return data.listGuidancePackVersions(this.db, this.organizationId, packId);
  }

  /** Packs a lane should see for (teamId, status, stepKey) — least specific
   *  first, so dispatch renders the most specific pack last. */
  resolveGuidancePacks(keys: {
    teamId?: string | null;
    status?: string | null;
    stepKey?: string | null;
  }) {
    return data.resolveGuidancePacks(this.db, this.organizationId, keys);
  }

  async createGuidancePack(
    input: Omit<data.GuidancePackInput, "organizationId">,
    actor: { actorId?: string | null; actorType?: string | null }
  ) {
    await this.ready;
    if (input.scope !== "workspace" && !input.scopeKey) {
      throw VortexError.fromCode(
        "BAD_REQUEST",
        `scopeKey is required for ${input.scope}-scoped packs`
      );
    }
    const pack = await data.createGuidancePack(this.db, {
      ...input,
      organizationId: this.organizationId,
      createdBy: actor.actorId,
    });
    this.audit(
      "guidance_pack.created",
      "guidance_pack",
      pack.id,
      actor.actorId,
      {
        scope: { from: null, to: pack.scope },
        scopeKey: { from: null, to: pack.scopeKey },
        name: { from: null, to: pack.name },
      },
      { actorType: actor.actorType }
    );
    return pack;
  }

  async updateGuidancePack(
    id: string,
    input: {
      name?: string;
      scope?: data.GuidanceScope;
      scopeKey?: string | null;
      body?: string;
      links?: string | null;
    },
    actor: { actorId?: string | null; actorType?: string | null }
  ) {
    await this.ready;
    const existing = await data.getGuidancePack(
      this.db,
      this.organizationId,
      id
    );
    if (!existing) return null;
    // Scope changes re-validate the key: a non-workspace pack needs one
    // (carried over or explicit), and a workspace pack must not keep one.
    const nextScope = input.scope ?? existing.scope;
    const nextKey =
      nextScope === "workspace"
        ? null
        : input.scopeKey !== undefined
          ? input.scopeKey
          : existing.scopeKey;
    if (nextScope !== "workspace" && !nextKey) {
      throw VortexError.fromCode(
        "BAD_REQUEST",
        `scopeKey is required for ${nextScope}-scoped packs`
      );
    }
    if (nextScope === "workspace" && input.scopeKey) {
      throw VortexError.fromCode(
        "BAD_REQUEST",
        "scopeKey is not valid for workspace-scoped packs"
      );
    }
    const pack = await data.updateGuidancePack(
      this.db,
      this.organizationId,
      id,
      input,
      actor.actorId ?? null
    );
    if (!pack) return null;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (pack.name !== existing.name)
      changes.name = { from: existing.name, to: pack.name };
    if (pack.scope !== existing.scope)
      changes.scope = { from: existing.scope, to: pack.scope };
    if (pack.scopeKey !== existing.scopeKey)
      changes.scopeKey = { from: existing.scopeKey, to: pack.scopeKey };
    if (pack.body !== existing.body)
      changes.body = {
        from: existing.body.slice(0, 200),
        to: pack.body.slice(0, 200),
      };
    if (pack.links !== existing.links)
      changes.links = { from: existing.links, to: pack.links };
    changes.version = { from: existing.version, to: pack.version };
    this.audit(
      "guidance_pack.updated",
      "guidance_pack",
      id,
      actor.actorId,
      changes,
      { actorType: actor.actorType }
    );
    return pack;
  }

  async deleteGuidancePack(
    id: string,
    actor: { actorId?: string | null; actorType?: string | null }
  ): Promise<boolean> {
    await this.ready;
    const ok = await data.deleteGuidancePack(this.db, this.organizationId, id);
    if (ok) {
      this.audit(
        "guidance_pack.deleted",
        "guidance_pack",
        id,
        actor.actorId,
        null,
        { actorType: actor.actorType }
      );
    }
    return ok;
  }

  // ---- stage templates (PILE-411 — sub-step definitions materialized as
  // sub-issues when a record enters the template's status) ----

  listStageTemplates(filter?: {
    entityType?: data.StageEntityType;
    status?: string;
  }) {
    return data.listStageTemplates(this.db, this.organizationId, filter);
  }

  getStageTemplate(id: string) {
    return data.getStageTemplate(this.db, this.organizationId, id);
  }

  async createStageTemplate(
    input: Omit<data.StageTemplateInput, "organizationId">,
    actor: { actorId?: string | null; actorType?: string | null }
  ) {
    await this.ready;
    const template = data.createStageTemplate(this.db, {
      ...input,
      organizationId: this.organizationId,
      createdBy: actor.actorId,
    });
    this.audit(
      "stage_template.created",
      "stage_template",
      template.id,
      actor.actorId,
      {
        status: { from: null, to: template.status },
        stepKey: { from: null, to: template.stepKey },
      },
      { actorType: actor.actorType }
    );
    return template;
  }

  async updateStageTemplate(
    id: string,
    patch: data.StageTemplatePatch,
    actor: { actorId?: string | null; actorType?: string | null }
  ) {
    await this.ready;
    const template = data.updateStageTemplate(
      this.db,
      this.organizationId,
      id,
      patch
    );
    if (template) {
      this.audit(
        "stage_template.updated",
        "stage_template",
        id,
        actor.actorId,
        null,
        { actorType: actor.actorType }
      );
    }
    return template;
  }

  async deleteStageTemplate(
    id: string,
    actor: { actorId?: string | null; actorType?: string | null }
  ): Promise<boolean> {
    await this.ready;
    const ok = data.deleteStageTemplate(this.db, this.organizationId, id);
    if (ok) {
      this.audit(
        "stage_template.deleted",
        "stage_template",
        id,
        actor.actorId,
        null,
        { actorType: actor.actorType }
      );
    }
    return ok;
  }

  /** Installs the default pipeline stages (the seven-stage sales-led
   *  merchant pipeline). Idempotent: existing (entity, status, stepKey)
   *  rows are skipped, deleted ones re-created. */
  async seedStageTemplates(
    actor: { actorId?: string | null; actorType?: string | null } = {}
  ) {
    await this.ready;
    const result = data.seedStageTemplates(
      this.db,
      this.organizationId,
      actor.actorId
    );
    if (result.created.length > 0) {
      this.audit(
        "stage_template.seeded",
        "stage_template",
        this.organizationId,
        actor.actorId,
        {
          created: { from: 0, to: result.created.length },
          skipped: { from: null, to: result.skipped },
        },
        { actorType: actor.actorType }
      );
    }
    return result;
  }

  // ---- triage auto-delegate rules (PILE-427 — ordered match rules on
  // inbound records; the evaluation log lives here too) ----

  listTriageRules(filter?: { recordType?: string; activeOnly?: boolean }) {
    return data.listTriageRules(this.db, this.organizationId, filter);
  }

  getTriageRule(id: string) {
    return data.getTriageRule(this.db, this.organizationId, id);
  }

  async createTriageRule(
    input: Omit<data.TriageRuleInput, "organizationId">,
    actor: { actorId?: string | null; actorType?: string | null }
  ) {
    await this.ready;
    const rule = data.createTriageRule(this.db, {
      ...input,
      organizationId: this.organizationId,
      createdBy: actor.actorId,
    });
    this.audit(
      "triage_rule.created",
      "triage_rule",
      rule.id,
      actor.actorId,
      {
        recordType: { from: null, to: rule.recordType },
        name: { from: null, to: rule.name },
      },
      { actorType: actor.actorType }
    );
    return rule;
  }

  async updateTriageRule(
    id: string,
    patch: data.TriageRulePatch,
    actor: { actorId?: string | null; actorType?: string | null }
  ) {
    await this.ready;
    const rule = data.updateTriageRule(this.db, this.organizationId, id, patch);
    if (rule) {
      this.audit(
        "triage_rule.updated",
        "triage_rule",
        id,
        actor.actorId,
        null,
        { actorType: actor.actorType }
      );
    }
    return rule;
  }

  async deleteTriageRule(
    id: string,
    actor: { actorId?: string | null; actorType?: string | null }
  ): Promise<boolean> {
    await this.ready;
    const ok = data.deleteTriageRule(this.db, this.organizationId, id);
    if (ok) {
      this.audit(
        "triage_rule.deleted",
        "triage_rule",
        id,
        actor.actorId,
        null,
        { actorType: actor.actorType }
      );
    }
    return ok;
  }

  /** The evaluation log is the audit — no separate audit row per entry. */
  recordTriageEvaluation(
    input: Omit<data.TriageEvaluationInput, "organizationId">
  ) {
    return data.recordTriageEvaluation(this.db, {
      ...input,
      organizationId: this.organizationId,
    });
  }

  listTriageEvaluations(filter?: {
    recordType?: string;
    recordId?: string;
    ruleId?: string;
    limit?: number;
  }) {
    return data.listTriageEvaluations(this.db, this.organizationId, filter);
  }

  // ---- external events (PILE-422 — inbound provider webhooks complete
  // stage sub-steps; mappings bind source+eventType to a stepKey) ----

  listExternalEventMappings(filter?: { source?: string }) {
    return data.listExternalEventMappings(this.db, this.organizationId, {
      source: filter?.source,
    });
  }

  getExternalEventMapping(id: string) {
    return data.getExternalEventMapping(this.db, this.organizationId, id);
  }

  async createExternalEventMapping(
    input: Omit<data.ExternalEventMappingInput, "organizationId">,
    actor: { actorId?: string | null; actorType?: string | null }
  ) {
    await this.ready;
    const mapping = data.createExternalEventMapping(this.db, {
      ...input,
      organizationId: this.organizationId,
      createdBy: actor.actorId,
    });
    this.audit(
      "external_event_mapping.created",
      "external_event_mapping",
      mapping.id,
      actor.actorId,
      {
        source: { from: null, to: mapping.source },
        eventType: { from: null, to: mapping.eventType },
        stepKey: { from: null, to: mapping.stepKey },
      },
      { actorType: actor.actorType }
    );
    return mapping;
  }

  async updateExternalEventMapping(
    id: string,
    patch: data.ExternalEventMappingPatch,
    actor: { actorId?: string | null; actorType?: string | null }
  ) {
    await this.ready;
    const mapping = data.updateExternalEventMapping(
      this.db,
      this.organizationId,
      id,
      patch
    );
    if (mapping) {
      // Secret rotation is audited as a boolean flip — the credential never
      // lands in the log.
      this.audit(
        "external_event_mapping.updated",
        "external_event_mapping",
        id,
        actor.actorId,
        Object.fromEntries(
          Object.entries(patch).map(([key, value]) => [
            key,
            {
              from: null,
              to: key === "secret" ? "<rotated>" : value,
            },
          ])
        ),
        { actorType: actor.actorType }
      );
    }
    return mapping;
  }

  async deleteExternalEventMapping(
    id: string,
    actor: { actorId?: string | null; actorType?: string | null }
  ) {
    await this.ready;
    const ok = data.deleteExternalEventMapping(
      this.db,
      this.organizationId,
      id
    );
    if (ok) {
      this.audit(
        "external_event_mapping.deleted",
        "external_event_mapping",
        id,
        actor.actorId,
        null,
        { actorType: actor.actorType }
      );
    }
    return ok;
  }

  listExternalEventDeliveries(filter?: {
    source?: string;
    status?: string;
    limit?: number;
  }) {
    return data.listExternalEventDeliveries(this.db, this.organizationId, {
      source: filter?.source,
      status: filter?.status,
      limit: filter?.limit,
    });
  }

  /** PILE-422 — one inbound provider event in, one recorded outcome out.
   *  Pipeline: claim the dedupe slot → verify the source's HMAC → resolve
   *  the mapping by event type → resolve the record by the matcher's
   *  payload path → mark the sub-step issue(s) done with the payload as
   *  evidence. Every outcome lands on the delivery row, so unmatched and
   *  invalid events are logged without changing state and replays
   *  short-circuit on (org, source, dedupeKey). */
  async ingestExternalEvent(
    input: ExternalEventIngestInput
  ): Promise<ExternalEventIngestResult> {
    await this.ready;
    const source = data.stageKey(input.source);
    const mappings = data.listExternalEventMappings(
      this.db,
      this.organizationId,
      { source, enabledOnly: true }
    );
    if (mappings.length === 0) return { status: "unknown_source" };

    // The body is parsed before verification — the event type only picks
    // which mapping/secret applies; nothing unverified can change state.
    let payload: unknown = null;
    try {
      payload = JSON.parse(input.body);
    } catch {
      payload = null;
    }
    const eventType = data.extractEventField(payload, [
      "type",
      "event_type",
      "event",
    ]);
    const eventId =
      input.eventId ?? data.extractEventField(payload, ["id", "event_id"]);
    // The provider event id is the dedupe key when present; id-less sources
    // collapse on a content hash so a byte-identical replay still does
    // nothing.
    const dedupeKey = eventId ?? (await sha256Hex(`${source}:${input.body}`));

    // Claim the dedupe slot up front — the claim is a synchronous pair of
    // statements, so a concurrent replay of the same event loses the race
    // before either side touches an issue.
    const claimed = data.insertExternalEventDelivery(this.db, {
      organizationId: this.organizationId,
      source,
      eventType,
      eventId,
      dedupeKey,
      status: "processing",
      payload: input.body.slice(0, EXTERNAL_EVENT_PAYLOAD_MAX_CHARS),
    });
    if (!claimed) {
      const existing = data.getExternalEventDeliveryByDedupeKey(
        this.db,
        this.organizationId,
        source,
        dedupeKey
      );
      return {
        status: "replay",
        deliveryId: existing?.id,
        outcome: existing?.status,
      };
    }

    const finish = (
      status: ExternalEventDeliveryStatus,
      extra?: {
        entityType?: string | null;
        entityId?: string | null;
        completedIssueIds?: string[];
      }
    ): ExternalEventIngestResult => {
      data.updateExternalEventDelivery(
        this.db,
        this.organizationId,
        claimed.id,
        {
          status,
          ...extra,
        }
      );
      return {
        status,
        deliveryId: claimed.id,
        ...(extra?.completedIssueIds
          ? { completedIssueIds: extra.completedIssueIds }
          : {}),
      };
    };

    // HMAC-SHA256 hex over the raw body, tried against every enabled
    // mapping for the source — providers commonly share one webhook
    // secret across their event types.
    const tokens = externalSignatureTokens(input.signatures);
    let verified = false;
    for (const mapping of mappings) {
      const expected = await hmacSha256Hex(mapping.secret, input.body);
      if (tokens.some((token) => timingSafeEqualHex(token, expected))) {
        verified = true;
        break;
      }
    }
    if (!verified) {
      return finish("invalid_signature");
    }
    if (payload === null || eventType === null) {
      return finish("invalid_payload");
    }

    const mapping =
      mappings.find((m) => m.eventType === eventType) ??
      // "*" is the catch-all for sources that don't split event types.
      mappings.find((m) => m.eventType === "*");
    if (!mapping) {
      return finish("unmapped");
    }

    // Resolve the record: the matcher's payload path yields the external
    // id — deal/customer external_id or issue external_ref.
    const externalValue = data.resolvePayloadPath(payload, mapping.matchPath);
    let entityId: string | null = null;
    let directTarget: Issue | undefined;
    let sawStep = false;
    const parents: Issue[] = [];
    if (externalValue !== null) {
      if (mapping.entityType === "deal") {
        const deal = data.getDealByExternalId(
          this.db,
          this.organizationId,
          externalValue
        );
        if (deal) {
          entityId = deal.id;
          parents.push(...(await this.linkedParentIssues("deal", deal.id)));
        }
      } else if (mapping.entityType === "customer") {
        const customer = data.getCustomerByExternalId(
          this.db,
          this.organizationId,
          externalValue
        );
        if (customer) {
          entityId = customer.id;
          parents.push(
            ...(await this.linkedParentIssues("customer", customer.id))
          );
        }
      } else {
        const issue = await this.getIssueByExternalRef(externalValue);
        if (issue) {
          entityId = issue.id;
          // The matched issue may itself carry the step (it IS the
          // sub-step) or be the parent the sub-step hangs under.
          if (issue.stepKey === mapping.stepKey) {
            directTarget = issue;
            sawStep = true;
          } else {
            parents.push(issue);
          }
        }
      }
    }
    if (entityId === null) {
      return finish("no_record");
    }

    // Collect open sub-steps with the mapped stepKey under the record's
    // parent issues (or the record issue itself).
    const targets = new Map<string, Issue>();
    if (directTarget && !isTerminalStatus(directTarget.status)) {
      targets.set(directTarget.id, directTarget);
    }
    for (const parent of parents) {
      if (parent.parentId || parent.isDraft) continue;
      for (const child of await this.getIssueChildren(parent.id)) {
        if (child.stepKey !== mapping.stepKey) continue;
        sawStep = true;
        if (!isTerminalStatus(child.status)) {
          targets.set(child.id, child);
        }
      }
    }

    const actorId = `external-event:${source}`;
    const completedIssueIds: string[] = [];
    for (const target of targets.values()) {
      const updated = await this.updateIssue(
        target.id,
        { status: "done", resolution: "resolved" },
        actorId
      );
      if (!updated) continue;
      const evidence =
        input.body.length > EXTERNAL_EVENT_COMMENT_PAYLOAD_CHARS
          ? `${input.body.slice(0, EXTERNAL_EVENT_COMMENT_PAYLOAD_CHARS)}…`
          : input.body;
      await this.createComment({
        issueId: target.id,
        body: `Sub-step completed by external event \`${mapping.eventType}\` from \`${source}\`${eventId ? ` (\`${eventId}\`)` : ""}. Evidence:\n\n\`\`\`json\n${evidence}\n\`\`\``,
        externalId: dedupeKey,
        externalSource: `external-event:${source}`,
        externalAuthor: source,
        internal: true,
      });
      completedIssueIds.push(target.id);
    }

    if (completedIssueIds.length === 0) {
      return finish(sawStep ? "already_done" : "no_step", {
        entityType: mapping.entityType,
        entityId,
      });
    }
    this.audit(
      "external_event.applied",
      "external_event_delivery",
      claimed.id,
      actorId,
      {
        stepKey: { from: null, to: mapping.stepKey },
        completed: { from: 0, to: completedIssueIds.length },
      },
      { actorType: "system" }
    );
    return finish("applied", {
      entityType: mapping.entityType,
      entityId,
      completedIssueIds,
    });
  }

  /** PILE-420 — minutes of silence (no activity, no heartbeat) before a
   *  live lane is marked `stale` and the alert fires. Org metadata
   *  `sessionStaleAfterMinutes`; default 15 — below the 20m inactivity
   *  kill so the stale window gives the CoS/human time to act. */
  async getSessionStaleMinutes(): Promise<number> {
    const d1 = createD1(this.env.D1);
    const row = await d1
      .select({ metadata: organization.metadata })
      .from(organization)
      .where(eq(organization.id, this.organizationId))
      .get();
    const parsed = safeJSON(row?.metadata ?? null) as Record<
      string,
      unknown
    > | null;
    const value = parsed?.sessionStaleAfterMinutes;
    return typeof value === "number" && value > 0 ? value : 15;
  }

  /** PILE-420 — a `running` lane that went silent moves to `stale`
   *  (non-terminal): `session.stale` event, a status activity, a
   *  `lane_stale` notification to the routed human (assignee else the
   *  dispatching actor — the same routing needs-input uses), and an
   *  `agent_session.updated` emit so live boards repaint. Idempotent:
   *  only `running` transitions, so a stale lane doesn't re-alert. */
  async markAgentSessionStale(
    sessionId: string,
    input: { staleAfterMinutes: number }
  ): Promise<AgentSession | null> {
    await this.ready;
    const session = await this.getAgentSession(sessionId);
    if (!session || session.status !== "running") return null;
    const updated = await data.updateAgentSession(
      this.db,
      this.organizationId,
      sessionId,
      { status: "stale" }
    );
    if (!updated) return null;
    const issue = await this.getIssue(session.issueId);
    const message = `Session stale — no activity or heartbeat for ${input.staleAfterMinutes}m`;
    await data.addAgentSessionEvent(this.db, {
      sessionId,
      type: "session.stale",
      message,
      payload: {
        issueId: issue?.id ?? null,
        staleAfterMinutes: input.staleAfterMinutes,
      },
    });
    await this.addAgentActivity({
      sessionId,
      type: "status",
      message,
      system: true,
    });
    try {
      const humanAssignee =
        issue?.assigneeId && !issue.assigneeId.startsWith("lane:")
          ? issue.assigneeId
          : null;
      const recipientId = humanAssignee ?? session.actorId;
      const recipientType: data.RecipientType = humanAssignee
        ? "user"
        : session.actorType;
      if (recipientId && issue) {
        await this.createNotification({
          recipientId,
          recipientType,
          issueId: issue.id,
          type: "lane_stale",
          metadata: {
            sessionId,
            agentId: session.agentId,
            staleAfterMinutes: input.staleAfterMinutes,
          },
        });
      }
    } catch (err) {
      console.error("stale lane notify failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (issue) {
      await this.emit({
        type: "agent_session.updated",
        organizationId: this.organizationId,
        session: updated,
        issue,
      });
    }
    return updated;
  }

  // ---- agent automations ----
  createAgentAutomation(input: data.AgentAutomationInput) {
    return data.createAgentAutomation(this.db, this.organizationId, input);
  }

  listAgentAutomations(
    options: { enabledOnly?: boolean; triggerKind?: "cron" | "event" } = {}
  ) {
    return data.listAgentAutomations(this.db, this.organizationId, options);
  }

  getAgentAutomation(id: string) {
    return data.getAgentAutomation(this.db, this.organizationId, id);
  }

  markAgentAutomationFired(id: string) {
    return data.markAgentAutomationFired(this.db, id);
  }

  deleteAgentAutomation(id: string) {
    return data.deleteAgentAutomation(this.db, this.organizationId, id);
  }

  async countActiveChildSessions(parentIssueId: string): Promise<number> {
    await this.ready;
    const childIssues = await this.db
      .select({ id: workspaceIssues.id })
      .from(workspaceIssues)
      .where(eq(workspaceIssues.parentId, parentIssueId))
      .all();
    if (childIssues.length === 0) return 0;

    const terminal: AgentSessionStatus[] = ["completed", "failed", "canceled"];
    const result = await this.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(workspaceAgentSessions)
      .where(
        and(
          inArray(
            workspaceAgentSessions.issueId,
            childIssues.map((i) => i.id)
          ),
          not(inArray(workspaceAgentSessions.status, terminal))
        )
      )
      .get();
    return result?.count ?? 0;
  }

  updateAgentSession(
    id: string,
    input: Parameters<typeof data.updateAgentSession>[3]
  ) {
    return data.updateAgentSession(this.db, this.organizationId, id, input);
  }

  /** PILE-426 — publish or replace the session's plan checklist. Whole-array
   *  replace (no per-item edits — the agent resends the full plan each time,
   *  same as Linear's agentSessionUpdate). A no-change publish still bumps
   *  the row but skips the event + progress-comment churn. */
  async setAgentSessionPlan(sessionId: string, plan: SessionPlan | null) {
    const session = await this.getAgentSession(sessionId);
    if (!session) return null;
    const serialized = plan === null ? null : JSON.stringify(plan);
    const updated = await data.updateAgentSession(
      this.db,
      this.organizationId,
      sessionId,
      { plan: serialized, lastProgressAt: new Date().toISOString() }
    );
    if (!updated) return null;
    if (serialized !== session.plan) {
      const done = (plan ?? []).filter(
        (item) => item.status === "completed" || item.status === "canceled"
      ).length;
      await data.addAgentSessionEvent(this.db, {
        sessionId,
        type: "session.plan",
        message:
          plan === null
            ? "Plan cleared"
            : `Plan updated (${done}/${plan.length} done)`,
        payload: { plan },
      });
      await this.syncLaneProgressComment(sessionId, {
        create: true,
        throttleMs: 0,
      });
      const issue = await this.getIssue(session.issueId);
      if (issue) {
        await this.emit({
          type: "agent_session.updated",
          organizationId: this.organizationId,
          session: updated,
          issue,
        });
      }
    }
    return updated;
  }

  /** Read-merge-write inside the DO so the webhook and the sweep can both
   *  record the same review without clobbering each other's verdicts. */
  async recordLaneReview(sessionId: string, verdict: ReviewVerdict) {
    const session = await data.getAgentSession(
      this.db,
      this.organizationId,
      sessionId
    );
    if (!session) return null;
    return data.updateAgentSession(
      this.db,
      this.organizationId,
      sessionId,
      rollReviewSummary(session.reviewSummary, verdict)
    );
  }

  async addAgentActivity(input: data.AgentActivityInput) {
    // PILE-419 — an elicitation opens a span that closes when the human
    // answers (respondToElicitation stamps endedAt → answer latency).
    const enriched =
      input.type === "elicitation" && input.startedAt === undefined
        ? { ...input, startedAt: new Date().toISOString() }
        : input;
    const activity = await data.addAgentActivity(this.db, enriched);
    // PILE-418 — the first lane-authored activity arms firstActivityAt
    // (status/prompt are system or human-originated, not the lane's ack).
    // Sessions past the ~10s first-ack window with this still null surface
    // as `awaitingFirstAck` in the API.
    if (!input.system && input.type !== "status" && input.type !== "prompt") {
      await data
        .updateAgentSession(this.db, this.organizationId, input.sessionId, {
          firstActivityAt: activity.createdAt,
        })
        .catch(() => undefined);
    }
    await data.addAgentSessionEvent(this.db, {
      sessionId: input.sessionId,
      type: "activity",
      message: activity.message,
      payload: { activity },
    });
    await this.syncLaneProgressComment(input.sessionId, {
      create: false,
      throttleMs:
        input.type === "thought" || input.type === "response"
          ? LANE_PROGRESS_THROTTLE_MS
          : 0,
    });
    // PILE-229 handoff: an elicitation is the lane asking a human. Mark it on
    // the event stream and notify the issue's human owner — the assignee when
    // it's a user, else the actor who dispatched the lane.
    // PILE-419: the same activity suspends the session — parks it in
    // `waiting` with awaitingActivityId pointing at this question until a
    // human answers via the respond route (Linear's awaitingInput).
    if (input.type === "elicitation") {
      try {
        const session = await this.getAgentSession(input.sessionId);
        const issue = session ? await this.getIssue(session.issueId) : null;
        await data.addAgentSessionEvent(this.db, {
          sessionId: input.sessionId,
          type: "session.needs_input",
          message: activity.message,
          payload: { issueId: issue?.id ?? null },
        });
        if (
          session &&
          !["completed", "failed", "canceled"].includes(session.status)
        ) {
          const updated = await data.updateAgentSession(
            this.db,
            this.organizationId,
            input.sessionId,
            {
              status: "waiting",
              awaitingActivityId: activity.id,
              // A newer question supersedes — re-arm the escalation clock.
              awaitingEscalatedAt: null,
            }
          );
          if (updated && updated.status !== session.status) {
            await data.addAgentSessionEvent(this.db, {
              sessionId: input.sessionId,
              type: "session.status",
              message: "Session status changed",
              payload: {
                field: "status",
                old: session.status,
                new: updated.status,
              },
            });
          }
        }
        const humanAssignee =
          issue?.assigneeId && !issue.assigneeId.startsWith("lane:")
            ? issue.assigneeId
            : null;
        const recipientId = humanAssignee ?? session?.actorId ?? null;
        const recipientType: data.RecipientType = humanAssignee
          ? "user"
          : (session?.actorType ?? "user");
        if (recipientId && issue) {
          await this.createNotification({
            recipientId,
            recipientType,
            issueId: issue.id,
            type: "lane_needs_input",
            metadata: {
              sessionId: input.sessionId,
              question: activity.message,
            },
          });
        }
      } catch (err) {
        console.error("elicitation handoff notify failed", {
          sessionId: input.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return activity;
  }

  /** PILE-290 — the lane's live progress comment on its issue. Created the
   *  first time the lane reports `running` (`create`), then edited in place:
   *  session link, current step, elapsed + ETA, reported task list. Never
   *  throws — observability must not break the session write path. */
  private async syncLaneProgressComment(
    sessionId: string,
    options: { create: boolean; throttleMs?: number; actorId?: string }
  ): Promise<void> {
    try {
      const session = await this.getAgentSession(sessionId);
      if (
        !session ||
        session.purpose === "preflight" ||
        session.purpose === TRIAGE_PURPOSE
      ) {
        return;
      }
      const externalId = laneProgressExternalId(session.id);
      const existingRef = await this.findCommentByExternalId(
        "agent",
        externalId
      );
      const existing = existingRef
        ? await this.getComment(existingRef.id)
        : undefined;
      if (!existing && !(options.create && session.status === "running")) {
        return;
      }
      const now = Date.now();
      if (
        existing &&
        options.throttleMs &&
        now - Date.parse(existing.updatedAt) < options.throttleMs
      ) {
        return;
      }
      const issue = await this.getIssue(session.issueId);
      if (!issue) return;
      const activities = await data.listAgentActivities(this.db, session.id, {
        limit: 50,
        order: "desc",
      });
      const { step, todos } = laneProgressFromActivities(activities);
      const typical = typicalLaneDurationMs(
        await data.listRecentLaneTimings(
          this.db,
          this.organizationId,
          session.agentId
        )
      );
      const body = renderLaneProgressComment({
        session,
        step,
        todos,
        plan: parseSessionPlan(session.plan),
        typical,
        apiBaseUrl: this.env.PUBLIC_API_URL ?? this.env.BETTER_AUTH_URL,
        now,
      });
      if (existing) {
        if (existing.body === body) return;
        const updated = await this.updateComment(existing.id, { body });
        if (updated) await this.emitCommentUpdated(updated, issue);
        return;
      }
      const comment = await this.createComment({
        issueId: issue.id,
        body,
        externalAuthor: session.agentId,
        externalSource: "agent",
        externalId,
      });
      if (comment) {
        await this.emitCommentCreated(comment, issue, options.actorId);
      }
    } catch (err) {
      console.error("lane progress comment sync failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async closeAgentActivity(id: string) {
    return data.closeAgentActivity(this.db, id);
  }

  getAgentActivity(id: string) {
    return data.getAgentActivity(this.db, id);
  }

  listAwaitingElicitationSessions() {
    return data.listAwaitingElicitationSessions(this.db, this.organizationId);
  }

  /** PILE-419 — minutes an elicitation may sit unanswered before the sweep
   *  escalates it. Org metadata `elicitationEscalateAfterMinutes`; default
   *  4h — a suspended lane holds no compute, so the SLA is human-paced. */
  async getElicitationEscalationMinutes(): Promise<number> {
    const d1 = createD1(this.env.D1);
    const row = await d1
      .select({ metadata: organization.metadata })
      .from(organization)
      .where(eq(organization.id, this.organizationId))
      .get();
    const parsed = safeJSON(row?.metadata ?? null) as Record<
      string,
      unknown
    > | null;
    const value = parsed?.elicitationEscalateAfterMinutes;
    return typeof value === "number" && value > 0 ? value : 240;
  }

  /** PILE-419 — the human's answer to a suspended lane. Records a `response`
   *  activity parented to the elicitation, closes the question's span, and
   *  resumes the session (`running`, or back to `waiting` when it's still
   *  queued behind a blocker lane). `delivery` records how the answer
   *  reached the agent: pushed into a live sandbox ("sent") or left on the
   *  event stream for an externally-managed session to poll ("queued"). */
  async respondToElicitation(
    sessionId: string,
    input: { answer: string; actorId?: string; delivery: "sent" | "queued" }
  ) {
    await this.ready;
    const session = await this.getAgentSession(sessionId);
    if (!session) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Session not found",
      });
    }
    const elicitationId = session.awaitingActivityId;
    if (!elicitationId) {
      throw new VortexError({
        code: "CONFLICT",
        status: 409,
        message: "Session is not awaiting input",
      });
    }
    const response = await this.addAgentActivity({
      sessionId,
      actorId: input.actorId,
      type: "response",
      message: input.answer,
      parentId: elicitationId,
      payload: { elicitationId },
    });
    // Close the elicitation span — its durationMs is the answer latency.
    await data.closeAgentActivity(this.db, elicitationId).catch(() => null);
    const resumeStatus = session.queuedAfter ? "waiting" : "running";
    await this.applyAgentSessionResult(
      sessionId,
      { status: resumeStatus },
      input.actorId
    );
    // Resuming to `waiting` (queue-parked) doesn't trip the non-waiting
    // clear in applyAgentSessionResult — the question is answered either
    // way, so the marker always comes off here.
    const updated = await data.updateAgentSession(
      this.db,
      this.organizationId,
      sessionId,
      { awaitingActivityId: null, awaitingEscalatedAt: null }
    );
    await data.addAgentSessionEvent(this.db, {
      sessionId,
      type: "elicitation.response",
      message: "Elicitation answered",
      payload: {
        elicitationId,
        responseActivityId: response.id,
        answer: input.answer.slice(0, 2000),
        delivery: input.delivery,
      },
    });
    return updated ?? (await this.getAgentSession(sessionId));
  }

  /** PILE-419 — an unanswered elicitation past the workspace window fires
   *  once (awaitingEscalatedAt is the dedupe): escalated event, status
   *  activity, and a `lane_elicitation_escalated` notification to the same
   *  human the original question routed to. */
  async escalateElicitation(sessionId: string): Promise<void> {
    await this.ready;
    const session = await this.getAgentSession(sessionId);
    if (
      !session?.awaitingActivityId ||
      session.awaitingEscalatedAt ||
      ["completed", "failed", "canceled"].includes(session.status)
    ) {
      return;
    }
    const elicitation = await data.getAgentActivity(
      this.db,
      session.awaitingActivityId
    );
    const now = new Date().toISOString();
    // Stamp before fanout — a notification failure must not re-fire the
    // escalation on every sweep pass.
    await data.updateAgentSession(this.db, this.organizationId, sessionId, {
      awaitingEscalatedAt: now,
    });
    const issue = await this.getIssue(session.issueId);
    const askedAt = elicitation?.createdAt
      ? Math.max(
          0,
          Math.round(
            (Date.parse(now) - Date.parse(elicitation.createdAt)) / 60000
          )
        )
      : null;
    await data.addAgentSessionEvent(this.db, {
      sessionId,
      type: "session.elicitation_escalated",
      message: "Elicitation unanswered — escalated",
      payload: {
        elicitationId: session.awaitingActivityId,
        issueId: issue?.id ?? null,
        unansweredMinutes: askedAt,
      },
    });
    await this.addAgentActivity({
      sessionId,
      type: "status",
      system: true,
      message:
        askedAt === null
          ? "Elicitation unanswered — escalated"
          : `Elicitation unanswered for ${askedAt}m — escalated`,
      parentId: session.awaitingActivityId,
    });
    const humanAssignee =
      issue?.assigneeId && !issue.assigneeId.startsWith("lane:")
        ? issue.assigneeId
        : null;
    const recipientId = humanAssignee ?? session.actorId;
    const recipientType: data.RecipientType = humanAssignee
      ? "user"
      : session.actorType;
    if (recipientId && issue) {
      await this.createNotification({
        recipientId,
        recipientType,
        issueId: issue.id,
        type: "lane_elicitation_escalated",
        metadata: {
          sessionId,
          elicitationId: session.awaitingActivityId,
          question: elicitation?.message ?? null,
          unansweredMinutes: askedAt,
        },
      });
    }
  }

  async addAgentSessionArtifact(input: {
    sessionId: string;
    actorId?: string;
    name: string;
    type: string;
    content?: string;
    data?: string;
    mimeType?: string;
    url?: string;
  }) {
    const session = await this.getAgentSession(input.sessionId);
    if (!session) {
      throw new VortexError({
        code: "NOT_FOUND",
        status: 404,
        message: "Session not found",
      });
    }

    const artifactId = crypto.randomUUID();
    const payload: Record<string, unknown> = {
      artifactId,
      name: input.name,
      type: input.type,
      provider: session.provider,
      providerSessionId: session.providerSessionId,
    };

    if (input.content !== undefined) payload.content = input.content;
    if (input.url !== undefined) payload.url = input.url;
    if (input.mimeType !== undefined) payload.mimeType = input.mimeType;

    if (input.data) {
      if (this.env.ATTACHMENTS_BUCKET) {
        const binary = new Uint8Array(
          Array.from(atob(input.data), (char) => char.charCodeAt(0))
        );
        const r2Key = `artifacts/${this.organizationId}/${input.sessionId}/${artifactId}`;
        await this.env.ATTACHMENTS_BUCKET.put(r2Key, binary, {
          httpMetadata: {
            contentType: input.mimeType ?? "application/octet-stream",
            contentDisposition: `attachment; filename="${input.name}"`,
          },
        });
        payload.r2Key = r2Key;
        const attachment = await this.createAttachment({
          issueId: session.issueId,
          linearId: artifactId,
          url: input.url ?? "",
          title: input.name,
          subtitle:
            [input.type, input.mimeType].filter(Boolean).join(" / ") || null,
          r2Key,
        });
        payload.attachmentId = attachment?.id;
      } else {
        payload.data = input.data;
      }
    } else if (input.url) {
      const attachment = await this.createAttachment({
        issueId: session.issueId,
        linearId: artifactId,
        url: input.url,
        title: input.name,
        subtitle:
          [input.type, input.mimeType].filter(Boolean).join(" / ") || null,
        r2Key: null,
      });
      payload.attachmentId = attachment?.id;
    }

    return this.addAgentActivity({
      sessionId: input.sessionId,
      actorId: input.actorId,
      type: "artifact",
      message: `Artifact: ${input.name}`,
      payload,
    });
  }

  addAgentSessionEvent(input: data.AgentSessionEventInput) {
    return data.addAgentSessionEvent(this.db, input);
  }

  listAgentSessionEvents(
    sessionId: string,
    options: {
      afterId?: number;
      limit?: number;
      order?: "asc" | "desc";
    } = {}
  ) {
    return data.listAgentSessionEvents(this.db, sessionId, options);
  }

  listAgentTimeline(sessionId: string, options: { limit?: number } = {}) {
    return data.listAgentTimeline(this.db, sessionId, options);
  }

  // ---- agent provider configs ----
  memoryRemember(input: data.MemoryInput) {
    return data.memoryRemember(this.db, this.organizationId, input);
  }

  memoryRecall(query: {
    entityType?: string;
    entityId?: string;
    kind?: string;
    search?: string;
    limit?: number;
  }) {
    return data.memoryRecall(this.db, this.organizationId, query);
  }

  upsertAgentProviderConfig(input: data.AgentProviderConfigInput) {
    return data.upsertAgentProviderConfig(this.db, this.organizationId, input);
  }

  getAgentProviderConfig(agentId: string) {
    return data.getAgentProviderConfig(this.db, this.organizationId, agentId);
  }

  listAgentProviderConfigs() {
    return data.listAgentProviderConfigs(this.db, this.organizationId);
  }

  deleteAgentProviderConfig(agentId: string) {
    return data.deleteAgentProviderConfig(
      this.db,
      this.organizationId,
      agentId
    );
  }

  listAgentEnvironmentFiles() {
    return data.listAgentEnvironmentFiles(this.db, this.organizationId);
  }

  getAgentEnvironmentFile(path: string) {
    return data.getAgentEnvironmentFile(this.db, this.organizationId, path);
  }

  upsertAgentEnvironmentFile(path: string, content: string) {
    return data.upsertAgentEnvironmentFile(
      this.db,
      this.organizationId,
      path,
      content
    );
  }

  deleteAgentEnvironmentFile(path: string) {
    return data.deleteAgentEnvironmentFile(this.db, this.organizationId, path);
  }

  listAgentActivities(
    sessionId: string,
    options: { limit?: number; order?: "asc" | "desc" } = {}
  ) {
    return data.listAgentActivities(this.db, sessionId, options);
  }

  getAgentSessionWithActivities(id: string) {
    return data.getAgentSessionWithActivities(this.db, this.organizationId, id);
  }

  getActiveAgentSessionForIssue(issueId: string) {
    return data.getActiveAgentSessionForIssue(
      this.db,
      this.organizationId,
      issueId
    );
  }

  async applyAgentSessionResult(
    sessionId: string,
    rawResult: AgentSessionResult,
    actorId?: string
  ): Promise<AgentSession | undefined> {
    await this.ready;
    const oldSession = await this.getAgentSession(sessionId);
    if (!oldSession) return undefined;

    const issue = await this.getIssue(oldSession.issueId);
    const result = sanitizeLaneResult(rawResult, issue?.repo ?? null);

    const terminal = new Set<AgentSessionStatus>([
      "completed",
      "failed",
      "canceled",
    ]);
    const oldStatus = oldSession.status as AgentSessionStatus;
    const newStatus = result.status;
    const becameTerminal = !terminal.has(oldStatus) && terminal.has(newStatus);

    // PILE-289 — validate the lane's final output against the dispatch-time
    // result schema. Only finished runs are judged; mid-run polls carry
    // partial text that would always fail.
    const structuredSet: Record<string, string | null> = {};
    if (
      oldSession.resultSchema &&
      typeof result.result === "string" &&
      (newStatus === "completed" || newStatus === "failed")
    ) {
      const evaluation = evaluateLaneResult(
        oldSession.resultSchema,
        result.result
      );
      structuredSet.structuredResult = evaluation.valid
        ? JSON.stringify(evaluation.value)
        : null;
      structuredSet.resultSchemaErrors = evaluation.valid
        ? null
        : JSON.stringify(evaluation.errors);
    }

    const buildSessionEventPayloads = (
      updatedSession: AgentSession
    ): data.AgentSessionEventInput[] => {
      const payloads: data.AgentSessionEventInput[] = [];
      for (const field of [
        "status",
        "result",
        "url",
        "providerSessionId",
        "prUrl",
        "prState",
        "branch",
      ] as const) {
        const oldValue = oldSession[field];
        const newValue = updatedSession[field];
        if (newValue !== oldValue) {
          payloads.push({
            sessionId,
            type: `session.${field}`,
            message: `Session ${field} changed`,
            payload: { field, old: oldValue, new: newValue },
          });
        }
      }
      if (
        updatedSession.structuredResult !== oldSession.structuredResult ||
        updatedSession.resultSchemaErrors !== oldSession.resultSchemaErrors
      ) {
        const valid = updatedSession.structuredResult !== null;
        payloads.push({
          sessionId,
          type: "session.structured_result",
          message: valid
            ? "Lane result matched the result schema"
            : "Lane result failed result-schema validation",
          payload: valid
            ? {
                valid,
                value: JSON.parse(updatedSession.structuredResult ?? "null"),
              }
            : {
                valid,
                errors: JSON.parse(updatedSession.resultSchemaErrors ?? "[]"),
              },
        });
      }
      if (becameTerminal) {
        payloads.push({
          sessionId,
          type: "session.terminal",
          message: `Session ${updatedSession.status}`,
          payload: { status: updatedSession.status },
        });
        // PILE-231 — one digest event per run: Pile-owned fields (status,
        // duration, PR) merged with whatever the provider's result JSON
        // carries under `digest` (files changed, commits, runner timing).
        const summary: Record<string, unknown> = {
          status: updatedSession.status,
          durationMs: updatedSession.createdAt
            ? Date.now() - Date.parse(updatedSession.createdAt)
            : null,
          prUrl: updatedSession.prUrl ?? null,
          branch: updatedSession.branch ?? null,
          agentId: updatedSession.agentId,
          label: updatedSession.label ?? null,
        };
        if (updatedSession.structuredResult !== null) {
          summary.structuredResult = JSON.parse(
            updatedSession.structuredResult
          );
        }
        try {
          const parsed = JSON.parse(updatedSession.result ?? "") as {
            digest?: Record<string, unknown>;
          };
          if (parsed && typeof parsed === "object" && parsed.digest) {
            summary.digest = parsed.digest;
          }
        } catch {
          // result is plain text for most providers — no digest to merge
        }
        payloads.push({
          sessionId,
          type: "session.summary",
          message: "Run summary",
          payload: summary,
        });
      }
      return payloads;
    };

    if (!issue) {
      const set: Record<string, string | number | null> = {
        updatedAt: new Date().toISOString(),
        lastProgressAt: new Date().toISOString(),
      };
      if (result.status !== undefined) {
        set.status = result.status;
        if (terminal.has(result.status) && !oldSession.endedAt)
          set.endedAt = set.updatedAt;
        if (!terminal.has(result.status) && oldSession.endedAt)
          set.endedAt = null;
        // PILE-419 — leaving `waiting` closes any open elicitation (the
        // lane resumed or died without an answer).
        if (result.status !== "waiting") {
          set.awaitingActivityId = null;
          set.awaitingEscalatedAt = null;
        }
      }
      if (result.infraFailure !== undefined)
        set.infraFailure = result.infraFailure ? 1 : 0;
      if (result.result !== undefined) set.result = result.result;
      if (result.url !== undefined) set.url = result.url;
      if (result.providerSessionId !== undefined)
        set.providerSessionId = result.providerSessionId;
      // Empty result values mean "the run didn't report", not "field
      // cleared" — a follow-up run that produces no PR must not wipe the
      // PR the lane already has. Clearing lives in the sweep's reconcile.
      if (result.prUrl) set.prUrl = result.prUrl;
      if (result.prState) set.prState = result.prState;
      if (result.branch) set.branch = result.branch;
      Object.assign(set, structuredSet);
      const rows = await this.db
        .update(workspaceAgentSessions)
        .set(set)
        .where(eq(workspaceAgentSessions.id, sessionId))
        .returning()
        .all();
      const updatedSession = rows[0] as AgentSession | undefined;
      if (!updatedSession) return undefined;

      await Promise.all(
        buildSessionEventPayloads(updatedSession).map((event) =>
          this.addAgentSessionEvent(event)
        )
      );
      if (result.usage) {
        await this.recordSessionUsage(sessionId, result.usage);
      }
      if (becameTerminal) {
        await this.finalizeRunReceipt(updatedSession);
      }
      return updatedSession;
    }

    const set: Record<string, string | number | null> = {
      updatedAt: new Date().toISOString(),
      lastProgressAt: new Date().toISOString(),
    };
    if (result.status !== undefined) {
      set.status = result.status;
      if (terminal.has(result.status) && !oldSession.endedAt)
        set.endedAt = set.updatedAt;
      // Resumed lane: clear the anchor so the kept-sandbox window restarts
      // when it re-ends — otherwise the reaper keys off the ORIGINAL end
      // and can destroy a sandbox that's actively working a follow-up.
      if (!terminal.has(result.status) && oldSession.endedAt)
        set.endedAt = null;
      // PILE-419 — leaving `waiting` closes any open elicitation (answered
      // via /respond, provider un-parked on its own, or went terminal).
      if (result.status !== "waiting") {
        set.awaitingActivityId = null;
        set.awaitingEscalatedAt = null;
      }
    }
    if (result.infraFailure !== undefined)
      set.infraFailure = result.infraFailure ? 1 : 0;
    if (result.result !== undefined) set.result = result.result;
    if (result.url !== undefined) set.url = result.url;
    if (result.providerSessionId !== undefined)
      set.providerSessionId = result.providerSessionId;
    if (result.prUrl) set.prUrl = result.prUrl;
    if (result.prState) set.prState = result.prState;
    if (result.branch) set.branch = result.branch;
    Object.assign(set, structuredSet);

    const updatedSession = await this.db
      .update(workspaceAgentSessions)
      .set(set)
      .where(eq(workspaceAgentSessions.id, sessionId))
      .returning()
      .get();
    if (!updatedSession) return undefined;

    let sessionEventPayloads = buildSessionEventPayloads(updatedSession);

    const statusChanged = updatedSession.status !== oldSession.status;
    const resultChanged = updatedSession.result !== oldSession.result;
    const shouldRecordActivity =
      statusChanged ||
      (resultChanged && (newStatus === "completed" || newStatus === "failed"));

    if (shouldRecordActivity) {
      const activityType =
        newStatus === "completed"
          ? "response"
          : newStatus === "failed"
            ? "error"
            : "status";
      const activityMessage =
        newStatus === "completed"
          ? (result.result ?? "Session completed")
          : newStatus === "failed"
            ? (result.result ?? "Session failed")
            : `Session ${newStatus}`;
      await this.addAgentActivity({
        sessionId,
        actorId,
        type: activityType,
        message: activityMessage,
      });
    }

    const issueSet: Record<string, string | null> = {
      updatedAt: new Date().toISOString(),
    };
    const historyEntries: Array<{
      field: string;
      fromValue: string | null;
      toValue: string | null;
    }> = [];

    // A prUrl maps to exactly one issue — a lane reporting a URL another
    // issue already claims has its link (and its prState, which describes
    // that same PR) dropped rather than forking webhook comment routing.
    const claimedBy = result.prUrl
      ? await this.getIssueByPrUrl(result.prUrl)
      : undefined;
    const prClaimedElsewhere =
      claimedBy !== undefined && claimedBy.id !== issue.id;

    if (result.prUrl && result.prUrl !== issue.prUrl && !prClaimedElsewhere) {
      issueSet.prUrl = result.prUrl;
      historyEntries.push({
        field: "pr_url",
        fromValue: issue.prUrl,
        toValue: result.prUrl,
      });
      // The stored states describe the previous PR — re-pointing clears
      // whatever the lane didn't re-report (same rule as updateIssue).
      if (!result.prState && issue.prState !== null) {
        issueSet.prState = null;
        historyEntries.push({
          field: "pr_state",
          fromValue: issue.prState,
          toValue: null,
        });
      }
      if (issue.prCheckState !== null) {
        issueSet.prCheckState = null;
        historyEntries.push({
          field: "pr_check_state",
          fromValue: issue.prCheckState,
          toValue: null,
        });
      }
    }
    if (
      result.prState &&
      result.prState !== issue.prState &&
      !prClaimedElsewhere
    ) {
      issueSet.prState = result.prState;
      historyEntries.push({
        field: "pr_state",
        fromValue: issue.prState,
        toValue: result.prState,
      });
    }
    if (result.branch && result.branch !== issue.branch) {
      issueSet.branch = result.branch;
      historyEntries.push({
        field: "branch",
        fromValue: issue.branch,
        toValue: result.branch,
      });
    }

    const notStartedStatuses: IssueStatus[] = ["triage", "backlog", "todo"];
    const terminalIssueStatuses = new Set<IssueStatus>(["done", "canceled"]);
    if (
      (newStatus === "created" ||
        newStatus === "running" ||
        newStatus === "waiting") &&
      updatedSession.purpose !== TRIAGE_PURPOSE &&
      notStartedStatuses.includes(issue.status) &&
      !terminalIssueStatuses.has(issue.status)
    ) {
      issueSet.status = "in_progress";
      historyEntries.push({
        field: "status",
        fromValue: issue.status,
        toValue: "in_progress",
      });
    }

    if (
      newStatus === "completed" &&
      !terminalIssueStatuses.has(issue.status) &&
      result.prState
    ) {
      const prStateStatusMap: Record<string, IssueStatus | undefined> = {
        merged: "done",
        closed: "canceled",
      };
      const statusFromPr = prStateStatusMap[result.prState];
      if (statusFromPr && statusFromPr !== issue.status) {
        issueSet.status = statusFromPr;
        historyEntries.push({
          field: "status",
          fromValue: issue.status,
          toValue: statusFromPr,
        });
      }
    }

    // PILE-229: release the lane's ownership marker when the run ends.
    if (becameTerminal && issue.assigneeId === `lane:${sessionId}`) {
      issueSet.assigneeId = null;
      historyEntries.push({
        field: "assignee_id",
        fromValue: issue.assigneeId,
        toValue: null,
      });
    }

    let updatedIssue: Issue | undefined;
    if (Object.keys(issueSet).length > 1) {
      updatedIssue = await this.db
        .update(workspaceIssues)
        .set(issueSet)
        .where(eq(workspaceIssues.id, issue.id))
        .returning()
        .get();
      if (updatedIssue) {
        if (historyEntries.length > 0) {
          await this.recordIssueHistory(issue.id, historyEntries, actorId);
        }
        await this.emit({
          type: "issue.updated",
          organizationId: this.organizationId,
          issue: updatedIssue,
        });
        if (
          result.prUrl !== undefined ||
          result.prState !== undefined ||
          result.branch !== undefined
        ) {
          await this.emit({
            type: "pr.updated",
            organizationId: this.organizationId,
            issue: updatedIssue,
          });
        }
        if (updatedIssue.status !== issue.status) {
          await this.applyStatusAutomation(
            updatedIssue,
            issue,
            await getTeamById(
              createD1(this.env.D1),
              updatedIssue.teamId,
              this.organizationId
            ),
            actorId
          );
        }
      }

      const issueFields: Array<[string, string | null, string | null]> = [
        ["prUrl", issue.prUrl, updatedIssue.prUrl],
        ["prState", issue.prState, updatedIssue.prState],
        ["branch", issue.branch, updatedIssue.branch],
        ["status", issue.status, updatedIssue.status],
      ];
      for (const [field, oldValue, newValue] of issueFields) {
        if (newValue !== oldValue) {
          sessionEventPayloads.push({
            sessionId,
            type: `issue.${field}`,
            message: `Issue ${field} changed`,
            payload: { field, old: oldValue, new: newValue },
          });
        }
      }
    }

    if (
      newStatus === "completed" &&
      oldStatus !== "completed" &&
      (result.result || result.prUrl)
    ) {
      const isPlan = updatedSession.purpose === PLAN_PURPOSE;
      let commentIssue = updatedIssue ?? issue;
      let commentBody: string;
      if (updatedSession.purpose === TRIAGE_PURPOSE) {
        const triage = await this.applyTriageReport(
          commentIssue,
          updatedSession,
          result.result,
          actorId
        );
        commentBody = triage.body;
        commentIssue = triage.issue;
      } else if (isPlan) {
        commentBody = formatPlanComment(
          oldSession.agentId,
          extractPlanText(result.result) || "No plan — see session stream."
        );
      } else {
        commentBody =
          updatedSession.purpose === "preflight"
            ? `Preflight critique by ${oldSession.agentId}:\n\n${result.result ?? "No report — see session stream."}`
            : updatedSession.purpose === "review"
              ? `PR review by ${oldSession.agentId}:\n\n${result.result ?? "No report — see session stream."}`
              : result.prUrl
                ? `Agent ${oldSession.agentId} completed${result.result ? `: ${result.result}` : ""}\n\n${result.prUrl}`
                : `Agent ${oldSession.agentId} completed: ${result.result}`;
      }
      await this.recordLaneComment(
        commentIssue,
        {
          body: commentBody,
          externalAuthor: oldSession.agentId,
          externalSource: isPlan ? PLAN_COMMENT_SOURCE : "agent",
          externalId: oldSession.id,
        },
        oldSession,
        actorId
      );
    }

    // PILE-268 — a lane that dies (sweep stall-cancel, provider cancel,
    // failure) never produces the completed-run comment above, so the
    // issue stays silent about the outcome. Surface the terminal event:
    // outcome + reason + a pointer at the session stream.
    if (
      becameTerminal &&
      (newStatus === "failed" || newStatus === "canceled")
    ) {
      const reason = updatedSession.result?.trim();
      const commentBody =
        `Agent ${oldSession.agentId} ${newStatus}${reason ? `: ${reason}` : ""}` +
        `\n\nSession ${oldSession.id}` +
        (updatedSession.url ? `\n${updatedSession.url}` : "");
      await this.recordLaneComment(
        updatedIssue ?? issue,
        {
          body: commentBody,
          externalAuthor: oldSession.agentId,
          externalSource: "agent",
          externalId: `${oldSession.id}:terminal`,
        },
        oldSession,
        actorId
      );
    }

    await this.syncLaneProgressComment(sessionId, {
      create: true,
      actorId,
      throttleMs:
        sessionEventPayloads.length > 0 ? 0 : LANE_PROGRESS_HEARTBEAT_MS,
    });

    await Promise.all(
      sessionEventPayloads.map((event) => this.addAgentSessionEvent(event))
    );

    await this.emit({
      type: "agent_session.updated",
      organizationId: this.organizationId,
      session: updatedSession,
      issue: updatedIssue ?? issue,
    });

    if (becameTerminal) {
      const terminalEventType: RealtimeEvent["type"] =
        newStatus === "completed"
          ? "agent_session.completed"
          : newStatus === "failed"
            ? "agent_session.failed"
            : "agent_session.canceled";
      await this.emit({
        type: terminalEventType,
        organizationId: this.organizationId,
        session: updatedSession,
        issue: updatedIssue ?? issue,
      });

      // childSessionUpdate (PILE-211): a spawning lane reads its children's
      // outcomes off its own event stream instead of polling each child.
      if (updatedSession.parentSessionId) {
        await this.addAgentSessionEvent({
          sessionId: updatedSession.parentSessionId,
          type: "child.terminal",
          message: `Child session ${updatedSession.id} ${updatedSession.status}`,
          payload: {
            childSessionId: updatedSession.id,
            childIssueId: updatedSession.issueId,
            status: updatedSession.status,
            prUrl: updatedSession.prUrl,
            branch: updatedSession.branch,
            result: updatedSession.result?.slice(0, 2000) ?? null,
          },
        }).catch(() => {});
      }
    }

    // PILE-425 — the run receipt: a `usage` payload on this result updates
    // the receipt's usage fields; the terminal transition finalizes it
    // (status, end time, duration) even when the lane never reported usage.
    if (result.usage) {
      await this.recordSessionUsage(sessionId, result.usage);
    }
    if (becameTerminal) {
      await this.finalizeRunReceipt(updatedSession);
    }

    return updatedSession;
  }

  listWorkspaceAgentSessions() {
    return this.db.select().from(workspaceAgentSessions).all();
  }

  listWorkspaceAgentActivities() {
    return this.db.select().from(workspaceAgentActivities).all();
  }

  // ---- webhook subscriptions / outbound deliveries ----
  listWebhookSubscriptions() {
    return data.listWebhookSubscriptions(this.db, this.organizationId);
  }

  getWebhookSubscription(id: string) {
    return data.getWebhookSubscription(this.db, id);
  }

  findWebhookSubscriptionByWorkspace(id: string) {
    return data.findWebhookSubscriptionByWorkspace(
      this.db,
      this.organizationId,
      id
    );
  }

  createWebhookSubscription(values: {
    url: string;
    events?: string;
    secret?: string;
  }) {
    return data.createWebhookSubscription(this.db, this.organizationId, values);
  }

  updateWebhookSubscription(
    id: string,
    values: { url?: string; events?: string; secret?: string }
  ) {
    return data.updateWebhookSubscription(
      this.db,
      this.organizationId,
      id,
      values
    );
  }

  deleteWebhookSubscription(id: string) {
    return data.deleteWebhookSubscription(this.db, this.organizationId, id);
  }

  // ---- MCP server registry ----
  async createMcpServer(input: {
    id?: string;
    name: string;
    url: string;
    scope: "workspace" | "repo" | "issue";
    repo?: string | null;
    issueId?: string | null;
  }) {
    await this.ready;
    const now = new Date().toISOString();
    const id = input.id ?? crypto.randomUUID();
    const row = await this.db
      .insert(workspaceMcpServers)
      .values({
        id,
        organizationId: this.organizationId,
        name: input.name,
        url: input.url,
        scope: input.scope,
        repo: input.repo ?? null,
        issueId: input.issueId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return row;
  }

  async getMcpServer(id: string) {
    await this.ready;
    return this.db
      .select()
      .from(workspaceMcpServers)
      .where(
        and(
          eq(workspaceMcpServers.id, id),
          eq(workspaceMcpServers.organizationId, this.organizationId)
        )
      )
      .get();
  }

  async listMcpServers(scope?: "workspace" | "repo" | "issue") {
    await this.ready;
    return this.db
      .select()
      .from(workspaceMcpServers)
      .where(
        and(
          eq(workspaceMcpServers.organizationId, this.organizationId),
          scope ? eq(workspaceMcpServers.scope, scope) : undefined
        )
      )
      .all();
  }

  async deleteMcpServer(id: string) {
    await this.ready;
    const row = await this.db
      .delete(workspaceMcpServers)
      .where(
        and(
          eq(workspaceMcpServers.id, id),
          eq(workspaceMcpServers.organizationId, this.organizationId)
        )
      )
      .returning()
      .get();
    return row;
  }

  listWebhookDeliveries(subscriptionId: string) {
    return data.listWebhookDeliveries(
      this.db,
      this.organizationId,
      subscriptionId
    );
  }

  listWorkspaceOutboundDeliveries() {
    return this.db.select().from(workspaceOutboundWebhookDeliveries).all();
  }

  // For tests / recovery: redeliver pending outbound deliveries.
  deliverWebhooks(event: RealtimeEvent) {
    return deliverWebhooks(this.db, this.env, this.organizationId, event);
  }

  retryWebhookDeliveries() {
    return retryWebhookDeliveries(this.db, this.env, this.organizationId);
  }

  private audit(
    action: string,
    entityType: string,
    entityId: string,
    actorId?: string | null,
    changes?: Record<string, { from: unknown; to: unknown }> | null,
    meta?: {
      actorType?: string | null;
      ip?: string | null;
      country?: string | null;
      userAgent?: string | null;
    }
  ) {
    const entry = data.recordAuditEntry(this.db, {
      organizationId: this.organizationId,
      actorId,
      actorType: meta?.actorType ?? null,
      action,
      entityType,
      entityId,
      changes: changes ?? null,
      ip: meta?.ip ?? null,
      country: meta?.country ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    // SIEM fanout: deliver to webhook subscribers only (not websockets —
    // the audit stream must not broadcast to every connected client).
    this.ctx.waitUntil(
      this.sendWebhookEvent({
        type: "audit.entry",
        organizationId: this.organizationId,
        entry: {
          id: entry.id,
          actorId: entry.actorId,
          actorType: entry.actorType,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          changes: entry.changes
            ? (JSON.parse(entry.changes) as Record<
                string,
                { from: unknown; to: unknown }
              >)
            : null,
          ip: entry.ip,
          country: entry.country,
          userAgent: entry.userAgent,
          createdAt: entry.createdAt,
        },
      })
    );
    return entry;
  }

  // Public RPC for API-layer events (token create/revoke, member changes,
  // workspace settings) that live outside the DO.
  async recordAudit(
    action: string,
    entityType: string,
    entityId: string,
    actorId?: string | null,
    changes?: Record<string, { from: unknown; to: unknown }> | null,
    meta?: {
      actorType?: string | null;
      ip?: string | null;
      country?: string | null;
      userAgent?: string | null;
    }
  ) {
    await this.ready;
    return this.audit(action, entityType, entityId, actorId, changes, meta);
  }

  async listAuditLog(
    args: {
      entityType?: string;
      entityId?: string;
      action?: string;
      actorId?: string;
      limit?: number;
    } = {},
    viewer?: IssueViewer
  ) {
    await this.ready;
    return data.listAuditLog(this.db, this.organizationId, {
      ...args,
      excludeIssueCondition: this.hiddenIssueConditionFor(
        viewer,
        workspaceAuditLog.entityId
      ),
    });
  }

  async getAuditLogEntry(id: string) {
    await this.ready;
    return data.getAuditLogEntry(this.db, this.organizationId, id);
  }

  private async recordIssueHistory(
    issueId: string,
    entries: ReadonlyArray<{
      field: string;
      fromValue: string | null;
      toValue: string | null;
    }>,
    actorId?: string
  ) {
    if (entries.length === 0) return;
    const ts = new Date().toISOString();
    await this.db.insert(workspaceIssueHistory).values(
      entries.map((entry) => ({
        id: crypto.randomUUID(),
        organizationId: this.organizationId,
        issueId,
        linearId: null,
        field: entry.field,
        fromValue: entry.fromValue,
        toValue: entry.toValue,
        actorId: actorId ?? null,
        createdAt: ts,
      }))
    );
  }

  // Full history insert used by the Linear importer (keeps source timestamps).
  async createIssueHistory(values: {
    issueId: string;
    linearId: string | null;
    field: string;
    fromValue?: string | null;
    toValue?: string | null;
    actorId?: string | null;
    createdAt?: string;
  }): Promise<void> {
    await this.ready;
    await this.db.insert(workspaceIssueHistory).values({
      id: crypto.randomUUID(),
      organizationId: this.organizationId,
      issueId: values.issueId,
      linearId: values.linearId,
      field: values.field,
      fromValue: values.fromValue ?? null,
      toValue: values.toValue ?? null,
      actorId: values.actorId ?? null,
      createdAt: values.createdAt ?? new Date().toISOString(),
    });
  }

  async listIssueHistory(issueId: string) {
    await this.ready;
    return this.db
      .select()
      .from(workspaceIssueHistory)
      .where(eq(workspaceIssueHistory.issueId, issueId))
      .orderBy(workspaceIssueHistory.createdAt)
      .all();
  }

  async listWorkspaceIssueHistory() {
    await this.ready;
    return this.db.select().from(workspaceIssueHistory).all();
  }

  async createIssue(
    input: IssueInput,
    actorId?: string,
    // notify:false suppresses the directed issue_assigned emit — bulk
    // importers run as member actors so the member check alone can't tell
    // a migration apart from a human assigning one issue. The generic
    // broadcast still runs.
    options?: { notify?: boolean }
  ): Promise<Issue> {
    const { issue } = await this.createIssueRecord(
      input,
      actorId,
      undefined,
      options
    );
    if (!issue) throw new Error("Failed to create issue");
    return issue;
  }

  // PILE-163 — create and report possible duplicates. The lookup runs in the
  // same storage-only critical section as the insert, so with block=true two
  // concurrent creates of the same title cannot both succeed. `issue` is null
  // when blocked.
  createIssueWithDuplicates(
    input: IssueInput,
    actorId: string | undefined,
    dedupe: { teamIds: string[]; block: boolean; viewer?: IssueViewer },
    options?: { notify?: boolean }
  ) {
    return this.createIssueRecord(input, actorId, dedupe, options);
  }

  private async createIssueRecord(
    input: IssueInput,
    actorId?: string,
    dedupe?: { teamIds: string[]; block: boolean; viewer?: IssueViewer },
    options?: { notify?: boolean }
  ): Promise<{
    issue: Issue | null;
    possibleDuplicates: Array<{ issue: Issue; score: number }>;
  }> {
    await this.ready;
    const now = new Date().toISOString();
    const id = input.id ?? crypto.randomUUID();

    const existing = await this.getIssue(id);
    if (existing) return { issue: existing, possibleDuplicates: [] };
    if (input.externalRef) {
      const byRef = await this.getIssueByExternalRef(input.externalRef);
      if (byRef) return { issue: byRef, possibleDuplicates: [] };
    }

    const status = input.status ?? "backlog";
    const resolution = validateIssueResolution(
      status,
      input.resolution ?? null,
      input.resolutionReason ?? null
    );

    const parent = await resolveParent(
      (parentIssueId) => this.getIssue(parentIssueId),
      input.parentId ?? null,
      id
    );
    if (parent?.parentId) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: "Sub-issues can only be nested one level",
      });
    }
    let teamId = input.teamId;
    let priority = input.priority;
    let projectId = input.projectId;
    let cycleId = input.cycleId;
    if (parent) {
      if (teamId === undefined) teamId = parent.teamId;
      if (priority === undefined) priority = parent.priority;
      if (projectId === undefined) projectId = parent.projectId;
      if (cycleId === undefined) cycleId = parent.cycleId;
    }
    const resolvedPriority = priority ?? "medium";
    const resolvedProjectId = projectId ?? null;
    const resolvedCycleId = cycleId ?? null;

    const d1 = createD1(this.env.D1);
    const workspace = await getWorkspaceById(d1, this.organizationId);
    const team = teamId
      ? await getTeamById(d1, teamId, this.organizationId)
      : await getDefaultTeam(d1, this.organizationId);
    if (!team) {
      throw new Error(
        input.teamId ? "Team not found" : "Workspace has no default team"
      );
    }
    const resolvedAssigneeId =
      input.assigneeId === undefined
        ? status === "triage"
          ? (team.triageAssigneeId ?? null)
          : null
        : input.assigneeId;

    const key = team.key || workspace?.key || "general";
    const last = await this.db
      .select({ number: sql<number | null>`MAX(number)` })
      .from(workspaceIssues)
      .where(eq(workspaceIssues.teamId, team.id))
      .get();
    const number = (last?.number ?? 0) + 1;
    const identifier = `${key}-${number}`;

    if (typeof input.repo === "string" && typeof input.branch === "string") {
      const branchExisting = await this.getIssueByBranch(
        input.repo,
        input.branch
      );
      if (branchExisting) {
        throw VortexError.fromCode(
          "CONFLICT",
          `Issue ${branchExisting.identifier} already uses repo ${input.repo} and branch ${input.branch}`
        );
      }
    }

    // Warn-mode dedupe is best-effort — on a cold DO (post-deploy
    // eviction) building the search index reads every issue/comment/doc
    // in the workspace (~tens of seconds on mature orgs), which used to
    // hang issue creation past the request budget. Use only an index that
    // is already built — even an in-flight build can exceed the request
    // budget, so never await it here. The skip warms the index off the
    // request path; dedupe=block keeps its guarantee by paying the build.
    const dedupeIndex = dedupe ? this.searchIndex : null;
    if (dedupe && !dedupeIndex) {
      if (dedupe.block) {
        await this.ensureSearchIndex();
      } else {
        this.ctx.waitUntil(this.ensureSearchIndex().catch(() => undefined));
      }
    }
    const possibleDuplicates =
      dedupe && (dedupe.block || dedupeIndex)
        ? await this.findPossibleDuplicates(
            input.title,
            dedupe.teamIds,
            5,
            dedupe.viewer
          )
        : [];
    if (dedupe?.block && possibleDuplicates.length > 0) {
      return { issue: null, possibleDuplicates };
    }

    const issue = await this.db
      .insert(workspaceIssues)
      .values({
        id,
        organizationId: this.organizationId,
        externalRef: input.externalRef ?? null,
        teamId: team.id,
        title: input.title,
        description: input.description ?? null,
        status,
        priority: resolvedPriority,
        resolution,
        resolutionReason: input.resolutionReason ?? null,
        parentId: parent?.id ?? null,
        subIssueSortOrder: input.subIssueSortOrder ?? null,
        estimate: input.estimate ?? null,
        isDraft: input.isDraft ?? false,
        sensitive: input.sensitive ?? false,
        snoozedUntil: input.snoozedUntil ?? null,
        assigneeId: resolvedAssigneeId,
        delegateId: input.delegateId ?? null,
        stepKey: input.stepKey ?? null,
        required: input.required ?? false,
        ownerAgent: input.ownerAgent ?? null,
        projectId: resolvedProjectId,
        cycleId: resolvedCycleId,
        labelIds: input.labelIds ?? null,
        number,
        identifier,
        repo: input.repo ?? null,
        branch: input.branch ?? null,
        prUrl: null,
        prState: null,
        prCheckState: null,
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
      })
      .onConflictDoNothing({ target: workspaceIssues.id })
      .returning()
      .get();

    if (!issue) {
      const recovered = await this.getIssue(id);
      if (recovered) return { issue: recovered, possibleDuplicates: [] };
      throw new Error("Failed to create issue");
    }

    await this.syncSearchIndex((index) => indexIssueDocument(index, issue));

    await this.emit({
      type: "issue.created",
      organizationId: this.organizationId,
      issue,
    });
    if (issue.isDraft) {
      await this.emit({
        type: "draft.created",
        organizationId: this.organizationId,
        issue,
      });
    }
    // An assignee on create hears issue_assigned when a member did the
    // assigning; machine actors (webhook syncs) and notify:false writes
    // (bulk imports) never trigger the directed emit — a bulk import must
    // not mass-email — and the assignee stays in the issue_created fan-out
    // instead.
    const createdAssignee =
      issue.assigneeId && !issue.assigneeId.startsWith("lane:")
        ? await this.resolveAssigneeUserId(issue.assigneeId)
        : null;
    const deliveredCreateAssign =
      options?.notify !== false &&
      createdAssignee !== null &&
      createdAssignee !== actorId &&
      (await this.isMemberActor(actorId));
    await this.notifyIssueEvent(
      issue,
      "issue_created",
      actorId,
      deliveredCreateAssign ? (createdAssignee ?? undefined) : undefined
    );
    await this.recordIssueHistory(
      issue.id,
      [{ field: "created", fromValue: null, toValue: issue.title }],
      actorId
    );
    this.audit("issue.created", "issue", issue.id, actorId);
    if (deliveredCreateAssign && createdAssignee) {
      await this.deliverNotification(
        {
          recipientId: createdAssignee,
          recipientType: "user",
          issueId: issue.id,
          type: "issue_assigned",
        },
        { issue }
      );
    }
    this.startTriageLane(issue, actorId);
    // PILE-411 — creating a record already inside a templated stage enters
    // that stage: materialize its sub-steps the same as a status change.
    if (!issue.parentId && !issue.isDraft) {
      await this.applyStageTemplates(
        "issue",
        issue.status,
        issue,
        [issue],
        actorId
      );
    }
    return { issue, possibleDuplicates };
  }

  // PILE-282 — fire-and-forget: a triage-lane failure (provider down, team
  // not configured) must never fail issue creation. The triage context is
  // computed here in the DO — dispatchTriageLane RPCing this same object
  // from inside a waitUntil task deadlocks the input gate (~40s → create
  // INTERNAL_ERROR). ensureSearchIndex is an internal call here (no RPC
  // boundary), so it may safely build off the request path; the batched
  // build yields so it can't starve the isolate.
  private startTriageLane(issue: Issue, actorId?: string) {
    if (!hasWorkspaceNamespace(this.env)) return;
    // Mirror dispatchTriageLane's bail conditions — building the context
    // (index + labels) for a draft/canceled issue is wasted work, and so is
    // building it for a team with no triageAgentId: the dispatch would bail
    // on the same check after paying for a cold search-index build. Resolve
    // the team first so a workspace without triage never warms the index.
    if (issue.isDraft || issue.status === "done" || issue.status === "canceled")
      return;
    // PILE-411 — a stage sub-step is machine-materialized work with its own
    // owner_agent, not an inbound issue needing triage.
    if (issue.stepKey) return;
    const env = this.env;
    this.ctx.waitUntil(
      getTeamById(createD1(env.D1), issue.teamId, this.organizationId)
        .then((team) =>
          team?.triageAgentId
            ? this.buildTriageContext(issue).then((context) =>
                dispatchTriageLane(
                  env,
                  this.organizationId,
                  issue,
                  actorId,
                  context
                )
              )
            : null
        )
        .catch((err: unknown) => {
          console.warn(
            `triage lane dispatch failed for ${issue.id}: ${err instanceof Error ? err.message : String(err)}`
          );
        })
    );
  }

  private async buildTriageContext(issue: Issue): Promise<{
    similar: Array<{ issue: Issue; score: number }>;
    labelNames: string[];
  }> {
    const [index, labels] = await Promise.all([
      this.ensureSearchIndex(),
      listLabels(createD1(this.env.D1), this.organizationId),
    ]);
    const hits = await findSimilarIssues(index, issue, [issue.teamId], 8);
    const matches = await Promise.all(
      hits.map((hit) => this.getIssue(hit.issueId))
    );
    const similar = hits.flatMap((hit, i) =>
      matches[i] ? [{ issue: matches[i] as Issue, score: hit.score }] : []
    );
    return {
      similar,
      labelNames: labels.filter((l) => l.kind === "issue").map((l) => l.name),
    };
  }

  private async applyTriageReport(
    issue: Issue,
    session: AgentSession,
    resultText: string | null | undefined,
    actorId?: string
  ): Promise<{ body: string; issue: Issue }> {
    const report = parseTriageReport(resultText);
    if (!report) {
      return {
        body: `Triage by ${session.agentId}:\n\n${resultText ?? "No report — see session stream."}`,
        issue,
      };
    }
    const labels = (
      await listLabels(createD1(this.env.D1), this.organizationId)
    ).filter((label) => label.kind === "issue");
    const plan = planTriageApplication(report, issue, labels);
    let current = issue;
    if (plan.addedLabelNames.length > 0) {
      current =
        (await this.updateIssue(
          issue.id,
          { labelIds: plan.labelIds.join(",") },
          actorId
        )) ?? issue;
    }
    const existing = new Set(
      (await this.listIssueRelations(issue.id)).map((r) => r.toIssueId)
    );
    const requested = [
      ...plan.duplicates.map((identifier) => ({
        identifier,
        type: "duplicate" as const,
      })),
      ...plan.similar.map((identifier) => ({
        identifier,
        type: "similar" as const,
      })),
    ];
    const targets = await Promise.all(
      requested.map(
        async ({ identifier }) =>
          (await this.getIssueByIdentifier(identifier)) ??
          (await this.getIssueByIdentifier(identifier.toUpperCase()))
      )
    );
    const linked = { duplicates: [] as string[], similar: [] as string[] };
    const toCreate: Array<{ toIssueId: string; type: string }> = [];
    requested.forEach(({ identifier, type }, i) => {
      const target = targets[i];
      if (!target || target.id === issue.id) return;
      if (!existing.has(target.id)) {
        toCreate.push({ toIssueId: target.id, type });
        existing.add(target.id);
      }
      linked[type === "duplicate" ? "duplicates" : "similar"].push(
        target.identifier ?? identifier
      );
    });
    await Promise.all(
      toCreate.map((relation) =>
        this.createIssueRelation({ fromIssueId: issue.id, ...relation })
      )
    );
    return {
      body: formatTriageComment(session.agentId, report, {
        labels: plan.addedLabelNames,
        ...linked,
      }),
      issue: current,
    };
  }

  async rolloverCycles(): Promise<{
    completedCycles: string[];
    activatedCycles: string[];
    rolledOver: number;
  }> {
    await this.ready;
    const d1 = createD1(this.env.D1);
    const nowIso = new Date().toISOString();

    const ended = await d1
      .select()
      .from(cycles)
      .where(
        and(
          eq(cycles.organizationId, this.organizationId),
          ne(cycles.status, "completed"),
          isNotNull(cycles.endDate),
          lt(cycles.endDate, nowIso)
        )
      )
      .all();

    // Activate cycles whose window has started (upcoming -> active).
    const activated = await d1
      .update(cycles)
      .set({ status: "active", updatedAt: nowIso })
      .where(
        and(
          eq(cycles.organizationId, this.organizationId),
          eq(cycles.status, "upcoming"),
          isNotNull(cycles.startDate),
          lt(cycles.startDate, nowIso),
          or(isNull(cycles.endDate), gte(cycles.endDate, nowIso))
        )
      )
      .returning({ id: cycles.id });

    if (ended.length === 0) {
      return {
        completedCycles: [],
        activatedCycles: activated.map((c) => c.id),
        rolledOver: 0,
      };
    }

    const endedIds = ended.map((cycle) => cycle.id);

    // Move unfinished issues first, then mark the cycle completed, so a
    // failure mid-pass leaves the cycle eligible for retry on the next run.
    const results = await Promise.all(
      ended.map(async (cycle) => {
        const nextCycle = await d1
          .select()
          .from(cycles)
          .where(
            and(
              eq(cycles.organizationId, this.organizationId),
              ne(cycles.status, "completed"),
              cycle.projectId === null
                ? isNull(cycles.projectId)
                : eq(cycles.projectId, cycle.projectId),
              or(isNull(cycles.endDate), gte(cycles.endDate, nowIso)),
              notInArray(cycles.id, endedIds)
            )
          )
          .orderBy(asc(cycles.startDate))
          .get();

        let moved = 0;
        if (cycle.autoRollover && nextCycle) {
          const unfinished = await this.db
            .select({ id: workspaceIssues.id })
            .from(workspaceIssues)
            .where(
              and(
                eq(workspaceIssues.cycleId, cycle.id),
                not(inArray(workspaceIssues.status, ["done", "canceled"]))
              )
            )
            .all();
          if (unfinished.length > 0) {
            await this.db
              .update(workspaceIssues)
              .set({ cycleId: nextCycle.id, updatedAt: nowIso })
              .where(
                inArray(
                  workspaceIssues.id,
                  unfinished.map((row) => row.id)
                )
              );
            moved = unfinished.length;
          }
        }

        await d1
          .update(cycles)
          .set({ status: "completed", updatedAt: nowIso })
          .where(eq(cycles.id, cycle.id));
        return { id: cycle.id, moved };
      })
    );

    return {
      completedCycles: results.map((r) => r.id),
      activatedCycles: activated.map((c) => c.id),
      rolledOver: results.reduce((sum, r) => sum + r.moved, 0),
    };
  }

  async shiftIssueCycle(
    fromCycleId: string,
    toCycleId: string
  ): Promise<{ moved: number }> {
    await this.ready;
    const moved = data.shiftIssueCycle(this.db, fromCycleId, toCycleId);
    return { moved };
  }
  async cycleCapacity(
    cycleId: string,
    teamIds?: string[]
  ): Promise<{
    issueCount: number;
    estimateTotal: number;
    byStatus: Record<string, { count: number; estimateTotal: number }>;
  }> {
    await this.ready;
    if (teamIds && teamIds.length === 0) {
      return { issueCount: 0, estimateTotal: 0, byStatus: {} };
    }
    const conditions = [eq(workspaceIssues.cycleId, cycleId)];
    if (teamIds) {
      conditions.push(inArray(workspaceIssues.teamId, teamIds));
    }
    const rows = await this.db
      .select({
        status: workspaceIssues.status,
        count: sql<number>`count(*)`,
        estimateTotal: sql<number>`coalesce(sum(${workspaceIssues.estimate}), 0)`,
      })
      .from(workspaceIssues)
      .where(and(...conditions))
      .groupBy(workspaceIssues.status)
      .all();
    const byStatus: Record<string, { count: number; estimateTotal: number }> =
      {};
    let issueCount = 0;
    let estimateTotal = 0;
    for (const row of rows) {
      byStatus[row.status] = {
        count: row.count,
        estimateTotal: row.estimateTotal,
      };
      issueCount += row.count;
      estimateTotal += row.estimateTotal;
    }
    return { issueCount, estimateTotal, byStatus };
  }

  async issueStats(
    groupBy:
      | "status"
      | "priority"
      | "assigneeId"
      | "delegateId"
      | "teamId"
      | "projectId"
      | "cycleId",
    teamIds?: string[],
    viewer?: IssueViewer
  ): Promise<{ group: string | null; count: number; estimateTotal: number }[]> {
    await this.ready;
    if (teamIds && teamIds.length === 0) return [];
    const columns = {
      status: workspaceIssues.status,
      priority: workspaceIssues.priority,
      assigneeId: workspaceIssues.assigneeId,
      delegateId: workspaceIssues.delegateId,
      teamId: workspaceIssues.teamId,
      projectId: workspaceIssues.projectId,
      cycleId: workspaceIssues.cycleId,
    };
    const column = columns[groupBy];
    const conditions = teamIds
      ? [inArray(workspaceIssues.teamId, teamIds)]
      : [];
    const exclude = this.hiddenIssueConditionFor(viewer, workspaceIssues.id);
    if (exclude) conditions.push(exclude);
    return this.db
      .select({
        group: column,
        count: sql<number>`count(*)`,
        estimateTotal: sql<number>`coalesce(sum(${workspaceIssues.estimate}), 0)`,
      })
      .from(workspaceIssues)
      .where(conditions.length ? and(...conditions) : undefined)
      .groupBy(column)
      .all();
  }

  async burndown(
    cycleId: string,
    teamIds?: string[],
    window?: { startDate?: string | null; endDate?: string | null },
    viewer?: IssueViewer
  ): Promise<{
    total: number;
    totalEstimate: number;
    series: { date: string; scope: number; remaining: number }[];
  }> {
    await this.ready;
    if (teamIds && teamIds.length === 0) {
      return { total: 0, totalEstimate: 0, series: [] };
    }
    const conditions = [eq(workspaceIssues.cycleId, cycleId)];
    if (teamIds) {
      conditions.push(inArray(workspaceIssues.teamId, teamIds));
    }
    const exclude = this.hiddenIssueConditionFor(viewer, workspaceIssues.id);
    if (exclude) conditions.push(exclude);
    const rows = await this.db
      .select({
        id: workspaceIssues.id,
        createdAt: workspaceIssues.createdAt,
        estimate: workspaceIssues.estimate,
      })
      .from(workspaceIssues)
      .where(and(...conditions))
      .all();
    if (rows.length === 0) {
      return { total: 0, totalEstimate: 0, series: [] };
    }
    const history = await this.db
      .select({
        issueId: workspaceIssueHistory.issueId,
        createdAt: workspaceIssueHistory.createdAt,
      })
      .from(workspaceIssueHistory)
      .where(
        and(
          eq(workspaceIssueHistory.field, "status"),
          inArray(workspaceIssueHistory.toValue, ["done", "canceled"]),
          inArray(
            workspaceIssueHistory.issueId,
            rows.map((row) => row.id)
          )
        )
      )
      .all();

    const doneAt = new Map<string, string>();
    for (const entry of history) {
      // Last terminal transition wins so a reopened issue burns back down.
      const prev = doneAt.get(entry.issueId);
      if (!prev || entry.createdAt > prev)
        doneAt.set(entry.issueId, entry.createdAt);
    }
    const currentStatus = new Map(
      (
        await this.db
          .select({ id: workspaceIssues.id, status: workspaceIssues.status })
          .from(workspaceIssues)
          .where(
            inArray(
              workspaceIssues.id,
              rows.map((row) => row.id)
            )
          )
          .all()
      ).map((row) => [row.id, row.status])
    );

    const dayMs = 24 * 60 * 60 * 1000;
    const windowStart = window?.startDate ? Date.parse(window.startDate) : 0;
    const today = Math.min(
      Date.now(),
      window?.endDate ? Date.parse(window.endDate) : Number.MAX_SAFE_INTEGER
    );
    const earliest = Math.min(...rows.map((row) => Date.parse(row.createdAt)));
    const start = Math.max(
      windowStart > 0 ? Math.min(windowStart, today) : earliest,
      today - 730 * dayMs
    );
    const series: { date: string; scope: number; remaining: number }[] = [];
    for (let t = start; t <= today; t += dayMs) {
      const dayEnd = new Date(t + dayMs - 1).toISOString();
      const scope = rows.filter(
        (row) => Date.parse(row.createdAt) <= t + dayMs
      ).length;
      const remaining = rows.filter((row) => {
        const terminal = ["done", "canceled"].includes(
          currentStatus.get(row.id) ?? ""
        );
        const done = terminal ? doneAt.get(row.id) : undefined;
        return (
          Date.parse(row.createdAt) <= t + dayMs && !(done && done <= dayEnd)
        );
      }).length;
      series.push({
        date: new Date(t).toISOString().slice(0, 10),
        scope,
        remaining,
      });
    }
    return {
      total: rows.length,
      totalEstimate: rows.reduce((sum, row) => sum + (row.estimate ?? 0), 0),
      series,
    };
  }

  // Accepts the issue's UUID or its human identifier (`KEY-123`) — agents and
  // humans think in identifiers, internals store UUIDs.
  async getIssue(id: string): Promise<Issue | undefined> {
    await this.ready;
    const byId = await this.db
      .select()
      .from(workspaceIssues)
      .where(eq(workspaceIssues.id, id))
      .get();
    if (byId) return byId;
    return this.getIssueByIdentifier(id);
  }

  async getIssueChildren(id: string, viewer?: IssueViewer): Promise<Issue[]> {
    await this.ready;
    const rows = await this.db
      .select()
      .from(workspaceIssues)
      .where(eq(workspaceIssues.parentId, id))
      .orderBy(
        asc(workspaceIssues.subIssueSortOrder),
        desc(workspaceIssues.createdAt)
      )
      .all();
    if (!viewer) return rows;
    const hidden = new Set(this.hiddenIssueIdsFor(viewer));
    return rows.filter((row) => !hidden.has(row.id));
  }

  async getIssueByBranch(
    repo: string,
    branch: string
  ): Promise<Issue | undefined> {
    await this.ready;
    return this.db
      .select()
      .from(workspaceIssues)
      .where(
        and(eq(workspaceIssues.repo, repo), eq(workspaceIssues.branch, branch))
      )
      .get();
  }

  async getIssueByPrUrl(prUrl: string): Promise<Issue | undefined> {
    await this.ready;
    return this.db
      .select()
      .from(workspaceIssues)
      .where(eq(workspaceIssues.prUrl, prUrl))
      .get();
  }

  async getIssueByExternalRef(externalRef: string): Promise<Issue | undefined> {
    await this.ready;
    return this.db
      .select()
      .from(workspaceIssues)
      .where(
        and(
          eq(workspaceIssues.organizationId, this.organizationId),
          eq(workspaceIssues.externalRef, externalRef)
        )
      )
      .get();
  }

  async indexComment(comment: CommentForSearch) {
    await this.ready;
    await this.syncSearchIndex((index) => indexCommentDocument(index, comment));
  }

  async listIssues(args: ListIssuesArgs = {}): Promise<Issue[]> {
    await this.ready;
    const conditions = [];

    const visibleTeamIds =
      args.teamIds && args.teamIds.length > 0 ? args.teamIds : undefined;

    if (visibleTeamIds) {
      conditions.push(inArray(workspaceIssues.teamId, visibleTeamIds));
    }
    const exclude = this.hiddenIssueConditionFor(
      args.viewer,
      workspaceIssues.id
    );
    if (exclude) conditions.push(exclude);
    if (args.teamId) {
      conditions.push(eq(workspaceIssues.teamId, args.teamId));
    }
    if (args.status) {
      conditions.push(eq(workspaceIssues.status, args.status));
    }
    if (args.priority) {
      conditions.push(eq(workspaceIssues.priority, args.priority));
    }
    if (args.parentId !== undefined) {
      if (args.parentId === null) {
        conditions.push(isNull(workspaceIssues.parentId));
      } else {
        conditions.push(eq(workspaceIssues.parentId, args.parentId));
      }
    }
    if (args.hasParent !== undefined) {
      conditions.push(
        args.hasParent
          ? isNotNull(workspaceIssues.parentId)
          : isNull(workspaceIssues.parentId)
      );
    }
    if (args.isParent !== undefined) {
      const childAlias = alias(workspaceIssues, "child");
      const childSubquery = this.db
        .select({ id: childAlias.id })
        .from(childAlias)
        .where(eq(childAlias.parentId, workspaceIssues.id))
        .limit(1);
      conditions.push(
        args.isParent ? exists(childSubquery) : not(exists(childSubquery))
      );
    }
    if (args.isDraft !== undefined) {
      conditions.push(eq(workspaceIssues.isDraft, args.isDraft));
    }
    if (args.hideSnoozed) {
      const nowIso = new Date().toISOString();
      conditions.push(
        or(
          isNull(workspaceIssues.snoozedUntil),
          lt(workspaceIssues.snoozedUntil, nowIso)
        )
      );
    }
    if (args.assigneeId) {
      conditions.push(eq(workspaceIssues.assigneeId, args.assigneeId));
    }
    if (args.delegateId) {
      conditions.push(eq(workspaceIssues.delegateId, args.delegateId));
    }
    if (args.projectId) {
      conditions.push(eq(workspaceIssues.projectId, args.projectId));
    }
    if (args.externalRef) {
      conditions.push(eq(workspaceIssues.externalRef, args.externalRef));
    }
    if (args.cycleId) {
      conditions.push(eq(workspaceIssues.cycleId, args.cycleId));
    }
    if (args.labelId) {
      conditions.push(
        like(
          sql`',' || COALESCE(${workspaceIssues.labelIds}, '') || ','`,
          `%,${args.labelId},%`
        )
      );
    }
    if (args.filter) {
      conditions.push(filterToSql(args.filter));
    }
    if (args.search) {
      const index = await this.ensureSearchIndex();
      const issueIds = await searchIssues(
        index,
        args.search,
        visibleTeamIds ?? [],
        args.limit
      );
      if (issueIds.length === 0) {
        return [];
      }
      conditions.push(inArray(workspaceIssues.id, issueIds));
    }
    if (args.cursor) {
      conditions.push(
        or(
          lt(workspaceIssues.createdAt, args.cursor.createdAt),
          and(
            eq(workspaceIssues.createdAt, args.cursor.createdAt),
            lt(workspaceIssues.id, args.cursor.id)
          )
        )
      );
    }

    const limit = args.limit ?? 1_000_000;
    const query = this.db
      .select()
      .from(workspaceIssues)
      .orderBy(desc(workspaceIssues.createdAt), desc(workspaceIssues.id))
      .limit(limit);

    const rows = conditions.length
      ? query.where(and(...conditions)).all()
      : query.all();

    return rows;
  }

  async updateIssue(
    id: string,
    patch: IssuePatch,
    actorId?: string,
    // notify:false suppresses the directed issue_assigned emit — bulk
    // importers run as member actors so the member check alone can't tell
    // a migration apart from a human assigning one issue. The generic
    // broadcast still runs. email:false skips only the directed
    // issue_assigned email — a multi-issue batch shouldn't ping the new
    // assignee once per id, while opted-in subscribers still get their
    // per-issue broadcast mail. batchSize marks the directed row as one
    // of N so the single batch email can say how many issues moved.
    options?: { notify?: boolean; email?: boolean; batchSize?: number }
  ): Promise<Issue | undefined> {
    await this.ready;
    const timer = createPhaseTimer();
    const old = await this.getIssue(id);
    if (!old) return undefined;

    const newStatus = patch.status ?? old.status;
    const newResolution =
      patch.resolution !== undefined
        ? patch.resolution
        : patch.status !== undefined && newStatus !== old.status
          ? null
          : old.resolution;
    // The reason follows the resolution: an explicit patch wins, a carried
    // resolution keeps its reason, and a resolution reset (or swap) drops the
    // stale one unless the patch supplies a replacement.
    const resolvedReason =
      patch.resolutionReason !== undefined
        ? patch.resolutionReason
        : newResolution !== null && newResolution === old.resolution
          ? old.resolutionReason
          : null;
    const resolvedResolution = validateIssueResolution(
      newStatus,
      newResolution,
      resolvedReason
    );

    const newRepo = patch.repo !== undefined ? patch.repo : old.repo;
    const newBranch = patch.branch !== undefined ? patch.branch : old.branch;
    if (
      typeof newRepo === "string" &&
      typeof newBranch === "string" &&
      (newRepo !== old.repo || newBranch !== old.branch)
    ) {
      const existing = await this.getIssueByBranch(newRepo, newBranch);
      if (existing && existing.id !== old.id) {
        throw VortexError.fromCode(
          "CONFLICT",
          `Issue ${existing.identifier} already uses repo ${newRepo} and branch ${newBranch}`
        );
      }
    }

    // prUrl feeds getIssueByPrUrl exact-match routing for webhook comments,
    // so a second issue claiming the same URL would be ambiguous.
    const newPrUrl = patch.prUrl !== undefined ? patch.prUrl : old.prUrl;
    if (typeof newPrUrl === "string" && newPrUrl !== old.prUrl) {
      const claimedBy = await this.getIssueByPrUrl(newPrUrl);
      if (claimedBy && claimedBy.id !== old.id) {
        throw VortexError.fromCode(
          "CONFLICT",
          `Issue ${claimedBy.identifier} already links PR ${newPrUrl}`
        );
      }
    }

    if (
      patch.stageGateOverride !== undefined &&
      !patch.stageGateOverride.reason
    ) {
      throw VortexError.fromCode(
        "BAD_REQUEST",
        "stageGateOverride requires a non-empty reason"
      );
    }

    // PILE-412 — stage gate: leaving a stage is refused while the issue's
    // required sub-steps are still open. An admin's override flag (enforced
    // at the API boundary) bypasses the block; the reason and the blocking
    // list land in the audit log and issue history after the write. The
    // implicit prState→status mapping is exempt — it syncs a recorded fact,
    // not a stage decision.
    let gateOverride: { reason: string; blocking: Issue[] } | undefined;
    if (patch.status !== undefined && patch.status !== old.status) {
      const blocking = await this.getBlockingSubSteps(old.id);
      if (blocking.length > 0) {
        if (!patch.stageGateOverride) {
          throw stageGateConflict([{ parent: old, steps: blocking }]);
        }
        gateOverride = { reason: patch.stageGateOverride.reason, blocking };
      }
    }

    const set: Partial<Issue> = {
      updatedAt: new Date().toISOString(),
    };

    const allowed: Array<{ key: IssueKey; field: string }> = [
      { key: "teamId", field: "team_id" },
      { key: "externalRef", field: "external_ref" },
      { key: "title", field: "title" },
      { key: "description", field: "description" },
      { key: "status", field: "status" },
      { key: "priority", field: "priority" },
      { key: "resolution", field: "resolution" },
      { key: "resolutionReason", field: "resolution_reason" },
      { key: "parentId", field: "parent_id" },
      { key: "subIssueSortOrder", field: "sub_issue_sort_order" },
      { key: "estimate", field: "estimate" },
      { key: "isDraft", field: "is_draft" },
      { key: "sensitive", field: "sensitive" },
      { key: "snoozedUntil", field: "snoozed_until" },
      { key: "assigneeId", field: "assignee_id" },
      { key: "delegateId", field: "delegate_id" },
      { key: "stepKey", field: "step_key" },
      { key: "required", field: "required" },
      { key: "ownerAgent", field: "owner_agent" },
      { key: "projectId", field: "project_id" },
      { key: "cycleId", field: "cycle_id" },
      { key: "labelIds", field: "label_ids" },
      { key: "repo", field: "repo" },
      { key: "branch", field: "branch" },
      { key: "prUrl", field: "pr_url" },
      { key: "prState", field: "pr_state" },
    ];

    let newParentId: string | null | undefined = undefined;
    if (patch.parentId !== undefined) {
      if (patch.parentId === null) {
        newParentId = null;
      } else {
        const parent = await this.getIssue(patch.parentId);
        if (!parent) {
          throw VortexError.fromCode("BAD_REQUEST", "Parent issue not found");
        }
        if (parent.parentId) {
          throw new VortexError({
            code: "BAD_REQUEST",
            status: 400,
            message: "Sub-issues can only be nested one level",
          });
        }
        const hasChildren = await this.db
          .select({ id: workspaceIssues.id })
          .from(workspaceIssues)
          .where(eq(workspaceIssues.parentId, old.id))
          .limit(1)
          .get();
        if (hasChildren) {
          throw new VortexError({
            code: "BAD_REQUEST",
            status: 400,
            message: "An issue with sub-issues cannot become a sub-issue",
          });
        }
        if (
          await wouldCreateCycle(
            (parentIssueId) => this.getIssue(parentIssueId),
            old.id,
            parent.id,
            new Set<string>()
          )
        ) {
          throw VortexError.fromCode(
            "BAD_REQUEST",
            "Parent would create a cycle"
          );
        }
        // Store the canonical UUID — callers may pass the human identifier.
        newParentId = parent.id;
      }
    }

    if (patch.teamId !== undefined && patch.teamId !== old.teamId) {
      const d1 = createD1(this.env.D1);
      const team = await getTeamById(d1, patch.teamId, this.organizationId);
      if (!team) {
        throw VortexError.fromCode("NOT_FOUND", "Team not found");
      }
      const last = await this.db
        .select({ number: sql<number | null>`MAX(number)` })
        .from(workspaceIssues)
        .where(eq(workspaceIssues.teamId, team.id))
        .get();
      const number = (last?.number ?? 0) + 1;
      set.teamId = team.id;
      set.number = number;
      set.identifier = `${team.key}-${number}`;
    }
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.externalRef !== undefined) set.externalRef = patch.externalRef;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.priority !== undefined) set.priority = patch.priority;
    if (patch.resolution !== undefined || patch.status !== undefined) {
      set.resolution = resolvedResolution;
    }
    if (
      patch.resolutionReason !== undefined ||
      patch.resolution !== undefined ||
      patch.status !== undefined
    ) {
      set.resolutionReason = resolvedReason;
    }
    if (newParentId !== undefined) set.parentId = newParentId;
    if (patch.subIssueSortOrder !== undefined)
      set.subIssueSortOrder = patch.subIssueSortOrder;
    if (patch.estimate !== undefined) set.estimate = patch.estimate;
    if (patch.isDraft !== undefined) set.isDraft = patch.isDraft;
    if (patch.sensitive !== undefined) set.sensitive = patch.sensitive;
    if (patch.snoozedUntil !== undefined) set.snoozedUntil = patch.snoozedUntil;
    if (
      patch.snoozedUntil === undefined &&
      patch.status !== undefined &&
      patch.status !== "triage"
    ) {
      set.snoozedUntil = null;
    }
    if (patch.assigneeId !== undefined) set.assigneeId = patch.assigneeId;
    if (patch.delegateId !== undefined) set.delegateId = patch.delegateId;
    if (patch.stepKey !== undefined) set.stepKey = patch.stepKey;
    if (patch.required !== undefined) set.required = patch.required;
    if (patch.ownerAgent !== undefined) set.ownerAgent = patch.ownerAgent;
    if (
      patch.assigneeId === undefined &&
      !old.assigneeId &&
      patch.status === "triage"
    ) {
      const d1 = createD1(this.env.D1);
      const team = await getTeamById(d1, old.teamId, this.organizationId);
      if (team?.triageAssigneeId) {
        set.assigneeId = team.triageAssigneeId;
      }
    }
    if (patch.projectId !== undefined) set.projectId = patch.projectId;
    if (patch.cycleId !== undefined) set.cycleId = patch.cycleId;
    if (patch.labelIds !== undefined) set.labelIds = patch.labelIds;
    if (patch.repo !== undefined) set.repo = patch.repo;
    if (patch.branch !== undefined) set.branch = patch.branch;
    if (patch.prUrl !== undefined) set.prUrl = patch.prUrl;
    if (patch.prState !== undefined) set.prState = patch.prState;

    // Fields below are written without an explicit patch key — track them so
    // history still records the change.
    const implicitKeys = new Set<IssueKey>();

    // Re-pointing prUrl means the stored prCheckState belongs to the old
    // PR's head SHA — clear it. prState clears too unless the caller
    // supplied a new one in the same patch.
    if (patch.prUrl !== undefined && patch.prUrl !== old.prUrl) {
      if (patch.prState === undefined) {
        set.prState = null;
        implicitKeys.add("prState");
      }
      set.prCheckState = null;
    }

    // A manual prState PATCH applies the same statusMap the webhook and
    // reconcile writers use, so status and prState can't drift apart. An
    // explicit status in the same PATCH wins.
    if (patch.status === undefined && typeof set.prState === "string") {
      const mapped = PR_STATE_TO_STATUS[set.prState];
      if (
        mapped !== undefined &&
        !isTerminalStatus(old.status) &&
        (old.status !== "triage" || isTerminalStatus(mapped))
      ) {
        set.status = mapped;
        implicitKeys.add("status");
      }
    }

    if (Object.keys(set).length === 1 && "updatedAt" in set) {
      return old;
    }
    timer.mark("validate");

    const issue = await this.db
      .update(workspaceIssues)
      .set(set)
      .where(eq(workspaceIssues.id, old.id))
      .returning()
      .get();
    if (!issue) return undefined;

    const historyEntries = allowed
      .filter(({ key }) => key in patch || implicitKeys.has(key))
      .map(({ key, field }) => {
        const before = old[key];
        const after = issue[key];
        const fromValue = before === null ? null : String(before);
        const toValue = after === null ? null : String(after);
        return fromValue === toValue
          ? undefined
          : { field, fromValue, toValue };
      })
      .filter(
        (
          entry
        ): entry is {
          field: string;
          fromValue: string | null;
          toValue: string | null;
        } => entry !== undefined
      );

    // prCheckState isn't a patch field — the only write path is the implicit
    // stale-pair clear above — so record its history row by hand.
    if (old.prCheckState !== issue.prCheckState) {
      historyEntries.push({
        field: "pr_check_state",
        fromValue: old.prCheckState,
        toValue: issue.prCheckState,
      });
    }

    if (historyEntries.length > 0) {
      await this.recordIssueHistory(issue.id, historyEntries, actorId);
    }
    // PILE-412 — an admin's stage-gate override is part of the issue's
    // activity: who bypassed which blockers and why.
    if (gateOverride) {
      await this.recordStageGateOverride(
        issue,
        gateOverride.blocking,
        gateOverride.reason,
        actorId,
        { field: "status", from: old.status, to: issue.status }
      );
    }
    timer.mark("write");

    // Status automation needs the team row; start the D1 read now so it
    // overlaps the notify fan-out instead of queueing behind it.
    const statusChanged = issue.status !== old.status;
    const automationTeam = statusChanged
      ? getTeamById(createD1(this.env.D1), issue.teamId, this.organizationId)
      : undefined;
    void automationTeam?.catch(() => {});

    await this.syncSearchIndex((index) => indexIssueDocument(index, issue));
    timer.mark("search");

    await this.emit({
      type: "issue.updated",
      organizationId: this.organizationId,
      issue,
    });
    if (issue.prUrl !== old.prUrl || issue.prState !== old.prState) {
      await this.emit({
        type: "pr.updated",
        organizationId: this.organizationId,
        issue,
      });
    }
    if (issue.isDraft || old.isDraft) {
      await this.emit({
        type: "draft.updated",
        organizationId: this.organizationId,
        issue,
      });
    }
    // A human assignee change is its own notification (issue_assigned),
    // and the assignee is excluded from the issue_updated fan-out so they
    // don't get two rows for one edit — but only when the directed emit
    // actually fires: machine actors (webhook syncs) and notify:false
    // writes leave the assignee in the broadcast instead of silent.
    // lane:* assignees are agents.
    // The assignee is resolved once and reused by the recipients fan-out;
    // the actor's membership is only needed for a human assignee change,
    // and is fetched alongside it rather than after.
    timer.mark("emit");
    const assigneeChanged = issue.assigneeId !== old.assigneeId;
    const humanAssigneeChanged =
      assigneeChanged &&
      Boolean(issue.assigneeId) &&
      !issue.assigneeId?.startsWith("lane:");
    const [assigneeUserId, actorIsMember] = await Promise.all([
      this.resolveAssigneeUserId(issue.assigneeId),
      humanAssigneeChanged && options?.notify !== false
        ? this.isMemberActor(actorId)
        : false,
    ]);
    const newAssignee = humanAssigneeChanged ? assigneeUserId : null;
    const selfAssigned = newAssignee !== null && newAssignee === actorId;
    const deliveredAssign =
      options?.notify !== false &&
      newAssignee !== null &&
      !selfAssigned &&
      actorIsMember;
    // options.email gates only the directed issue_assigned ping below —
    // suppressing the broadcast too would silence subscribers who
    // explicitly opted into email for every issue in a bulk edit.
    await this.notifyIssueEvent(
      issue,
      "issue_updated",
      actorId,
      deliveredAssign ? (newAssignee ?? undefined) : undefined,
      assigneeUserId
    );
    if (deliveredAssign && newAssignee) {
      await this.deliverNotification(
        {
          recipientId: newAssignee,
          recipientType: "user",
          issueId: issue.id,
          type: "issue_assigned",
          metadata:
            options?.batchSize !== undefined
              ? { batchSize: options.batchSize }
              : undefined,
        },
        { email: options?.email, issue }
      );
    }
    timer.mark("notify");

    if (statusChanged && automationTeam) {
      await this.applyStatusAutomation(
        issue,
        old,
        await automationTeam,
        actorId
      );
      timer.mark("automation");
    }

    // PILE-413 — a materialized sub-step becoming actionable (created todo,
    // or moved to an actionable status / assigned an owner) emits the
    // dispatch event; the dedupe key keeps re-emits free.
    if (
      issue.parentId &&
      issue.ownerAgent &&
      (issue.status === "todo" || issue.status === "in_progress")
    ) {
      const becameActionable =
        old.status !== issue.status || old.ownerAgent !== issue.ownerAgent;
      if (becameActionable) {
        await this.emitDomainEvent(
          "substep.actionable",
          {
            issueId: issue.id,
            parentId: issue.parentId,
            stepKey: issue.stepKey,
            ownerAgent: issue.ownerAgent,
            required: issue.required,
          },
          `actionable:${issue.id}`
        );
      }
    }
    // When the last open required sub-step closes, the parent's stage is
    // complete — the event fires exactly once per parent (dedupe key) and
    // the drainer applies the stage's advance policy.
    if (
      issue.parentId &&
      issue.required &&
      !subStepSatisfied(old) &&
      subStepSatisfied(issue)
    ) {
      const openRequired = await this.getBlockingSubSteps(issue.parentId);
      if (openRequired.length > 0) {
        // Serial chain — promote the next backlog sub-step to todo so its
        // actionable event fires and the drainer dispatches it. The
        // pipeline advances itself; the director is for exceptions.
        const next = openRequired
          .filter((child) => child.status === "backlog")
          .sort((a, b) =>
            (a.createdAt ?? "").localeCompare(b.createdAt ?? "")
          )[0];
        if (next) {
          await this.updateIssue(
            next.id,
            { status: "todo" },
            actorId ?? "pipeline"
          );
        }
      } else {
        await this.emitDomainEvent(
          "substeps.all_required_done",
          {
            parentId: issue.parentId,
            completedBy: issue.id,
            stepKey: issue.stepKey,
          },
          `alldone:${issue.parentId}`
        );
      }
    }

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(patch) as (keyof Issue)[]) {
      if (issue[key] !== old[key]) {
        changes[key] = { from: old[key], to: issue[key] };
      }
    }
    this.audit("issue.updated", "issue", issue.id, actorId, changes);
    timer.mark("audit");
    logSlowPhases("issue.update.slow", timer, SLOW_ISSUE_UPDATE_MS, {
      organizationId: this.organizationId,
      issueId: issue.id,
      identifier: issue.identifier,
    });
    return issue;
  }

  private async applyStatusAutomation(
    issue: Issue,
    old: Issue,
    team: Awaited<ReturnType<typeof getTeamById>>,
    actorId?: string
  ): Promise<void> {
    if (!team) return;

    if (team.subIssueAutoClose && issue.status === "done") {
      const children = await this.getIssueChildren(issue.id);
      await this.closeChildrenSequentially(children, 0, actorId);
    }

    if (
      team.parentAutoClose &&
      isTerminalStatus(issue.status) &&
      issue.parentId
    ) {
      const siblings = await this.getIssueChildren(issue.parentId);
      if (siblings.every((sibling) => isTerminalStatus(sibling.status))) {
        const parent = await this.getIssue(issue.parentId);
        if (parent && !isTerminalStatus(parent.status)) {
          await this.updateIssue(
            parent.id,
            { status: "done", resolution: "resolved" },
            actorId
          );
        }
      }
    }

    // PILE-411 — entering a status that has a stage template materializes
    // its sub-steps as sub-issues. Drafts and sub-issues don't fire (a
    // sub-step can't hold a deeper level; a draft isn't a live record).
    if (!issue.parentId && !issue.isDraft) {
      await this.applyStageTemplates(
        "issue",
        issue.status,
        issue,
        [issue],
        actorId
      );
    }
  }

  // PILE-411 — stage templates: resolve the (entityType, status) step
  // definitions and materialize one sub-issue per applicable def on each
  // parent issue. For issues the record is its own parent; for
  // deals/customers the parents are the linked deal-issues (a deal is a
  // parent issue linked to the customer). Idempotent per (parent, stepKey):
  // a step that already exists under the parent is never re-created.
  private async applyStageTemplates(
    entityType: data.StageEntityType,
    statusValue: string | null,
    record: { id: string },
    parents: Issue[],
    actorId?: string
  ): Promise<void> {
    if (!statusValue) return;
    const defs = data.listStageTemplatesForStatus(
      this.db,
      this.organizationId,
      entityType,
      statusValue
    );
    if (defs.length === 0) return;
    const context = data.buildStepContext(
      this.db,
      this.organizationId,
      entityType,
      record.id,
      record
    );
    for (const parent of parents) {
      // Sub-steps hang on top-level issues only — one level of nesting.
      if (parent.parentId || parent.isDraft) continue;
      const applicable = defs.filter(
        (def) => def.teamId === null || def.teamId === parent.teamId
      );
      await this.materializeSubSteps(parent, applicable, context, actorId);
    }
  }

  /** Parent issues a non-issue record's stage transition materializes
   *  sub-steps under — the issues linked to the deal/customer. */
  private async linkedParentIssues(
    entityType: "deal" | "customer",
    recordId: string
  ): Promise<Issue[]> {
    const linked = data.listLinkedIssueIds(
      this.db,
      this.organizationId,
      entityType,
      recordId
    );
    const found = await Promise.all(
      linked.map((issueId) => this.getIssue(issueId))
    );
    return found.filter((issue): issue is Issue => issue !== undefined);
  }

  private async materializeSubSteps(
    parent: Issue,
    defs: data.StageTemplate[],
    context: Record<string, unknown>,
    actorId?: string
  ): Promise<void> {
    // The (parent, step_key) pair is the idempotency key — re-entering a
    // stage never duplicates a sub-step that already exists, whatever its
    // status (even canceled counts as "exists").
    const existing = new Set(
      (await this.getIssueChildren(parent.id))
        .map((child) => child.stepKey)
        .filter((key): key is string => key !== null)
    );
    for (const def of defs) {
      if (existing.has(def.stepKey)) continue;
      if (!data.evaluateStepCondition(def.condition, context)) continue;
      const { issue } = await this.createIssueRecord(
        {
          title: def.title,
          description: null,
          status: "todo",
          parentId: parent.id,
          stepKey: def.stepKey,
          required: def.required,
          ownerAgent: def.ownerAgent,
          subIssueSortOrder: def.position,
        },
        actorId
      );
      if (issue) {
        existing.add(def.stepKey);
        // PILE-413 — a materialized sub-step becomes dispatchable work.
        await this.emitDomainEvent(
          "substep.actionable",
          {
            issueId: issue.id,
            parentId: parent.id,
            stepKey: def.stepKey,
            ownerAgent: def.ownerAgent,
            required: def.required,
          },
          `actionable:${issue.id}`
        );
      }
    }
  }

  // ---- pipeline runtime outbox (PILE-401/405/413) — the DO records domain
  // events; the worker layer drains them into dispatches + stage policy ----

  private async emitDomainEvent(
    type: data.DomainEventType,
    payload: Record<string, unknown>,
    dedupeKey?: string
  ) {
    return data.emitDomainEvent(this.db, this.organizationId, {
      type,
      payload,
      dedupeKey,
    });
  }

  /** PILE-414 — batch chip data: parent issue id → required sub-step
   *  counts + the owner_agent of the next open required step. */
  subStepProgressFor(parentIds: string[]) {
    return Object.fromEntries(
      data.subStepProgressByParent(this.db, this.organizationId, parentIds)
    );
  }

  listPendingDomainEvents() {
    return data.listPendingDomainEvents(this.db, this.organizationId);
  }

  markDomainEvent(id: string, status: "delivered" | "failed", error?: string) {
    return data.markDomainEvent(this.db, id, status, error);
  }

  upsertStageConfig(input: data.StageConfigInput) {
    return data.upsertStageConfig(this.db, this.organizationId, input);
  }

  getStageConfig(entityType: "issue" | "deal" | "customer", status: string) {
    return data.getStageConfig(
      this.db,
      this.organizationId,
      entityType,
      status
    );
  }

  listStageConfigs() {
    return data.listStageConfigs(this.db, this.organizationId);
  }

  getStageConfigById(id: string) {
    return data.getStageConfigById(this.db, this.organizationId, id);
  }

  updateStageConfig(
    id: string,
    patch: Partial<Omit<data.StageConfigInput, "entityType" | "status">>
  ) {
    return data.updateStageConfig(this.db, this.organizationId, id, patch);
  }

  deleteStageConfig(id: string) {
    return data.deleteStageConfig(this.db, this.organizationId, id);
  }

  async upsertAgentType(input: data.AgentTypeInput) {
    // Webhook bearer is a credential — encrypt at rest like provider keys.
    if (input.endpointSecret) {
      input = {
        ...input,
        endpointSecret: await encryptSecret(this.env, input.endpointSecret),
      };
    }
    return data.upsertAgentType(this.db, this.organizationId, input);
  }

  getAgentTypeBySlug(slug: string) {
    return data.getAgentTypeBySlug(this.db, this.organizationId, slug);
  }

  listAgentTypes() {
    return data.listAgentTypes(this.db, this.organizationId);
  }

  getAgentTypeById(id: string) {
    return data.getAgentTypeById(this.db, this.organizationId, id);
  }

  async updateAgentType(id: string, patch: Partial<data.AgentTypeInput>) {
    if (patch.endpointSecret) {
      patch = {
        ...patch,
        endpointSecret: await encryptSecret(this.env, patch.endpointSecret),
      };
    }
    return data.updateAgentType(this.db, this.organizationId, id, patch);
  }

  deleteAgentType(id: string) {
    return data.deleteAgentType(this.db, this.organizationId, id);
  }

  // ---- stage gate (PILE-412) — a record cannot leave its stage while its
  // required sub-steps are open ----

  /** Open required sub-steps under one parent issue. */
  private async getBlockingSubSteps(parentId: string): Promise<Issue[]> {
    return (await this.getIssueChildren(parentId)).filter(
      (child) => child.required && !subStepSatisfied(child)
    );
  }

  /** The subset of `parents` that still have open required sub-steps —
   *  customer/deal transitions gate on every linked parent issue. */
  private async blockingSubStepParents(
    parents: Issue[]
  ): Promise<{ parent: Issue; steps: Issue[] }[]> {
    const blocked: { parent: Issue; steps: Issue[] }[] = [];
    for (const parent of parents) {
      const steps = await this.getBlockingSubSteps(parent.id);
      if (steps.length > 0) blocked.push({ parent, steps });
    }
    return blocked;
  }

  /** An override is part of the parent's activity and the audit log — who
   *  bypassed which blockers, why, and which transition it freed. */
  private async recordStageGateOverride(
    parent: Issue,
    steps: Issue[],
    reason: string,
    actorId: string | undefined,
    transition: { field: string; from: string | null; to: string | null }
  ) {
    const blocking = steps.map((child) => child.identifier ?? child.id);
    await this.recordIssueHistory(
      parent.id,
      [
        {
          field: "stage_gate_override",
          fromValue: blocking.join(", "),
          toValue: reason,
        },
      ],
      actorId
    );
    this.audit("issue.stage_gate_override", "issue", parent.id, actorId, {
      [transition.field]: { from: transition.from, to: transition.to },
      overrideReason: { from: null, to: reason },
      blockingSubSteps: { from: blocking, to: null },
    });
  }

  async batchUpdateIssues(
    ids: string[],
    patch: IssuePatch,
    actorId?: string
  ): Promise<Issue[]> {
    // A non-null prUrl maps to exactly one issue — reject multi-id batches
    // up front so they can't half-apply before hitting the claim check.
    if (ids.length > 1 && typeof patch.prUrl === "string") {
      throw VortexError.fromCode(
        "BAD_REQUEST",
        "prUrl can only be set on a single issue"
      );
    }
    return this.batchUpdateSequentially(ids, 0, patch, actorId, []);
  }

  private async batchUpdateSequentially(
    ids: string[],
    index: number,
    patch: IssuePatch,
    actorId: string | undefined,
    acc: Issue[]
  ): Promise<Issue[]> {
    if (index >= ids.length) return acc;
    // Only the first id may send the directed issue_assigned email — a
    // bulk assign to the same member pings them once, not once per issue,
    // and batchSize lets that one email say how many issues moved.
    // In-app rows and opted-in broadcast mail are unaffected.
    const issue = await this.updateIssue(
      ids[index],
      patch,
      actorId,
      index === 0
        ? { batchSize: ids.length }
        : { email: false, batchSize: ids.length }
    );
    if (!issue) {
      throw VortexError.fromCode("NOT_FOUND", `Issue not found: ${ids[index]}`);
    }
    acc.push(issue);
    return this.batchUpdateSequentially(ids, index + 1, patch, actorId, acc);
  }

  private async closeChildrenSequentially(
    children: Issue[],
    index: number,
    actorId?: string
  ): Promise<void> {
    if (index >= children.length) return;
    const child = children[index];
    if (!isTerminalStatus(child.status)) {
      await this.updateIssue(
        child.id,
        { status: "done", resolution: "resolved" },
        actorId
      );
    }
    await this.closeChildrenSequentially(children, index + 1, actorId);
  }

  // PILE-430 — atomic claim/lease ("this issue is mine"). The DO is
  // single-threaded, so the read-check-write below cannot race: a claim
  // wins only while the issue is unclaimed, its lease has expired, or the
  // caller already holds it. A same-holder claim is the heartbeat — it
  // extends the expiry and bumps the epoch. `claimEpoch` is the fencing
  // token auto-delegation (PILE-427) uses to notice it lost the issue.
  // Lease seconds clamp to [60, 3600], default 300; timestamps are ISO.
  async claimIssue(
    id: string,
    claimantId: string,
    leaseSeconds = 300,
    actorId?: string
  ): Promise<IssueClaim> {
    await this.ready;
    const issue = await this.getIssue(id);
    if (!issue) {
      throw VortexError.fromCode("NOT_FOUND", "Issue not found");
    }
    const seconds = Math.min(3600, Math.max(60, Math.floor(leaseSeconds)));
    const now = new Date();
    const nowIso = now.toISOString();
    // A missing expiry with a holder means a pre-lease write — treat it as
    // expired so the issue is reclaimable rather than locked forever.
    const expired =
      issue.claimedLeaseExpiresAt === null ||
      issue.claimedLeaseExpiresAt <= nowIso;
    if (
      issue.claimedBy !== null &&
      issue.claimedBy !== claimantId &&
      !expired
    ) {
      throw new VortexError({
        code: "CONFLICT",
        status: 409,
        message: "Issue already claimed",
        hint: `Held by ${issue.claimedBy} until ${issue.claimedLeaseExpiresAt}`,
        details: {
          claimedBy: issue.claimedBy,
          leaseExpiresAt: issue.claimedLeaseExpiresAt,
        },
      });
    }
    const leaseExpiresAt = new Date(
      now.getTime() + seconds * 1000
    ).toISOString();
    const epoch = issue.claimEpoch + 1;
    const updated = await this.db
      .update(workspaceIssues)
      .set({
        claimedBy: claimantId,
        claimedLeaseExpiresAt: leaseExpiresAt,
        claimEpoch: epoch,
      })
      .where(eq(workspaceIssues.id, issue.id))
      .returning()
      .get();
    if (!updated) {
      throw VortexError.fromCode("NOT_FOUND", "Issue not found");
    }
    // History/audit only on a holder change — a heartbeat renew happens
    // every lease and must not flood either stream.
    const holderChanged = issue.claimedBy !== claimantId;
    if (holderChanged) {
      await this.recordIssueHistory(
        issue.id,
        [
          {
            field: "claimed_by",
            fromValue: issue.claimedBy,
            toValue: claimantId,
          },
        ],
        actorId
      );
      this.audit("issue.claimed", "issue", issue.id, actorId, {
        claimedBy: { from: issue.claimedBy, to: claimantId },
      });
    }
    await this.emit({
      type: "issue.updated",
      organizationId: this.organizationId,
      issue: updated,
    });
    return {
      issueId: issue.id,
      claimedBy: claimantId,
      leaseExpiresAt,
      epoch,
    };
  }

  // Release is the holder's own door: a live lease can only be released by
  // its claimant (403 otherwise). An already-expired lease clears for
  // anyone — it is dead weight, and POST reclaim treats it the same way.
  async releaseClaim(
    id: string,
    claimantId: string,
    actorId?: string
  ): Promise<void> {
    await this.ready;
    const issue = await this.getIssue(id);
    if (!issue) {
      throw VortexError.fromCode("NOT_FOUND", "Issue not found");
    }
    if (issue.claimedBy === null) return;
    const expired =
      issue.claimedLeaseExpiresAt === null ||
      issue.claimedLeaseExpiresAt <= new Date().toISOString();
    if (issue.claimedBy !== claimantId && !expired) {
      throw new VortexError({
        code: "FORBIDDEN",
        status: 403,
        message: "Only the claim holder may release this issue",
        hint: `Held by ${issue.claimedBy}`,
        details: {
          claimedBy: issue.claimedBy,
          leaseExpiresAt: issue.claimedLeaseExpiresAt,
        },
      });
    }
    const updated = await this.db
      .update(workspaceIssues)
      .set({
        claimedBy: null,
        claimedLeaseExpiresAt: null,
        claimEpoch: issue.claimEpoch + 1,
      })
      .where(eq(workspaceIssues.id, issue.id))
      .returning()
      .get();
    if (!updated) {
      throw VortexError.fromCode("NOT_FOUND", "Issue not found");
    }
    await this.recordIssueHistory(
      issue.id,
      [
        {
          field: "claimed_by",
          fromValue: issue.claimedBy,
          toValue: null,
        },
      ],
      actorId
    );
    this.audit("issue.claim_released", "issue", issue.id, actorId, {
      claimedBy: { from: issue.claimedBy, to: null },
    });
    await this.emit({
      type: "issue.updated",
      organizationId: this.organizationId,
      issue: updated,
    });
  }

  async deleteIssue(id: string, actorId?: string): Promise<boolean> {
    await this.ready;
    const old = await this.getIssue(id);
    if (!old) return false;
    // `id` may be the human identifier — cascade against the canonical UUID.
    const issueId = old.id;
    const deleted = await this.db
      .delete(workspaceIssues)
      .where(eq(workspaceIssues.id, issueId))
      .returning()
      .get();
    if (!deleted) return false;

    const commentIds = (
      await this.db
        .select({ id: workspaceComments.id })
        .from(workspaceComments)
        .where(
          and(
            eq(workspaceComments.entityType, "issue"),
            eq(workspaceComments.entityId, issueId)
          )
        )
        .all()
    ).map((row) => row.id);
    await this.db
      .delete(workspaceIssueHistory)
      .where(eq(workspaceIssueHistory.issueId, issueId));
    await this.db
      .delete(workspaceComments)
      .where(
        and(
          eq(workspaceComments.entityType, "issue"),
          eq(workspaceComments.entityId, issueId)
        )
      );
    await this.db
      .delete(workspaceSubscriptions)
      .where(
        and(
          eq(workspaceSubscriptions.entityType, "issue"),
          eq(workspaceSubscriptions.entityId, issueId)
        )
      );
    await this.db
      .delete(workspaceEntityLinks)
      .where(
        or(
          and(
            eq(workspaceEntityLinks.fromType, "issue"),
            eq(workspaceEntityLinks.fromId, issueId)
          ),
          and(
            eq(workspaceEntityLinks.toType, "issue"),
            eq(workspaceEntityLinks.toId, issueId)
          )
        )
      );
    await this.db
      .delete(workspaceEntityLinks)
      .where(
        or(
          and(
            eq(workspaceEntityLinks.fromType, "issue"),
            eq(workspaceEntityLinks.fromId, issueId)
          ),
          and(
            eq(workspaceEntityLinks.toType, "issue"),
            eq(workspaceEntityLinks.toId, issueId)
          )
        )
      );
    await this.db
      .delete(workspaceIssueApprovals)
      .where(eq(workspaceIssueApprovals.issueId, issueId));
    // issue_permissions rows are deliberately kept: a deleted restricted
    // issue's audit entries, notifications, and `issue.deleted` frames must
    // stay filtered (no grant rows = open would un-hide them post-delete).
    // Ids are never reused, so the rows are inert tombstones.
    const reactionTargets = [issueId, ...commentIds];
    if (reactionTargets.length > 0) {
      await this.db
        .delete(workspaceReactions)
        .where(inArray(workspaceReactions.targetId, reactionTargets));
    }
    await this.db
      .delete(workspaceAttachments)
      .where(eq(workspaceAttachments.issueId, issueId));
    await this.db
      .delete(workspaceNotifications)
      .where(eq(workspaceNotifications.issueId, issueId));
    const sessionIds = (
      await this.db
        .select({ id: workspaceAgentSessions.id })
        .from(workspaceAgentSessions)
        .where(eq(workspaceAgentSessions.issueId, issueId))
        .all()
    ).map((row) => row.id);
    if (sessionIds.length > 0) {
      await this.db
        .delete(workspaceAgentActivities)
        .where(inArray(workspaceAgentActivities.sessionId, sessionIds));
      await this.db
        .delete(workspaceAgentSessions)
        .where(inArray(workspaceAgentSessions.id, sessionIds));
    }

    await this.syncSearchIndex((index) => removeIssueDocuments(index, issueId));

    if (old.isDraft) {
      await this.emit({
        type: "draft.deleted",
        organizationId: this.organizationId,
        issueId,
      });
    }
    await this.emit({
      type: "issue.deleted",
      organizationId: this.organizationId,
      issueId,
    });
    // The subject is already gone — keep its title in the email but drop
    // the issue link, which would 404.
    await this.notifyIssueEvent(
      old,
      "issue_deleted",
      actorId,
      undefined,
      undefined,
      { linkIssue: false }
    );
    this.audit("issue.deleted", "issue", issueId, actorId, {
      title: { from: old.title, to: null },
    });
    return true;
  }

  async emitCommentCreated(
    comment: Comment,
    issue: Issue,
    actorId?: string
  ): Promise<void> {
    await this.ready;
    await this.emit({
      type: "comment.created",
      organizationId: this.organizationId,
      issue,
      comment,
    });
    await this.notifyIssueEvent(issue, "comment_created", actorId);
  }

  async emitCommentUpdated(comment: Comment, issue: Issue): Promise<void> {
    await this.ready;
    await this.emit({
      type: "comment.updated",
      organizationId: this.organizationId,
      issue,
      comment,
    });
  }

  async emitCommentDeleted(commentId: string, issueId: string): Promise<void> {
    await this.ready;
    await this.emit({
      type: "comment.deleted",
      organizationId: this.organizationId,
      issueId,
      commentId,
    });
  }

  async getIssueByIdentifier(identifier: string): Promise<Issue | undefined> {
    await this.ready;
    return this.db
      .select()
      .from(workspaceIssues)
      .where(eq(workspaceIssues.identifier, identifier))
      .get();
  }

  async updatePrByIdentifier(
    identifier: string | null,
    prUrl: string,
    prState: string,
    repo: string,
    branch: string,
    actorId?: string
  ): Promise<Issue | undefined> {
    await this.ready;
    if (!identifier) return undefined;
    const old = await this.getIssueByIdentifier(identifier);
    if (!old) return undefined;

    // A PR mention in a title/body must not overwrite the PR state of an
    // issue that already owns a different branch. The branch is the
    // authoritative link; a plain identifier mention is just a reference.
    if (old.repo !== null && old.repo !== repo) return undefined;
    if (old.branch !== null && old.branch !== branch) return undefined;

    const status = PR_STATE_TO_STATUS[prState];
    const set: {
      prUrl: string;
      prState: string;
      updatedAt: string;
      status?: Issue["status"];
      repo?: string;
      branch?: string;
    } = {
      prUrl,
      prState,
      updatedAt: new Date().toISOString(),
    };
    if (status !== undefined) {
      set.status = status;
    }
    if (old.repo === null) {
      set.repo = repo;
    }
    if (old.branch === null) {
      const existing = await this.getIssueByBranch(repo, branch);
      if (existing === undefined) {
        set.branch = branch;
      }
    }

    const issue = await this.db
      .update(workspaceIssues)
      .set(set)
      .where(eq(workspaceIssues.identifier, identifier))
      .returning()
      .get();
    if (!issue) return undefined;

    const historyEntries: Array<{
      field: string;
      fromValue: string | null;
      toValue: string | null;
    }> = [];
    if (old.prUrl !== issue.prUrl) {
      historyEntries.push({
        field: "pr_url",
        fromValue: old.prUrl,
        toValue: issue.prUrl,
      });
    }
    if (old.prState !== issue.prState) {
      historyEntries.push({
        field: "pr_state",
        fromValue: old.prState,
        toValue: issue.prState,
      });
    }
    if (old.status !== issue.status) {
      historyEntries.push({
        field: "status",
        fromValue: old.status,
        toValue: issue.status,
      });
    }
    if (historyEntries.length > 0) {
      await this.recordIssueHistory(issue.id, historyEntries, actorId);
    }

    await this.emit({
      type: "pr.updated",
      organizationId: this.organizationId,
      issue,
    });
    return issue;
  }

  async updatePrState(
    repo: string,
    branch: string,
    prUrl: string,
    prState: string,
    actorId?: string
  ): Promise<Issue | undefined> {
    await this.ready;
    const old = await this.getIssueByBranch(repo, branch);
    if (!old) return undefined;

    const status = PR_STATE_TO_STATUS[prState];
    const set: {
      prUrl: string;
      prState: string;
      updatedAt: string;
      status?: Issue["status"];
    } = {
      prUrl,
      prState,
      updatedAt: new Date().toISOString(),
    };
    if (status !== undefined) {
      set.status = status;
    }

    const issue = await this.db
      .update(workspaceIssues)
      .set(set)
      .where(eq(workspaceIssues.id, old.id))
      .returning()
      .get();
    if (!issue) return undefined;

    const historyEntries: Array<{
      field: string;
      fromValue: string | null;
      toValue: string | null;
    }> = [];
    if (old.prUrl !== issue.prUrl) {
      historyEntries.push({
        field: "pr_url",
        fromValue: old.prUrl,
        toValue: issue.prUrl,
      });
    }
    if (old.prState !== issue.prState) {
      historyEntries.push({
        field: "pr_state",
        fromValue: old.prState,
        toValue: issue.prState,
      });
    }
    if (old.status !== issue.status) {
      historyEntries.push({
        field: "status",
        fromValue: old.status,
        toValue: issue.status,
      });
    }
    if (historyEntries.length > 0) {
      await this.recordIssueHistory(issue.id, historyEntries, actorId);
    }

    await this.emit({
      type: "pr.updated",
      organizationId: this.organizationId,
      issue,
    });
    return issue;
  }

  async updatePrCheckState(
    repo: string,
    branch: string,
    prCheckState: string,
    actorId?: string
  ): Promise<Issue | undefined> {
    await this.ready;
    const old = await this.getIssueByBranch(repo, branch);
    if (!old) return undefined;

    const issue = await this.db
      .update(workspaceIssues)
      .set({
        prCheckState,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(workspaceIssues.id, old.id))
      .returning()
      .get();
    if (!issue) return undefined;

    const historyEntries: Array<{
      field: string;
      fromValue: string | null;
      toValue: string | null;
    }> = [];
    if (old.prCheckState !== issue.prCheckState) {
      historyEntries.push({
        field: "pr_check_state",
        fromValue: old.prCheckState,
        toValue: issue.prCheckState,
      });
    }
    if (historyEntries.length > 0) {
      await this.recordIssueHistory(issue.id, historyEntries, actorId);
    }

    await this.emit({
      type: "pr.updated",
      organizationId: this.organizationId,
      issue,
    });
    return issue;
  }

  async reconcileIssuePr(
    issueId: string,
    prUrl: string | null,
    prState: string | null,
    prCheckState: string | null,
    actorId?: string
  ): Promise<Issue | undefined> {
    await this.ready;
    const old = await this.getIssue(issueId);
    if (!old) return undefined;

    // Same uniqueness rule as updateIssue — a prUrl already claimed by
    // another issue would fork getIssueByPrUrl webhook routing.
    if (typeof prUrl === "string" && prUrl !== old.prUrl) {
      const claimedBy = await this.getIssueByPrUrl(prUrl);
      if (claimedBy && claimedBy.id !== old.id) {
        throw VortexError.fromCode(
          "CONFLICT",
          `Issue ${claimedBy.identifier} already links PR ${prUrl}`
        );
      }
    }

    const status = prState ? PR_STATE_TO_STATUS[prState] : undefined;
    const set: {
      prUrl: string | null;
      prState: string | null;
      prCheckState: string | null;
      updatedAt: string;
      status?: Issue["status"];
    } = {
      prUrl,
      prState,
      prCheckState,
      updatedAt: new Date().toISOString(),
    };
    // Triage is a human queue (PILE-270 escalations land there): PR
    // activity only pulls an issue out of it once the PR is merged/closed.
    if (
      status !== undefined &&
      !isTerminalStatus(old.status) &&
      (old.status !== "triage" || isTerminalStatus(status))
    ) {
      set.status = status;
    }

    const issue = await this.db
      .update(workspaceIssues)
      .set(set)
      .where(
        and(
          eq(workspaceIssues.id, issueId),
          eq(workspaceIssues.organizationId, this.organizationId)
        )
      )
      .returning()
      .get();
    if (!issue) return undefined;

    const historyEntries: Array<{
      field: string;
      fromValue: string | null;
      toValue: string | null;
    }> = [];
    if (old.prUrl !== issue.prUrl) {
      historyEntries.push({
        field: "pr_url",
        fromValue: old.prUrl,
        toValue: issue.prUrl,
      });
    }
    if (old.prState !== issue.prState) {
      historyEntries.push({
        field: "pr_state",
        fromValue: old.prState,
        toValue: issue.prState,
      });
    }
    if (old.prCheckState !== issue.prCheckState) {
      historyEntries.push({
        field: "pr_check_state",
        fromValue: old.prCheckState,
        toValue: issue.prCheckState,
      });
    }
    if (old.status !== issue.status) {
      historyEntries.push({
        field: "status",
        fromValue: old.status,
        toValue: issue.status,
      });
    }
    if (historyEntries.length > 0) {
      await this.recordIssueHistory(issue.id, historyEntries, actorId);
    }

    await this.emit({
      type: "pr.updated",
      organizationId: this.organizationId,
      issue,
    });
    return issue;
  }

  async listGitIdentities(): Promise<GitIdentity[]> {
    await this.ready;
    return this.db
      .select()
      .from(workspaceGitIdentities)
      .where(eq(workspaceGitIdentities.organizationId, this.organizationId))
      .all();
  }

  async getGitIdentity(id: string): Promise<GitIdentity | undefined> {
    await this.ready;
    return this.db
      .select()
      .from(workspaceGitIdentities)
      .where(
        and(
          eq(workspaceGitIdentities.id, id),
          eq(workspaceGitIdentities.organizationId, this.organizationId)
        )
      )
      .get();
  }

  async getGitIdentityByRepo(repo: string): Promise<GitIdentity | undefined> {
    await this.ready;
    return this.db
      .select()
      .from(workspaceGitIdentities)
      .where(
        and(
          eq(workspaceGitIdentities.organizationId, this.organizationId),
          eq(workspaceGitIdentities.repo, repo)
        )
      )
      .get();
  }

  async upsertGitIdentity(
    identity: Omit<
      GitIdentity,
      "id" | "organizationId" | "createdAt" | "updatedAt"
    >
  ): Promise<GitIdentity> {
    await this.ready;
    const existing = await this.getGitIdentityByRepo(identity.repo);
    const now = new Date().toISOString();
    const id = existing?.id ?? crypto.randomUUID();
    const row = {
      ...identity,
      id,
      organizationId: this.organizationId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.db
      .insert(workspaceGitIdentities)
      .values(row)
      .onConflictDoUpdate({
        target: [
          workspaceGitIdentities.organizationId,
          workspaceGitIdentities.repo,
        ],
        set: {
          name: row.name,
          email: row.email,
          githubUsername: row.githubUsername,
          signingKeyRef: row.signingKeyRef,
          updatedAt: row.updatedAt,
        },
      });
    const updated = await this.getGitIdentity(id);
    if (!updated) {
      throw new VortexError({
        code: "INTERNAL_ERROR",
        status: 500,
        message: "Failed to persist git identity",
      });
    }
    return updated;
  }

  async deleteGitIdentity(id: string): Promise<void> {
    await this.ready;
    await this.db
      .delete(workspaceGitIdentities)
      .where(
        and(
          eq(workspaceGitIdentities.id, id),
          eq(workspaceGitIdentities.organizationId, this.organizationId)
        )
      );
  }

  // Full-state export for worker-to-worker migration: every KV entry plus
  // every SQL row, with binary values base64-tagged for JSON transport.
  async exportState(): Promise<WorkspaceStateDump> {
    await this.ready;
    const kv: Record<string, StateJson> = {};
    for (const [key, value] of await this.ctx.storage.list()) {
      kv[key] = encodeStateValue(value);
    }
    const tables: Record<string, Record<string, StateJson>[]> = {};
    const tableRows = this.ctx.storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
      )
      .toArray();
    for (const { name } of tableRows) {
      if (typeof name !== "string") continue;
      const rows = this.ctx.storage.sql
        .exec(`SELECT * FROM "${name}"`)
        .toArray();
      tables[name] = rows.map((row) => encodeStateRow(row));
    }
    return { kv, tables };
  }

  async importState(dump: WorkspaceStateDump): Promise<void> {
    await this.ready;
    for (const [table, rows] of Object.entries(dump.tables)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(table)) {
        throw new VortexError({
          code: "BAD_REQUEST",
          status: 400,
          message: `Invalid table name in dump: ${table}`,
        });
      }
      for (const row of rows) {
        const columns = Object.keys(row);
        if (columns.length === 0) continue;
        const columnList = columns.map((c) => `"${c}"`).join(", ");
        const placeholders = columns.map(() => "?").join(", ");
        const values = columns.map(
          (c) => decodeStateValue(row[c]) as SqlStorageValue
        );
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO "${table}" (${columnList}) VALUES (${placeholders})`,
          ...values
        );
      }
    }
    const kvEntries = Object.fromEntries(
      Object.entries(dump.kv).map(([key, value]) => [
        key,
        decodeStateValue(value),
      ])
    );
    if (Object.keys(kvEntries).length > 0) {
      await this.ctx.storage.put(kvEntries);
    }
  }

  /** Chunked export for large stores — exportState's single RPC blob exceeds
   * workerd's response cap once a workspace's SQLite has real data. Callers
   * enumerate tables, then pull rows + kv keys in bounded slices. */
  async exportMeta(): Promise<{ tables: string[]; kvKeys: string[] }> {
    await this.ready;
    const tables = this.ctx.storage.sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
      )
      .toArray()
      .map((r) => String(r.name));
    const kvKeys: string[] = [];
    for (const [key] of await this.ctx.storage.list()) kvKeys.push(key);
    return { tables, kvKeys };
  }

  async exportTableChunk(
    table: string,
    offset: number,
    limit: number
  ): Promise<Record<string, StateJson>[]> {
    await this.ready;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(table)) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: `Invalid table name: ${table}`,
      });
    }
    return this.ctx.storage.sql
      .exec(
        `SELECT * FROM "${table}" LIMIT ${Math.min(limit, 500)} OFFSET ${offset}`
      )
      .toArray()
      .map((row) => encodeStateRow(row));
  }

  async exportKvChunk(keys: string[]): Promise<Record<string, StateJson>> {
    await this.ready;
    const out: Record<string, StateJson> = {};
    for (const key of keys.slice(0, 200)) {
      out[key] = encodeStateValue(await this.ctx.storage.get(key));
    }
    return out;
  }

  async importTableChunk(
    table: string,
    rows: Record<string, StateJson>[]
  ): Promise<void> {
    await this.ready;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(table)) {
      throw new VortexError({
        code: "BAD_REQUEST",
        status: 400,
        message: `Invalid table name: ${table}`,
      });
    }
    for (const row of rows) {
      const columns = Object.keys(row);
      if (columns.length === 0) continue;
      const columnList = columns.map((c) => `"${c}"`).join(", ");
      const placeholders = columns.map(() => "?").join(", ");
      const values = columns.map(
        (c) => decodeStateValue(row[c]) as SqlStorageValue
      );
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO "${table}" (${columnList}) VALUES (${placeholders})`,
        ...values
      );
    }
  }

  async importKvChunk(kv: Record<string, StateJson>): Promise<void> {
    await this.ready;
    const entries = Object.fromEntries(
      Object.entries(kv).map(([key, value]) => [key, decodeStateValue(value)])
    );
    if (Object.keys(entries).length > 0) {
      await this.ctx.storage.put(entries);
    }
  }
}

const STATE_BLOB_TAG = "__pileStateBlob";

type StateJson =
  | string
  | number
  | boolean
  | null
  | StateJson[]
  | { [key: string]: StateJson };

export type WorkspaceStateDump = {
  kv: Record<string, StateJson>;
  tables: Record<string, Record<string, StateJson>[]>;
};

function encodeStateValue(value: unknown): StateJson {
  if (value instanceof Uint8Array) {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return { [STATE_BLOB_TAG]: btoa(binary) };
  }
  if (value instanceof ArrayBuffer) {
    return encodeStateValue(new Uint8Array(value));
  }
  if (Array.isArray(value)) return value.map(encodeStateValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        encodeStateValue(v),
      ])
    );
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    value === undefined
  ) {
    return value ?? null;
  }
  return String(value);
}

function encodeStateRow(
  row: Record<string, unknown>
): Record<string, StateJson> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, encodeStateValue(v)])
  );
}

function decodeStateValue(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    STATE_BLOB_TAG in value
  ) {
    const encoded = (value as Record<string, unknown>)[STATE_BLOB_TAG];
    if (typeof encoded !== "string") return value;
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
  if (Array.isArray(value)) return value.map(decodeStateValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        decodeStateValue(v),
      ])
    );
  }
  return value;
}
