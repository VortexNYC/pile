import { EmailMessage } from "cloudflare:email";
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

import { createD1 } from "../global/db.js";
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
  outboundWebhookDeliveries as globalOutboundDeliveries,
  reactions as globalReactions,
  savedViews as globalSavedViews,
  user as globalUser,
  userWorkspacePreferences as globalUserPrefs,
  viewFavorites as globalViewFavorites,
  webhookSubscriptions as globalWebhookSubs,
} from "../global/schema.js";
import { getDefaultTeam, getTeamById } from "../global/teams.js";
import { getWorkspaceMembership } from "../global/workspaces.js";
import { getWorkspaceById } from "../global/workspaces.js";
import { VortexError } from "../platform/errors.js";
import { notifySlack } from "../slack/bot.js";
import type { AppEnv } from "../types/env.js";
import {
  ISSUE_RESOLUTIONS,
  type Comment,
  type Issue,
  type IssueInput,
  type IssueResolution,
  type IssueStatus,
  type ListIssuesArgs,
  type RealtimeEvent,
} from "../types/workspace.js";
import * as data from "./data.js";
import { filterToSql } from "./filter.js";
import { workspaceMigrations } from "./migrations.js";
import { workspaceSchema } from "./schema-map.js";
import {
  workspaceAgentActivities,
  workspaceAgentSessions,
  workspaceAttachments,
  workspaceComments,
  workspaceDocuments,
  workspaceIssueApprovals,
  workspaceIssueHistory,
  workspaceIssueRelations,
  workspaceIssues,
  workspaceIssueSubscribers,
  workspaceLinearUsers,
  workspaceNotifications,
  workspaceOutboundWebhookDeliveries,
  workspaceReactions,
  workspaceSavedViews,
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
  insertMultiple as insertSearchDocs,
  issueToSearchDocument,
  removeIssueDocuments,
  searchDocuments,
  searchIssues,
  type CommentForSearch,
  type WorkspaceSearchIndex,
} from "./search.js";
import { deliverWebhooks, retryWebhookDeliveries } from "./webhooks.js";

type IssueKey = keyof Issue & keyof IssueInput;

const TERMINAL_STATUSES: ReadonlyArray<IssueStatus> = ["done", "canceled"];

function isTerminalStatus(status: IssueStatus): boolean {
  return status === "done" || status === "canceled";
}

