// Workspace-local data layer. These functions run inside the workspace's
// Durable Object against its own SQLite — they replace the D1 modules for
// all per-workspace content (comments, history, subscribers, relations,
// approvals, reactions, attachments, notifications, saved views, agent
// sessions, webhook subs, linear users).
import {
  and,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import type { FilterCondition } from "./filter.js";
import type { workspaceSchema } from "./schema-map.js";
import {
  workspaceAgentActivities,
  workspaceAgentProviderConfigs,
  workspaceAgentSessions,
  workspaceAttachments,
  workspaceIssueApprovals,
  workspaceIssueRelations,
  workspaceIssueSubscribers,
  workspaceLinearUsers,
  workspaceNotifications,
  workspaceReactions,
  workspaceSavedViews,
  workspaceUserPreferences,
  workspaceViewFavorites,
  workspaceWebhookSubscriptions,
  workspaceOutboundWebhookDeliveries,
} from "./schema.js";

export type WorkspaceDb = DrizzleSqliteDODatabase<typeof workspaceSchema>;

// ---- issue_subscribers ----

export function listIssueSubscribers(
  db: WorkspaceDb,
  organizationId: string,
  issueId: string
) {
  return db
    .select()
    .from(workspaceIssueSubscribers)
    .where(
      and(
        eq(workspaceIssueSubscribers.organizationId, organizationId),
        eq(workspaceIssueSubscribers.issueId, issueId)
      )
    )
    .all();
}

export function getIssueSubscriber(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceIssueSubscribers)
    .where(
      and(
        eq(workspaceIssueSubscribers.organizationId, organizationId),
        eq(workspaceIssueSubscribers.id, id)
      )
    )
    .get();
}

export async function deleteIssueSubscriber(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  await db
    .delete(workspaceIssueSubscribers)
    .where(
      and(
        eq(workspaceIssueSubscribers.organizationId, organizationId),
        eq(workspaceIssueSubscribers.id, id)
      )
    );
}

export async function createIssueSubscriber(
  db: WorkspaceDb,
  organizationId: string,
  values: { issueId: string; linearUserId: string }
) {
  const existing = await db
    .select()
    .from(workspaceIssueSubscribers)
    .where(
      and(
        eq(workspaceIssueSubscribers.organizationId, organizationId),
        eq(workspaceIssueSubscribers.issueId, values.issueId),
        eq(workspaceIssueSubscribers.linearUserId, values.linearUserId)
      )
    )
    .get();
  if (existing) return existing;
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(workspaceIssueSubscribers).values({
    id,
    organizationId,
    issueId: values.issueId,
    linearUserId: values.linearUserId,
    createdAt: ts,
  });
  return getIssueSubscriber(db, organizationId, id);
}

// ---- issue_relations ----

const relationTypes = new Set(["related", "blocks", "duplicate", "similar"]);

export function isValidRelationType(type: string): boolean {
  return relationTypes.has(type);
}

export function listIssueRelations(
  db: WorkspaceDb,
  organizationId: string,
  fromIssueId: string
) {
  return db
    .select()
    .from(workspaceIssueRelations)
    .where(
      and(
        eq(workspaceIssueRelations.organizationId, organizationId),
        eq(workspaceIssueRelations.fromIssueId, fromIssueId)
      )
    )
    .all();
}

export function listInverseIssueRelations(
  db: WorkspaceDb,
  organizationId: string,
  toIssueId: string
) {
  return db
    .select()
    .from(workspaceIssueRelations)
    .where(
      and(
        eq(workspaceIssueRelations.organizationId, organizationId),
        eq(workspaceIssueRelations.toIssueId, toIssueId)
      )
    )
    .all();
}

export function getIssueRelation(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceIssueRelations)
    .where(
      and(
        eq(workspaceIssueRelations.organizationId, organizationId),
        eq(workspaceIssueRelations.id, id)
      )
    )
    .get();
}

export async function createIssueRelation(
  db: WorkspaceDb,
  organizationId: string,
  values: { fromIssueId: string; toIssueId: string; type: string }
) {
  if (!isValidRelationType(values.type)) {
    throw new Error(`Invalid relation type: ${values.type}`);
  }
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(workspaceIssueRelations).values({
    id,
    organizationId,
    fromIssueId: values.fromIssueId,
    toIssueId: values.toIssueId,
    type: values.type,
    createdAt: ts,
  });
  return getIssueRelation(db, organizationId, id);
}

export async function deleteIssueRelation(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  await db
    .delete(workspaceIssueRelations)
    .where(
      and(
        eq(workspaceIssueRelations.organizationId, organizationId),
        eq(workspaceIssueRelations.id, id)
      )
    );
}

// ---- reactions ----

export interface CreateReactionInput {
  organizationId: string;
  targetType: string;
  targetId: string;
  actorId: string;
  emoji: string;
}

export async function createReaction(
  db: WorkspaceDb,
  input: CreateReactionInput
) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(workspaceReactions).values({
    id,
    organizationId: input.organizationId,
    targetType: input.targetType,
    targetId: input.targetId,
    actorId: input.actorId,
    emoji: input.emoji,
    createdAt: now,
    updatedAt: now,
  });
  return getReaction(db, input.organizationId, id);
}

export function listReactions(
  db: WorkspaceDb,
  organizationId: string,
  targetType: string,
  targetId: string
) {
  return db
    .select()
    .from(workspaceReactions)
    .where(
      and(
        eq(workspaceReactions.organizationId, organizationId),
        eq(workspaceReactions.targetType, targetType),
        eq(workspaceReactions.targetId, targetId)
      )
    )
    .all();
}

export function getReaction(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceReactions)
    .where(
      and(
        eq(workspaceReactions.organizationId, organizationId),
        eq(workspaceReactions.id, id)
      )
    )
    .get();
}

export async function deleteReaction(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  const result = await db
    .delete(workspaceReactions)
    .where(
      and(
        eq(workspaceReactions.organizationId, organizationId),
        eq(workspaceReactions.id, id)
      )
    )
    .returning()
    .get();
  return !!result;
}

// ---- attachments ----

export function listAttachments(
  db: WorkspaceDb,
  organizationId: string,
  issueId: string
) {
  return db
    .select()
    .from(workspaceAttachments)
    .where(
      and(
        eq(workspaceAttachments.organizationId, organizationId),
        eq(workspaceAttachments.issueId, issueId)
      )
    )
    .all();
}

export function getAttachment(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceAttachments)
    .where(
      and(
        eq(workspaceAttachments.organizationId, organizationId),
        eq(workspaceAttachments.id, id)
      )
    )
    .get();
}

export async function createAttachment(
  db: WorkspaceDb,
  organizationId: string,
  values: {
    issueId: string;
    linearId: string;
    url: string;
    title?: string | null;
    subtitle?: string | null;
    r2Key?: string | null;
    createdAt?: string;
  }
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(workspaceAttachments).values({
    id,
    organizationId,
    issueId: values.issueId,
    linearId: values.linearId,
    url: values.url,
    title: values.title ?? null,
    subtitle: values.subtitle ?? null,
    r2Key: values.r2Key ?? null,
    createdAt: values.createdAt ?? ts,
  });
  return getAttachment(db, organizationId, id);
}

export async function setAttachmentR2Key(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  r2Key: string
) {
  await db
    .update(workspaceAttachments)
    .set({ r2Key })
    .where(
      and(
        eq(workspaceAttachments.organizationId, organizationId),
        eq(workspaceAttachments.id, id)
      )
    );
}

// ---- saved_views / favorites / prefs ----

export interface SavedViewInput {
  organizationId: string;
  ownerId: string;
  name: string;
  shared?: boolean;
  filter: FilterCondition;
  search?: string | null;
  sort?: SavedViewSort | null;
  columns?: string[] | null;
}