async function resolveParent(
  getIssue: (id: string) => Promise<Issue | undefined>,
  parentId: string | null,
  issueId: string
): Promise<Issue | null> {
  if (parentId === null) return null;
  if (parentId === issueId) {
    throw VortexError.fromCode(
      "BAD_REQUEST",
      "An issue cannot be its own parent"
    );
  }
  const parent = await getIssue(parentId);
  if (!parent) {
    throw VortexError.fromCode("BAD_REQUEST", "Parent issue not found");
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

function validateIssueResolution(
  status: IssueStatus,
  resolution: IssueResolution | null
): IssueResolution | null {
  if (resolution === null) return null;
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
  return resolution;
}

export class WorkspaceDO extends DurableObject<AppEnv> {
  private organizationId: string;
  private readonly ready: Promise<void>;
  private searchIndex: WorkspaceSearchIndex | null = null;
  private readonly db = drizzle(this.ctx.storage, {
    schema: workspaceSchema,
  });

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.organizationId = ctx.id.toString();
    this.ready = this.initialize();
  }

  private async initialize() {
    const [stored, , backfilled] = await Promise.all([
      this.ctx.storage.get<string>("organizationId"),
      this.runMigrations(),
      this.ctx.storage.get<boolean>("workspaceDataBackfilled"),
    ]);
    if (stored) {
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
      await this.db.insert(workspaceIssueSubscribers).values(subscribers);
    }
    if (relations.length > 0) {
      await this.db.insert(workspaceIssueRelations).values(relations);
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
    this.ctx.acceptWebSocket(client);

    await this.emit({
      type: "connected",
      organizationId: this.organizationId,
    });

    return new Response(null, {
      status: 101,
      webSocket: server,
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
  }

  private async ensureSearchIndex() {
    if (this.searchIndex) return this.searchIndex;

    const index = await createWorkspaceSearchIndex();
    const [issues, commentRows, documentRows] = await Promise.all([
      this.db.select().from(workspaceIssues).all(),
      this.db
        .select({
          id: workspaceComments.id,
          issueId: workspaceComments.issueId,
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
    if (docs.length > 0) {
      await insertSearchDocs(index, docs);
    }

    this.searchIndex = index;
    return index;
  }

  private async emit(event: RealtimeEvent) {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify(event));
      } catch {
        // socket may be closing
      }
    }
    this.ctx.waitUntil(this.sendWebhookEvent(event));
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
      .where(eq(workspaceComments.issueId, issueId))
      .all();
  }

  async listDocumentComments(documentId: string) {
    await this.ready;
    return this.db
      .select()
      .from(workspaceComments)
      .where(eq(workspaceComments.documentId, documentId))
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
    mentions?: string[];
    authorId?: string | null;
    body: string;
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
      issueId: values.issueId ?? null,
      documentId: values.documentId ?? null,
      authorId: values.authorId ?? null,
      body: values.body,
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
          data.listDocumentWatchers(this.db, subjectId).map(
            async (watcherId) => {
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
            }
          )
        );
      }
      await Promise.all(
        (values.mentions ?? []).map(async (mentionId) => {
          if (mentionId === values.authorId || notified.has(mentionId))
            return;
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

  async listWorkspaceComments() {
    await this.ready;
    return this.db.select().from(workspaceComments).all();
  }

  // Recipients live partly in the registry (memberships, GitHub/user
  // mappings) and partly in workspace tables (subscribers, linear_users).
  private async resolveIssueRecipients(
    issue: { id: string; assigneeId: string | null },
    excludeRecipientId?: string
  ): Promise<string[]> {
    const recipients = new Set<string>();
    const d1 = createD1(this.env.D1);
    const org = this.organizationId;

    if (issue.assigneeId) {
      const membership = await getWorkspaceMembership(
        d1,
        org,
        issue.assigneeId
      );
      if (membership) {
        recipients.add(issue.assigneeId);
      } else {
        const github = await d1
          .select({ userId: githubUsers.userId })
          .from(githubUsers)
          .where(
            and(
              eq(githubUsers.organizationId, org),
              eq(githubUsers.githubLogin, issue.assigneeId)
            )
          )
          .get();
        if (github) {
          recipients.add(github.userId);
        } else {
          const linear = await this.db
            .select({ email: workspaceLinearUsers.email })
            .from(workspaceLinearUsers)
            .where(
              and(
                eq(workspaceLinearUsers.organizationId, org),
                eq(workspaceLinearUsers.linearId, issue.assigneeId)
              )
            )
            .get();
          if (linear?.email) {
            const matchedUser = await d1
              .select({ id: globalUser.id })
              .from(globalUser)
              .where(eq(globalUser.email, linear.email))
              .get();
            if (matchedUser) {
              recipients.add(matchedUser.id);
            }
          }
        }
      }
    }

    const subscribers = await this.db
      .select({ linearUserId: workspaceIssueSubscribers.linearUserId })
      .from(workspaceIssueSubscribers)
      .where(eq(workspaceIssueSubscribers.issueId, issue.id))
      .all();

    if (subscribers.length > 0) {
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
      if (emails.length > 0) {
        const matchedUsers = await d1
          .select({ id: globalUser.id })
          .from(globalUser)
          .where(inArray(globalUser.email, emails))
          .all();
        for (const matchedUser of matchedUsers) {
          recipients.add(matchedUser.id);
        }
      }
    }

    if (excludeRecipientId) {
      recipients.delete(excludeRecipientId);
    }
    return [...recipients];
  }

  // Single notification path: preference-gated in-app row + email fanout.
  private async deliverNotification(
    input: Omit<data.NotificationInput, "organizationId">
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
    if (prefs?.email && this.env.EMAIL && this.env.EMAIL_FROM) {
      try {
        const d1 = createD1(this.env.D1);
        const recipient = await d1
          .select({ email: globalUser.email })
          .from(globalUser)
          .where(eq(globalUser.id, input.recipientId))
          .get();
        if (!recipient?.email) return;
        const subject = `Vortex: ${input.type.replace(/_/g, " ")}`;
        const text = `You have a new ${input.type.replace(
          /_/g,
          " "
        )} notification in workspace ${this.organizationId}.\n`;
        const raw = [
          `From: ${this.env.EMAIL_FROM}`,
          `To: ${recipient.email}`,
          `Subject: ${subject}`,
          "MIME-Version: 1.0",
          'Content-Type: text/plain; charset="utf-8"',
          "",
          text,
        ].join("\r\n");
        const message = new EmailMessage(
          this.env.EMAIL_FROM,
          recipient.email,
          raw
        );
        await this.env.EMAIL.send(message);
      } catch {
        // Email delivery is best-effort; never block the notification.
      }
    }
  }

  private async notifyIssueEvent(
    issue: { id: string; assigneeId: string | null },
    type: data.NotificationType,
    actorId?: string
  ): Promise<void> {
    const recipients = await this.resolveIssueRecipients(issue, actorId);
    await Promise.all(
      recipients.map(async (recipientId) => {
        await this.deliverNotification({
          recipientId,
          recipientType: "user",
          issueId: issue.id,
          type,
        });
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
    } = {}
  ) {
    return data.getNotificationsForRecipient(
      this.db,
      this.organizationId,
      recipientId,
      recipientType,
      options
    );
  }

  unreadNotificationCount(
    recipientId: string,
    recipientType: data.RecipientType
  ) {
    return data.getUnreadNotificationCount(
      this.db,
      this.organizationId,
      recipientId,
      recipientType
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
    return this.db.select().from(workspaceIssueSubscribers).all();
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
    return this.db.select().from(workspaceIssueRelations).all();
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

  listWorkspaceAttachments() {
    return this.db.select().from(workspaceAttachments).all();
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
    const doc = data.createDocument(this.db, {
      ...input,
      organizationId: this.organizationId,
    });
    this.audit("document.created", "document", doc.id, input.createdById);
    await this.syncDocumentLinks(doc.id, doc.content, doc.contentFormat);
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
    const doc = data.updateDocument(
      this.db,
      this.organizationId,
      id,
      update,
      actorId
    );
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
      if (update.content !== undefined) {
        await this.syncDocumentLinks(id, doc.content, doc.contentFormat);
      }
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

  // ---- customers ----
  createCustomer(input: Omit<data.CustomerInput, "organizationId">) {
    const customer = data.createCustomer(this.db, {
      ...input,
      organizationId: this.organizationId,
    });
    this.audit("customer.created", "customer", customer.id, input.ownerId);
    return customer;
  }

  listCustomers() {
    return data.listCustomers(this.db, this.organizationId);
  }

  getCustomer(id: string) {
    return data.getCustomer(this.db, this.organizationId, id);
  }

  updateCustomer(
    id: string,
    patch: Partial<Omit<data.CustomerInput, "organizationId">>,
    actorId?: string
  ) {
    const customer = data.updateCustomer(
      this.db,
      this.organizationId,
      id,
      patch
    );
    if (customer) this.audit("customer.updated", "customer", id, actorId);
    return customer;
  }

  deleteCustomer(id: string, actorId?: string) {
    const deleted = data.deleteCustomer(this.db, this.organizationId, id);
    if (deleted) this.audit("customer.deleted", "customer", id, actorId);
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

  deleteCustomerTier(id: string) {
    return data.deleteCustomerTier(this.db, this.organizationId, id);
  }

  createCustomerStatus(input: {
    name: string;
    color?: string | null;
    position?: number;
  }) {
    return data.createCustomerStatus(this.db, this.organizationId, input);
  }

  listCustomerStatuses() {
    return data.listCustomerStatuses(this.db, this.organizationId);
  }

  deleteCustomerStatus(id: string) {
    return data.deleteCustomerStatus(this.db, this.organizationId, id);
  }

  createCustomerNeed(input: data.CustomerNeedInput, actorId?: string) {
    const need = data.createCustomerNeed(
      this.db,
      this.organizationId,
      input
    );
    this.audit("customer_need.created", "customer", need.customerId, actorId);
    return need;
  }

  listCustomerNeeds(
    args: { customerId?: string; issueId?: string; projectId?: string } = {}
  ) {
    return data.listCustomerNeeds(this.db, this.organizationId, args);
  }

  deleteCustomerNeed(id: string) {
    return data.deleteCustomerNeed(this.db, this.organizationId, id);
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
    }
  ) {
    return data.updateDocumentSpace(this.db, this.organizationId, id, patch);
  }

  deleteDocumentSpace(id: string) {
    return data.deleteDocumentSpace(this.db, this.organizationId, id);
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
    return data.watchDocument(
      this.db,
      this.organizationId,
      documentId,
      userId
    );
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

  // Extract [[doc slug/id]] and ISSUE-KEY references from content.
  private async syncDocumentLinks(
    documentId: string,
    content: string,
    contentFormat: string
  ) {
    const text =
      contentFormat === "markdown"
        ? content
        : blockNoteToPlainText(content);
    const docRefs = [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map(
      (m) => m[1]
    );
    const issueKeys = [...text.matchAll(/\b([A-Z][A-Z0-9]+-\d+)\b/g)].map(
      (m) => m[1]
    );
    const [docTargets, issueTargets] = await Promise.all([
      Promise.all(
        docRefs.map((ref) =>
          this.db
            .select({ id: workspaceDocuments.id })
            .from(workspaceDocuments)
            .where(
              or(
                eq(workspaceDocuments.slug, ref),
                eq(workspaceDocuments.id, ref)
              )
            )
            .get()
        )
      ),
      Promise.all(
        issueKeys.map((key) => this.getIssueByIdentifier(key))
      ),
    ]);
    const links: Array<{ targetType: string; targetId: string }> = [];
    for (const target of docTargets) {
      if (target) links.push({ targetType: "document", targetId: target.id });
    }
    for (const issue of issueTargets) {
      if (issue) links.push({ targetType: "issue", targetId: issue.id });
    }
    data.replaceDocumentLinks(
      this.db,
      this.organizationId,
      documentId,
      links
    );
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

  listDocumentPermissions(documentId: string) {
    return data.listDocumentPermissions(this.db, documentId);
  }

  documentAccessLevel(
    documentId: string,
    actorId: string,
    teamIds: string[] = []
  ) {
    return data.documentAccessLevel(this.db, documentId, actorId, teamIds);
  }

  listDocumentLinks(
    args: { documentId?: string; targetType?: string; targetId?: string } = {}
  ) {
    return data.listDocumentLinks(this.db, this.organizationId, args);
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
  createAgentSession(input: Omit<data.AgentSessionInput, "organizationId">) {
    return data.createAgentSession(this.db, {
      ...input,
      organizationId: this.organizationId,
    });
  }

  getAgentSession(id: string) {
    return data.getAgentSession(this.db, this.organizationId, id);
  }

  listAgentSessions(options: { issueId?: string; limit?: number } = {}) {
    return data.listAgentSessions(this.db, this.organizationId, options);
  }

  updateAgentSession(
    id: string,
    input: Parameters<typeof data.updateAgentSession>[3]
  ) {
    return data.updateAgentSession(this.db, this.organizationId, id, input);
  }

  addAgentActivity(input: data.AgentActivityInput) {
    return data.addAgentActivity(this.db, input);
  }

  // ---- agent provider configs ----
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

  listAgentActivities(sessionId: string, options: { limit?: number } = {}) {
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
    changes?: Record<string, { from: unknown; to: unknown }> | null
  ) {
    data.recordAuditEntry(this.db, {
      organizationId: this.organizationId,
      actorId,
      action,
      entityType,
      entityId,
      changes: changes ?? null,
    });
  }

  listAuditLog(args: { entityType?: string; entityId?: string; limit?: number } = {}) {
    return data.listAuditLog(this.db, this.organizationId, args);
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

  async createIssue(input: IssueInput, actorId?: string): Promise<Issue> {
    await this.ready;
    const now = new Date().toISOString();
    const id = input.id ?? crypto.randomUUID();
    const status = input.status ?? "backlog";
    const resolution = validateIssueResolution(
      status,
      input.resolution ?? null
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

    const issue = await this.db
      .insert(workspaceIssues)
      .values({
        id,
        organizationId: this.organizationId,
        teamId: team.id,
        title: input.title,
        description: input.description ?? null,
        status,
        priority: resolvedPriority,
        resolution,
        parentId: parent?.id ?? null,
        subIssueSortOrder: input.subIssueSortOrder ?? null,
        estimate: input.estimate ?? null,
        isDraft: input.isDraft ?? false,
        snoozedUntil: input.snoozedUntil ?? null,
        assigneeId: resolvedAssigneeId,
        projectId: resolvedProjectId,
        cycleId: resolvedCycleId,
        labelIds: input.labelIds ?? null,
        number,
        identifier,
        repo: input.repo ?? null,
        branch: input.branch ?? null,
        prUrl: null,
        prState: null,
        createdAt: input.createdAt ?? now,
        updatedAt: input.updatedAt ?? now,
      })
      .returning()
      .get();

    if (!issue) {
      throw new Error("Failed to create issue");
    }

    const index = await this.ensureSearchIndex();
    await indexIssueDocument(index, issue);

    await this.emit({
      type: "issue.created",
      organizationId: this.organizationId,
      issue,
    });
    await this.notifyIssueEvent(issue, "issue_created", actorId);
    await this.recordIssueHistory(
      issue.id,
      [{ field: "created", fromValue: null, toValue: issue.title }],
      actorId
    );
    this.audit("issue.created", "issue", issue.id, actorId);
    return issue;
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
      | "teamId"
      | "projectId"
      | "cycleId",
    teamIds?: string[]
  ): Promise<{ group: string | null; count: number; estimateTotal: number }[]> {
    await this.ready;
    if (teamIds && teamIds.length === 0) return [];
    const columns = {
      status: workspaceIssues.status,
      priority: workspaceIssues.priority,
      assigneeId: workspaceIssues.assigneeId,
      teamId: workspaceIssues.teamId,
      projectId: workspaceIssues.projectId,
      cycleId: workspaceIssues.cycleId,
    };
    const column = columns[groupBy];
    const conditions = teamIds
      ? [inArray(workspaceIssues.teamId, teamIds)]
      : [];
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
    window?: { startDate?: string | null; endDate?: string | null }
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

  async getIssue(id: string): Promise<Issue | undefined> {
    await this.ready;
    return this.db
      .select()
      .from(workspaceIssues)
      .where(eq(workspaceIssues.id, id))
      .get();
  }

  async getIssueChildren(id: string): Promise<Issue[]> {
    await this.ready;
    return this.db
      .select()
      .from(workspaceIssues)
      .where(eq(workspaceIssues.parentId, id))
      .orderBy(
        asc(workspaceIssues.subIssueSortOrder),
        desc(workspaceIssues.createdAt)
      )
      .all();
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

  async indexComment(comment: CommentForSearch) {
    await this.ready;
    const index = await this.ensureSearchIndex();
    await indexCommentDocument(index, comment);
  }

  async listIssues(args: ListIssuesArgs = {}): Promise<Issue[]> {
    await this.ready;
    const conditions = [];

    const visibleTeamIds =
      args.teamIds && args.teamIds.length > 0 ? args.teamIds : undefined;

    if (visibleTeamIds) {
      conditions.push(inArray(workspaceIssues.teamId, visibleTeamIds));
    }
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
    if (args.projectId) {
      conditions.push(eq(workspaceIssues.projectId, args.projectId));
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
    patch: Partial<IssueInput>,
    actorId?: string
  ): Promise<Issue | undefined> {
    await this.ready;
    const old = await this.getIssue(id);
    if (!old) return undefined;

    const newStatus = patch.status ?? old.status;
    const newResolution =
      patch.resolution !== undefined
        ? patch.resolution
        : patch.status !== undefined && newStatus !== old.status
          ? null
          : old.resolution;
    const resolvedResolution = validateIssueResolution(
      newStatus,
      newResolution
    );

    const set: Partial<Issue> = {
      updatedAt: new Date().toISOString(),
    };

    const allowed: Array<{ key: IssueKey; field: string }> = [
      { key: "teamId", field: "team_id" },
      { key: "title", field: "title" },
      { key: "description", field: "description" },
      { key: "status", field: "status" },
      { key: "priority", field: "priority" },
      { key: "resolution", field: "resolution" },
      { key: "parentId", field: "parent_id" },
      { key: "subIssueSortOrder", field: "sub_issue_sort_order" },
      { key: "estimate", field: "estimate" },
      { key: "isDraft", field: "is_draft" },
      { key: "snoozedUntil", field: "snoozed_until" },
      { key: "assigneeId", field: "assignee_id" },
      { key: "projectId", field: "project_id" },
      { key: "cycleId", field: "cycle_id" },
      { key: "labelIds", field: "label_ids" },
      { key: "repo", field: "repo" },
      { key: "branch", field: "branch" },
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
          .where(eq(workspaceIssues.parentId, id))
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
            id,
            patch.parentId,
            new Set<string>()
          )
        ) {
          throw VortexError.fromCode(
            "BAD_REQUEST",
            "Parent would create a cycle"
          );
        }
        newParentId = patch.parentId;
      }
    }

    if (patch.teamId !== undefined && patch.teamId !== old.teamId) {
      const d1 = createD1(this.env.D1);
      const team = await getTeamById(d1, patch.teamId, this.organizationId);
      if (!team) {
        throw new Error("Team not found");
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
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.priority !== undefined) set.priority = patch.priority;
    if (patch.resolution !== undefined || patch.status !== undefined) {
      set.resolution = resolvedResolution;
    }
    if (newParentId !== undefined) set.parentId = newParentId;
    if (patch.subIssueSortOrder !== undefined)
      set.subIssueSortOrder = patch.subIssueSortOrder;
    if (patch.estimate !== undefined) set.estimate = patch.estimate;
    if (patch.isDraft !== undefined) set.isDraft = patch.isDraft;
    if (patch.snoozedUntil !== undefined) set.snoozedUntil = patch.snoozedUntil;
    if (
      patch.snoozedUntil === undefined &&
      patch.status !== undefined &&
      patch.status !== "triage"
    ) {
      set.snoozedUntil = null;
    }
    if (patch.assigneeId !== undefined) set.assigneeId = patch.assigneeId;
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

    if (Object.keys(set).length === 1 && "updatedAt" in set) {
      return old;
    }

    const issue = await this.db
      .update(workspaceIssues)
      .set(set)
      .where(eq(workspaceIssues.id, id))
      .returning()
      .get();
    if (!issue) return undefined;

    const historyEntries = allowed
      .filter(({ key }) => key in patch)
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

    if (historyEntries.length > 0) {
      await this.recordIssueHistory(issue.id, historyEntries, actorId);
    }

    const index = await this.ensureSearchIndex();
    await indexIssueDocument(index, issue);

    await this.emit({
      type: "issue.updated",
      organizationId: this.organizationId,
      issue,
    });
    await this.notifyIssueEvent(issue, "issue_updated", actorId);

    if (issue.status !== old.status) {
      await this.applyStatusAutomation(issue, old, actorId);
    }

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of Object.keys(patch) as (keyof Issue)[]) {
      if (issue[key] !== old[key]) {
        changes[key] = { from: old[key], to: issue[key] };
      }
    }
    this.audit("issue.updated", "issue", issue.id, actorId, changes);
    return issue;
  }

  private async applyStatusAutomation(
    issue: Issue,
    old: Issue,
    actorId?: string
  ): Promise<void> {
    const d1 = createD1(this.env.D1);
    const team = await getTeamById(d1, issue.teamId, this.organizationId);
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
  }

  async batchUpdateIssues(
    ids: string[],
    patch: Partial<IssueInput>,
    actorId?: string
  ): Promise<Issue[]> {
    return this.batchUpdateSequentially(ids, 0, patch, actorId, []);
  }

  private async batchUpdateSequentially(
    ids: string[],
    index: number,
    patch: Partial<IssueInput>,
    actorId: string | undefined,
    acc: Issue[]
  ): Promise<Issue[]> {
    if (index >= ids.length) return acc;
    const issue = await this.updateIssue(ids[index], patch, actorId);
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

  async deleteIssue(id: string, actorId?: string): Promise<boolean> {
    await this.ready;
    const old = await this.getIssue(id);
    const deleted = await this.db
      .delete(workspaceIssues)
      .where(eq(workspaceIssues.id, id))
      .returning()
      .get();
    if (!deleted) return false;

    const commentIds = (
      await this.db
        .select({ id: workspaceComments.id })
        .from(workspaceComments)
        .where(eq(workspaceComments.issueId, id))
        .all()
    ).map((row) => row.id);
    await this.db
      .delete(workspaceIssueHistory)
      .where(eq(workspaceIssueHistory.issueId, id));
    await this.db
      .delete(workspaceComments)
      .where(eq(workspaceComments.issueId, id));
    await this.db
      .delete(workspaceIssueSubscribers)
      .where(eq(workspaceIssueSubscribers.issueId, id));
    await this.db
      .delete(workspaceIssueRelations)
      .where(
        or(
          eq(workspaceIssueRelations.fromIssueId, id),
          eq(workspaceIssueRelations.toIssueId, id)
        )
      );
    await this.db
      .delete(workspaceIssueApprovals)
      .where(eq(workspaceIssueApprovals.issueId, id));
    const reactionTargets = [id, ...commentIds];
    if (reactionTargets.length > 0) {
      await this.db
        .delete(workspaceReactions)
        .where(inArray(workspaceReactions.targetId, reactionTargets));
    }
    await this.db
      .delete(workspaceAttachments)
      .where(eq(workspaceAttachments.issueId, id));
    await this.db
      .delete(workspaceNotifications)
      .where(eq(workspaceNotifications.issueId, id));
    const sessionIds = (
      await this.db
        .select({ id: workspaceAgentSessions.id })
        .from(workspaceAgentSessions)
        .where(eq(workspaceAgentSessions.issueId, id))
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

    const index = await this.ensureSearchIndex();
    await removeIssueDocuments(index, id);

    await this.emit({
      type: "issue.deleted",
      organizationId: this.organizationId,
      issueId: id,
    });
    if (old) {
      await this.notifyIssueEvent(old, "issue_deleted", actorId);
    }
    this.audit("issue.deleted", "issue", id, actorId, {
      title: { from: old?.title, to: null },
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
    identifier: string,
    prUrl: string,
    prState: string,
    repo: string,
    branch: string,
    actorId?: string
  ): Promise<Issue | undefined> {
    await this.ready;
    const old = await this.getIssueByIdentifier(identifier);
    if (!old) return undefined;

    const statusMap: Record<string, Issue["status"] | undefined> = {
      draft: "backlog",
      open: "in_progress",
      merged: "done",
      closed: "canceled",
    };
    const status = statusMap[prState];
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
      set.branch = branch;
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

    const statusMap: Record<string, Issue["status"] | undefined> = {
      draft: "backlog",
      open: "in_progress",
      merged: "done",
      closed: "canceled",
    };
    const status = statusMap[prState];
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
      .where(
        and(eq(workspaceIssues.repo, repo), eq(workspaceIssues.branch, branch))
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
}