export type SavedViewRecord = typeof workspaceSavedViews.$inferSelect;

export interface SavedViewSort {
  field: string;
  direction?: "asc" | "desc";
}

export function createSavedView(db: WorkspaceDb, input: SavedViewInput) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  return db
    .insert(workspaceSavedViews)
    .values({
      id,
      organizationId: input.organizationId,
      ownerId: input.ownerId,
      name: input.name,
      shared: input.shared ?? false,
      filter: JSON.stringify(input.filter),
      search: input.search ?? null,
      sort: input.sort ? JSON.stringify(input.sort) : null,
      columns: input.columns ? JSON.stringify(input.columns) : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function listSavedViews(
  db: WorkspaceDb,
  organizationId: string,
  userId?: string
) {
  const condition = userId
    ? and(
        eq(workspaceSavedViews.organizationId, organizationId),
        or(
          eq(workspaceSavedViews.ownerId, userId),
          eq(workspaceSavedViews.shared, true)
        )
      )
    : eq(workspaceSavedViews.organizationId, organizationId);
  return db.select().from(workspaceSavedViews).where(condition).all();
}

export function getSavedView(
  db: WorkspaceDb,
  id: string,
  organizationId: string
) {
  return db
    .select()
    .from(workspaceSavedViews)
    .where(
      and(
        eq(workspaceSavedViews.id, id),
        eq(workspaceSavedViews.organizationId, organizationId)
      )
    )
    .get();
}

export interface SavedViewUpdate {
  name?: string;
  shared?: boolean;
  filter?: FilterCondition;
  search?: string | null;
  sort?: SavedViewSort | null;
  columns?: string[] | null;
}

export function updateSavedView(
  db: WorkspaceDb,
  id: string,
  organizationId: string,
  update: SavedViewUpdate
) {
  const set: Partial<Record<string, string | boolean | null>> = {
    updatedAt: new Date().toISOString(),
  };
  if (update.name !== undefined) set.name = update.name;
  if (update.shared !== undefined) set.shared = update.shared;
  if (update.filter !== undefined) set.filter = JSON.stringify(update.filter);
  if (update.search !== undefined) set.search = update.search ?? null;
  if (update.sort !== undefined) {
    set.sort = update.sort ? JSON.stringify(update.sort) : null;
  }
  if (update.columns !== undefined) {
    set.columns = update.columns ? JSON.stringify(update.columns) : null;
  }
  return db
    .update(workspaceSavedViews)
    .set(set)
    .where(
      and(
        eq(workspaceSavedViews.id, id),
        eq(workspaceSavedViews.organizationId, organizationId)
      )
    )
    .returning()
    .get();
}

export function deleteSavedView(
  db: WorkspaceDb,
  id: string,
  organizationId: string
) {
  return db
    .delete(workspaceSavedViews)
    .where(
      and(
        eq(workspaceSavedViews.id, id),
        eq(workspaceSavedViews.organizationId, organizationId)
      )
    )
    .returning()
    .get();
}

export function favoriteView(
  db: WorkspaceDb,
  organizationId: string,
  viewId: string,
  userId: string
) {
  return db
    .insert(workspaceViewFavorites)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      viewId,
      userId,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing({
      target: [workspaceViewFavorites.viewId, workspaceViewFavorites.userId],
    });
}

export function unfavoriteView(
  db: WorkspaceDb,
  viewId: string,
  userId: string
) {
  return db
    .delete(workspaceViewFavorites)
    .where(
      and(
        eq(workspaceViewFavorites.viewId, viewId),
        eq(workspaceViewFavorites.userId, userId)
      )
    )
    .run();
}

export function listFavoriteViewIds(
  db: WorkspaceDb,
  organizationId: string,
  userId: string
) {
  return db
    .select({ viewId: workspaceViewFavorites.viewId })
    .from(workspaceViewFavorites)
    .where(
      and(
        eq(workspaceViewFavorites.organizationId, organizationId),
        eq(workspaceViewFavorites.userId, userId)
      )
    )
    .all();
}

export function getUserViewPreferences(
  db: WorkspaceDb,
  organizationId: string,
  userId: string
) {
  return db
    .select()
    .from(workspaceUserPreferences)
    .where(
      and(
        eq(workspaceUserPreferences.organizationId, organizationId),
        eq(workspaceUserPreferences.userId, userId)
      )
    )
    .get();
}

export async function setDefaultView(
  db: WorkspaceDb,
  organizationId: string,
  userId: string,
  defaultViewId: string | null
) {
  const existing = await getUserViewPreferences(db, organizationId, userId);
  const ts = new Date().toISOString();
  if (existing) {
    await db
      .update(workspaceUserPreferences)
      .set({ defaultViewId, updatedAt: ts })
      .where(
        and(
          eq(workspaceUserPreferences.organizationId, organizationId),
          eq(workspaceUserPreferences.userId, userId)
        )
      );
  } else {
    await db.insert(workspaceUserPreferences).values({
      organizationId,
      userId,
      defaultViewId,
      updatedAt: ts,
    });
  }
  return getUserViewPreferences(db, organizationId, userId);
}

// ---- linear_users ----

export function listLinearUsers(db: WorkspaceDb, organizationId: string) {
  return db
    .select()
    .from(workspaceLinearUsers)
    .where(eq(workspaceLinearUsers.organizationId, organizationId))
    .all();
}

export function getLinearUser(
  db: WorkspaceDb,
  organizationId: string,
  linearId: string
) {
  return db
    .select()
    .from(workspaceLinearUsers)
    .where(
      and(
        eq(workspaceLinearUsers.organizationId, organizationId),
        eq(workspaceLinearUsers.linearId, linearId)
      )
    )
    .get();
}

export async function createLinearUser(
  db: WorkspaceDb,
  organizationId: string,
  values: { linearId: string; name?: string; email?: string }
) {
  const existing = await getLinearUser(db, organizationId, values.linearId);
  if (existing) return existing;
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(workspaceLinearUsers).values({
    id,
    organizationId,
    linearId: values.linearId,
    name: values.name ?? null,
    email: values.email ?? null,
    createdAt: ts,
  });
  return getLinearUser(db, organizationId, values.linearId);
}

// ---- notifications ----

export type NotificationType =
  | "issue_created"
  | "issue_updated"
  | "issue_deleted"
  | "comment_created";

export type RecipientType = "user" | "agent";

export interface NotificationInput {
  organizationId: string;
  recipientId: string;
  recipientType?: RecipientType;
  issueId: string;
  type: NotificationType;
  metadata?: Record<string, unknown> | null;
}

export async function createNotification(
  db: WorkspaceDb,
  input: NotificationInput
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(workspaceNotifications).values({
    id,
    organizationId: input.organizationId,
    recipientId: input.recipientId,
    recipientType: input.recipientType ?? "user",
    issueId: input.issueId,
    type: input.type,
    metadata:
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    read: false,
    createdAt: ts,
    updatedAt: ts,
  });
  return db
    .select()
    .from(workspaceNotifications)
    .where(eq(workspaceNotifications.id, id))
    .get();
}

export async function getNotificationsForRecipient(
  db: WorkspaceDb,
  organizationId: string,
  recipientId: string,
  recipientType: RecipientType,
  options: {
    unreadOnly?: boolean;
    snoozedOnly?: boolean;
    includeSnoozed?: boolean;
    limit?: number;
  } = {}
) {
  const nowIso = new Date().toISOString();
  const conditions = [
    eq(workspaceNotifications.organizationId, organizationId),
    eq(workspaceNotifications.recipientId, recipientId),
    eq(workspaceNotifications.recipientType, recipientType),
  ];
  if (options.unreadOnly) {
    conditions.push(eq(workspaceNotifications.read, false));
  }
  if (options.snoozedOnly) {
    conditions.push(isNotNull(workspaceNotifications.snoozedUntil));
    conditions.push(gt(workspaceNotifications.snoozedUntil, nowIso));
  } else if (!options.includeSnoozed) {
    conditions.push(
      sql`(${workspaceNotifications.snoozedUntil} IS NULL OR ${workspaceNotifications.snoozedUntil} < ${nowIso})`
    );
  }
  return db
    .select()
    .from(workspaceNotifications)
    .where(and(...conditions))
    .orderBy(workspaceNotifications.createdAt)
    .limit(options.limit ?? 100)
    .all();
}

export async function getUnreadNotificationCount(
  db: WorkspaceDb,
  organizationId: string,
  recipientId: string,
  recipientType: RecipientType
) {
  const nowIso = new Date().toISOString();
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(workspaceNotifications)
    .where(
      and(
        eq(workspaceNotifications.organizationId, organizationId),
        eq(workspaceNotifications.recipientId, recipientId),
        eq(workspaceNotifications.recipientType, recipientType),
        eq(workspaceNotifications.read, false),
        or(
          isNull(workspaceNotifications.snoozedUntil),
          lte(workspaceNotifications.snoozedUntil, nowIso)
        )
      )
    )
    .get();
  return result?.count ?? 0;
}

async function updateNotificationForRecipient(
  db: WorkspaceDb,
  organizationId: string,
  recipientId: string,
  recipientType: RecipientType,
  notificationId: string,
  values: { read?: boolean; snoozedUntil?: string | null }
) {
  const existing = await db
    .select()
    .from(workspaceNotifications)
    .where(
      and(
        eq(workspaceNotifications.id, notificationId),
        eq(workspaceNotifications.organizationId, organizationId),
        eq(workspaceNotifications.recipientId, recipientId),
        eq(workspaceNotifications.recipientType, recipientType)
      )
    )
    .get();
  if (!existing) return null;
  await db
    .update(workspaceNotifications)
    .set({ ...values, updatedAt: new Date().toISOString() })
    .where(eq(workspaceNotifications.id, notificationId));
  return db
    .select()
    .from(workspaceNotifications)
    .where(eq(workspaceNotifications.id, notificationId))
    .get();
}

export function markNotificationUnread(
  db: WorkspaceDb,
  organizationId: string,
  recipientId: string,
  recipientType: RecipientType,
  notificationId: string
) {
  return updateNotificationForRecipient(
    db,
    organizationId,
    recipientId,
    recipientType,
    notificationId,
    { read: false }
  );
}

export function snoozeNotification(
  db: WorkspaceDb,
  organizationId: string,
  recipientId: string,
  recipientType: RecipientType,
  notificationId: string,
  until: string | null
) {
  return updateNotificationForRecipient(
    db,
    organizationId,
    recipientId,
    recipientType,
    notificationId,
    { snoozedUntil: until }
  );
}

export function markNotificationRead(
  db: WorkspaceDb,
  organizationId: string,
  recipientId: string,
  recipientType: RecipientType,
  notificationId: string
) {
  return updateNotificationForRecipient(
    db,
    organizationId,
    recipientId,
    recipientType,
    notificationId,
    { read: true }
  );
}

export async function markAllNotificationsRead(
  db: WorkspaceDb,
  organizationId: string,
  recipientId: string,
  recipientType: RecipientType
) {
  const ts = new Date().toISOString();
  await db
    .update(workspaceNotifications)
    .set({ read: true, updatedAt: ts })
    .where(
      and(
        eq(workspaceNotifications.organizationId, organizationId),
        eq(workspaceNotifications.recipientId, recipientId),
        eq(workspaceNotifications.recipientType, recipientType),
        eq(workspaceNotifications.read, false)
      )
    );
}

// ---- agent_sessions / agent_activities ----

export interface AgentSessionInput {
  organizationId: string;
  issueId: string;
  agentId: string;
  provider: string;
  actorId: string;
  actorType: "user" | "agent";
  status?:
    | "created"
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "canceled";
  result?: string | null;
  url?: string | null;
}

export async function createAgentSession(
  db: WorkspaceDb,
  input: AgentSessionInput
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(workspaceAgentSessions).values({
    id,
    organizationId: input.organizationId,
    issueId: input.issueId,
    agentId: input.agentId,
    provider: input.provider,
    actorId: input.actorId,
    actorType: input.actorType,
    status: input.status ?? "created",
    result: input.result ?? null,
    url: input.url ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  const row = await db
    .select()
    .from(workspaceAgentSessions)
    .where(eq(workspaceAgentSessions.id, id))
    .get();
  if (!row) {
    throw new Error("Failed to create agent session");
  }
  return row;
}

export function getAgentSession(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceAgentSessions)
    .where(
      and(
        eq(workspaceAgentSessions.organizationId, organizationId),
        eq(workspaceAgentSessions.id, id)
      )
    )
    .get();
}

export function listAgentSessions(
  db: WorkspaceDb,
  organizationId: string,
  options: { issueId?: string; limit?: number } = {}
) {
  const conditions = [
    eq(workspaceAgentSessions.organizationId, organizationId),
  ];
  if (options.issueId) {
    conditions.push(eq(workspaceAgentSessions.issueId, options.issueId));
  }
  return db
    .select()
    .from(workspaceAgentSessions)
    .where(and(...conditions))
    .orderBy(
      desc(workspaceAgentSessions.createdAt),
      desc(workspaceAgentSessions.id)
    )
    .limit(options.limit ?? 100)
    .all();
}

export async function updateAgentSession(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  input: Partial<{
    status:
      | "created"
      | "running"
      | "waiting"
      | "completed"
      | "failed"
      | "canceled";
    result: string | null;
    url: string | null;
  }>
) {
  const existing = await getAgentSession(db, organizationId, id);
  if (!existing) return null;
  const set: Record<string, string | null> = {
    updatedAt: new Date().toISOString(),
  };
  if (input.status !== undefined) set.status = input.status;
  if (input.result !== undefined) set.result = input.result;
  if (input.url !== undefined) set.url = input.url;
  await db
    .update(workspaceAgentSessions)
    .set(set)
    .where(eq(workspaceAgentSessions.id, id));
  return getAgentSession(db, organizationId, id);
}

export interface AgentActivityInput {
  sessionId: string;
  actorId?: string;
  type: "thought" | "response" | "error" | "elicitation" | "action" | "status";
  message: string;
  payload?: Record<string, unknown>;
}

export async function addAgentActivity(
  db: WorkspaceDb,
  input: AgentActivityInput
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(workspaceAgentActivities).values({
    id,
    sessionId: input.sessionId,
    actorId: input.actorId ?? null,
    type: input.type,
    message: input.message,
    payload: input.payload ? JSON.stringify(input.payload) : null,
    createdAt: ts,
  });
  const row = await db
    .select()
    .from(workspaceAgentActivities)
    .where(eq(workspaceAgentActivities.id, id))
    .get();
  if (!row) {
    throw new Error("Failed to create agent activity");
  }
  return row;
}

export function listAgentActivities(
  db: WorkspaceDb,
  sessionId: string,
  options: { limit?: number } = {}
) {
  return db
    .select()
    .from(workspaceAgentActivities)
    .where(eq(workspaceAgentActivities.sessionId, sessionId))
    .orderBy(workspaceAgentActivities.createdAt)
    .limit(options.limit ?? 100)
    .all();
}

export async function getAgentSessionWithActivities(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  const session = await getAgentSession(db, organizationId, id);
  if (!session) return null;
  const activities = await listAgentActivities(db, id);
  return { ...session, activities };
}

export async function getActiveAgentSessionForIssue(
  db: WorkspaceDb,
  organizationId: string,
  issueId: string
) {
  const sessions = await listAgentSessions(db, organizationId, {
    issueId,
    limit: 20,
  });
  const active = sessions.find(
    (s) => !["completed", "failed", "canceled"].includes(s.status)
  );
  if (!active) return null;
  const activities = await listAgentActivities(db, active.id, { limit: 50 });
  return { session: active, activities };
}

// ---- webhook subscriptions + outbound deliveries ----

export function listWebhookSubscriptions(
  db: WorkspaceDb,
  organizationId: string
) {
  return db
    .select()
    .from(workspaceWebhookSubscriptions)
    .where(eq(workspaceWebhookSubscriptions.organizationId, organizationId))
    .all();
}

export function getWebhookSubscription(db: WorkspaceDb, id: string) {
  return db
    .select()
    .from(workspaceWebhookSubscriptions)
    .where(eq(workspaceWebhookSubscriptions.id, id))
    .get();
}

export function findWebhookSubscriptionByWorkspace(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceWebhookSubscriptions)
    .where(
      and(
        eq(workspaceWebhookSubscriptions.id, id),
        eq(workspaceWebhookSubscriptions.organizationId, organizationId)
      )
    )
    .get();
}

export async function createWebhookSubscription(
  db: WorkspaceDb,
  organizationId: string,
  values: { url: string; events?: string; secret?: string }
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(workspaceWebhookSubscriptions).values({
    id,
    organizationId,
    url: values.url,
    events: values.events ?? "*",
    secret: values.secret ?? "",
    createdAt: ts,
  });
  return getWebhookSubscription(db, id);
}

export async function updateWebhookSubscription(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  values: { url?: string; events?: string; secret?: string }
) {
  const existing = await findWebhookSubscriptionByWorkspace(
    db,
    organizationId,
    id
  );
  if (!existing) return null;
  const update: Record<string, string | null> = {};
  if (values.url !== undefined) update.url = values.url;
  if (values.events !== undefined) update.events = values.events;
  if (values.secret !== undefined) update.secret = values.secret;
  if (Object.keys(update).length === 0) return existing;
  await db
    .update(workspaceWebhookSubscriptions)
    .set(update)
    .where(eq(workspaceWebhookSubscriptions.id, id));
  return getWebhookSubscription(db, id);
}

export async function deleteWebhookSubscription(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  const existing = await findWebhookSubscriptionByWorkspace(
    db,
    organizationId,
    id
  );
  if (!existing) return false;
  await db
    .delete(workspaceWebhookSubscriptions)
    .where(eq(workspaceWebhookSubscriptions.id, id));
  return true;
}

export function listWebhookDeliveries(
  db: WorkspaceDb,
  organizationId: string,
  subscriptionId: string
) {
  return db
    .select()
    .from(workspaceOutboundWebhookDeliveries)
    .where(
      and(
        eq(workspaceOutboundWebhookDeliveries.organizationId, organizationId),
        eq(workspaceOutboundWebhookDeliveries.subscriptionId, subscriptionId)
      )
    )
    .all();
}

// ---- issue_approvals ----

export function listIssueApprovals(
  db: WorkspaceDb,
  organizationId: string,
  issueId: string
) {
  return db
    .select()
    .from(workspaceIssueApprovals)
    .where(
      and(
        eq(workspaceIssueApprovals.organizationId, organizationId),
        eq(workspaceIssueApprovals.issueId, issueId)
      )
    )
    .all();
}

export function getIssueApproval(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceIssueApprovals)
    .where(
      and(
        eq(workspaceIssueApprovals.organizationId, organizationId),
        eq(workspaceIssueApprovals.id, id)
      )
    )
    .get();
}

export async function createIssueApproval(
  db: WorkspaceDb,
  organizationId: string,
  input: {
    issueId: string;
    requestedById: string;
    approverId: string;
    comment?: string;
  }
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(workspaceIssueApprovals).values({
    id,
    organizationId,
    issueId: input.issueId,
    requestedById: input.requestedById,
    approverId: input.approverId,
    status: "pending",
    comment: input.comment ?? null,
    createdAt: ts,
  });
  const row = await getIssueApproval(db, organizationId, id);
  if (!row) {
    throw new Error("Failed to create approval");
  }
  return row;
}

export async function resolveIssueApproval(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  status: "approved" | "rejected"
) {
  await db
    .update(workspaceIssueApprovals)
    .set({ status, resolvedAt: new Date().toISOString() })
    .where(
      and(
        eq(workspaceIssueApprovals.organizationId, organizationId),
        eq(workspaceIssueApprovals.id, id)
      )
    );
  return getIssueApproval(db, organizationId, id);
}

// ---- agent_provider_configs ----

export interface AgentProviderConfigInput {
  agentId: string;
  token?: string | null;
  providerOrgId?: string | null;
  outpost?: string | null;
  outpostId?: string | null;
  outpostToken?: string | null;
  computeApiKey?: string | null;
  computeApiUrl?: string | null;
  computeSnapshot?: string | null;
  computeVolumeId?: string | null;
  config?: Record<string, unknown> | null;
}

export async function upsertAgentProviderConfig(
  db: WorkspaceDb,
  organizationId: string,
  input: AgentProviderConfigInput
) {
  const existing = await db
    .select()
    .from(workspaceAgentProviderConfigs)
    .where(
      and(
        eq(workspaceAgentProviderConfigs.organizationId, organizationId),
        eq(workspaceAgentProviderConfigs.agentId, input.agentId)
      )
    )
    .get();
  const now = new Date().toISOString();
  const fields = {
    token: input.token,
    providerOrgId: input.providerOrgId,
    outpost: input.outpost,
    outpostId: input.outpostId,
    outpostToken: input.outpostToken,
    computeApiKey: input.computeApiKey,
    computeApiUrl: input.computeApiUrl,
    computeSnapshot: input.computeSnapshot,
    computeVolumeId: input.computeVolumeId,
    config:
      input.config === undefined
        ? undefined
        : input.config === null
          ? null
          : JSON.stringify(input.config),
  };
  if (existing) {
    const set: Record<string, string | null> = { updatedAt: now };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) set[k] = v;
    }
    await db
      .update(workspaceAgentProviderConfigs)
      .set(set)
      .where(eq(workspaceAgentProviderConfigs.id, existing.id));
    return existing.id;
  }
  const id = crypto.randomUUID();
  await db.insert(workspaceAgentProviderConfigs).values({
    id,
    organizationId,
    agentId: input.agentId,
    token: fields.token ?? null,
    providerOrgId: fields.providerOrgId ?? null,
    outpost: fields.outpost ?? null,
    outpostId: fields.outpostId ?? null,
    outpostToken: fields.outpostToken ?? null,
    computeApiKey: fields.computeApiKey ?? null,
    computeApiUrl: fields.computeApiUrl ?? null,
    computeSnapshot: fields.computeSnapshot ?? null,
    computeVolumeId: fields.computeVolumeId ?? null,
    config: fields.config ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function getAgentProviderConfig(
  db: WorkspaceDb,
  organizationId: string,
  agentId: string
) {
  return db
    .select()
    .from(workspaceAgentProviderConfigs)
    .where(
      and(
        eq(workspaceAgentProviderConfigs.organizationId, organizationId),
        eq(workspaceAgentProviderConfigs.agentId, agentId)
      )
    )
    .get();
}

export async function listAgentProviderConfigs(
  db: WorkspaceDb,
  organizationId: string
) {
  return db
    .select()
    .from(workspaceAgentProviderConfigs)
    .where(eq(workspaceAgentProviderConfigs.organizationId, organizationId))
    .all();
}

export async function deleteAgentProviderConfig(
  db: WorkspaceDb,
  organizationId: string,
  agentId: string
) {
  await db
    .delete(workspaceAgentProviderConfigs)
    .where(
      and(
        eq(workspaceAgentProviderConfigs.organizationId, organizationId),
        eq(workspaceAgentProviderConfigs.agentId, agentId)
      )
    );
}
