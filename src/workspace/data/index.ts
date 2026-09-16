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
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import type { FilterCondition } from "../filter.js";
import type { workspaceSchema } from "../schema-map.js";
import {
  workspaceAgentActivities,
  workspaceAgentSessionEvents,
  workspaceDocumentHistory,
  workspaceDocumentLinks,
  workspaceDocumentPermissions,
  workspaceDocuments,
  workspaceDocumentShares,
  workspaceDocumentSpaces,
  workspaceDocumentWatchers,
  workspaceAgentProviderConfigs,
  workspaceAgentSessions,
  workspaceAttachments,
  workspaceAuditLog,
  workspaceCustomerNeeds,
  workspaceCustomers,
  workspaceCustomerStatuses,
  workspaceCustomerTiers,
  workspaceIssueApprovals,
  workspaceIssues,
  workspaceIssueRelations,
  workspaceIssueSubscribers,
  workspaceLinearUsers,
  workspaceNotificationPreferences,
  workspaceNotifications,
  workspaceReactions,
  workspaceReleasePipelines,
  workspaceReleases,
  workspaceSavedViews,
  gitAutomationStates,
  gitAutomationTargetBranches,
  timeSchedules,
  externalLinks,
  workspaceUserPreferences,
  workspaceViewFavorites,
  workspaceWebhookSubscriptions,
  workspaceOutboundWebhookDeliveries,
} from "../schema.js";

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

export async function deleteAttachment(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  await db
    .delete(workspaceAttachments)
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
  | "comment_created"
  | "document_updated"
  | "document_commented"
  | "mention";

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
  providerSessionId?: string | null;
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
    providerSessionId: input.providerSessionId ?? null,
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
    providerSessionId: string | null;
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
  if (input.providerSessionId !== undefined)
    set.providerSessionId = input.providerSessionId;
  await db
    .update(workspaceAgentSessions)
    .set(set)
    .where(eq(workspaceAgentSessions.id, id));
  return getAgentSession(db, organizationId, id);
}

export interface AgentActivityInput {
  sessionId: string;
  actorId?: string;
  type:
    | "thought"
    | "response"
    | "error"
    | "elicitation"
    | "action"
    | "status"
    | "artifact";
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

export interface AgentSessionEventInput {
  sessionId: string;
  type: string;
  message: string;
  payload?: Record<string, unknown>;
}

export async function addAgentSessionEvent(
  db: WorkspaceDb,
  input: AgentSessionEventInput
) {
  const ts = new Date().toISOString();
  await db.insert(workspaceAgentSessionEvents).values({
    sessionId: input.sessionId,
    type: input.type,
    message: input.message,
    payload: input.payload ? JSON.stringify(input.payload) : null,
    createdAt: ts,
  });
  const row = await db
    .select()
    .from(workspaceAgentSessionEvents)
    .where(
      and(
        eq(workspaceAgentSessionEvents.sessionId, input.sessionId),
        eq(workspaceAgentSessionEvents.createdAt, ts)
      )
    )
    .orderBy(desc(workspaceAgentSessionEvents.id))
    .limit(1)
    .get();
  if (!row) {
    throw new Error("Failed to create agent session event");
  }
  return row;
}

export function listAgentSessionEvents(
  db: WorkspaceDb,
  sessionId: string,
  options: { afterId?: number; limit?: number } = {}
) {
  const conditions = [eq(workspaceAgentSessionEvents.sessionId, sessionId)];
  if (options.afterId !== undefined) {
    conditions.push(gt(workspaceAgentSessionEvents.id, options.afterId));
  }
  return db
    .select()
    .from(workspaceAgentSessionEvents)
    .where(and(...conditions))
    .orderBy(workspaceAgentSessionEvents.id)
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
  teamIds?: string | string[] | null;
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
    teamIds:
      input.teamIds === undefined
        ? undefined
        : input.teamIds === null
          ? null
          : typeof input.teamIds === "string"
            ? input.teamIds
            : JSON.stringify(input.teamIds),
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
    teamIds: fields.teamIds ?? null,
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

// ---- documents ----

export interface DocumentInput {
  organizationId: string;
  title: string;
  icon?: string | null;
  content?: unknown[] | string; // BlockNote blocks or markdown
  contentFormat?: "blocks" | "markdown";
  slug?: string | null;
  projectId?: string | null;
  issueId?: string | null;
  initiativeId?: string | null;
  parentDocumentId?: string | null;
  spaceId?: string | null;
  isTemplate?: boolean;
  createdById: string;
}

export function createDocument(db: WorkspaceDb, input: DocumentInput) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const content =
    typeof input.content === "string"
      ? input.content
      : JSON.stringify(input.content ?? []);
  const contentFormat =
    input.contentFormat ??
    (typeof input.content === "string" ? "markdown" : "blocks");
  const doc = db
    .insert(workspaceDocuments)
    .values({
      id,
      organizationId: input.organizationId,
      title: input.title,
      icon: input.icon ?? null,
      contentFormat,
      content,
      slug: input.slug ?? null,
      projectId: input.projectId ?? null,
      issueId: input.issueId ?? null,
      initiativeId: input.initiativeId ?? null,
      parentDocumentId: input.parentDocumentId ?? null,
      spaceId: input.spaceId ?? null,
      isTemplate: input.isTemplate ?? false,
      createdById: input.createdById,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  db.insert(workspaceDocumentHistory)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      documentId: id,
      content,
      contentFormat,
      actorId: input.createdById,
      createdAt: now,
    })
    .run();
  return doc;
}

export interface ListDocumentsArgs {
  projectId?: string;
  issueId?: string;
  initiativeId?: string;
  parentDocumentId?: string | null;
  spaceId?: string;
  isTemplate?: boolean;
  slug?: string;
  includeTrashed?: boolean;
}

export function listDocuments(
  db: WorkspaceDb,
  organizationId: string,
  args: ListDocumentsArgs = {}
) {
  const conditions = [eq(workspaceDocuments.organizationId, organizationId)];
  if (!args.includeTrashed) {
    conditions.push(isNull(workspaceDocuments.trashedAt));
  }
  if (args.projectId !== undefined) {
    conditions.push(eq(workspaceDocuments.projectId, args.projectId));
  }
  if (args.issueId !== undefined) {
    conditions.push(eq(workspaceDocuments.issueId, args.issueId));
  }
  if (args.initiativeId !== undefined) {
    conditions.push(eq(workspaceDocuments.initiativeId, args.initiativeId));
  }
  if (args.parentDocumentId !== undefined) {
    conditions.push(
      args.parentDocumentId === null
        ? isNull(workspaceDocuments.parentDocumentId)
        : eq(workspaceDocuments.parentDocumentId, args.parentDocumentId)
    );
  }
  if (args.spaceId !== undefined) {
    conditions.push(eq(workspaceDocuments.spaceId, args.spaceId));
  }
  if (args.isTemplate !== undefined) {
    conditions.push(eq(workspaceDocuments.isTemplate, args.isTemplate));
  }
  if (args.slug !== undefined) {
    conditions.push(eq(workspaceDocuments.slug, args.slug));
  }
  return db
    .select()
    .from(workspaceDocuments)
    .where(and(...conditions))
    .all();
}

export function getDocument(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceDocuments)
    .where(
      and(
        eq(workspaceDocuments.id, id),
        eq(workspaceDocuments.organizationId, organizationId)
      )
    )
    .get();
}

export interface DocumentUpdate {
  title?: string;
  icon?: string | null;
  content?: unknown[] | string;
  contentFormat?: "blocks" | "markdown";
  slug?: string | null;
  projectId?: string | null;
  issueId?: string | null;
  initiativeId?: string | null;
  parentDocumentId?: string | null;
  spaceId?: string | null;
  isTemplate?: boolean;
  trashedAt?: string | null;
}

export function updateDocument(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  update: DocumentUpdate,
  actorId: string
) {
  const patch: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
    updatedById: actorId,
  };
  if (update.title !== undefined) patch.title = update.title;
  if (update.icon !== undefined) patch.icon = update.icon;
  if (update.projectId !== undefined) patch.projectId = update.projectId;
  if (update.issueId !== undefined) patch.issueId = update.issueId;
  if (update.initiativeId !== undefined)
    patch.initiativeId = update.initiativeId;
  if (update.parentDocumentId !== undefined)
    patch.parentDocumentId = update.parentDocumentId;
  if (update.spaceId !== undefined) patch.spaceId = update.spaceId;
  if (update.isTemplate !== undefined) patch.isTemplate = update.isTemplate;
  if (update.slug !== undefined) patch.slug = update.slug;
  if (update.contentFormat !== undefined)
    patch.contentFormat = update.contentFormat;
  if (update.trashedAt !== undefined) patch.trashedAt = update.trashedAt;
  if (update.content !== undefined) {
    const content =
      typeof update.content === "string"
        ? update.content
        : JSON.stringify(update.content);
    const resolvedFormat: "blocks" | "markdown" =
      update.contentFormat ??
      (typeof update.content === "string" ? "markdown" : "blocks");
    patch.contentFormat = resolvedFormat;
    patch.content = content;
    db.insert(workspaceDocumentHistory)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        documentId: id,
        content,
        contentFormat: resolvedFormat,
        actorId,
        createdAt: new Date().toISOString(),
      })
      .run();
  }
  return db
    .update(workspaceDocuments)
    .set(patch)
    .where(
      and(
        eq(workspaceDocuments.id, id),
        eq(workspaceDocuments.organizationId, organizationId)
      )
    )
    .returning()
    .get();
}

export function deleteDocument(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  db.delete(workspaceDocumentHistory)
    .where(
      and(
        eq(workspaceDocumentHistory.documentId, id),
        eq(workspaceDocumentHistory.organizationId, organizationId)
      )
    )
    .run();
  return (
    db
      .delete(workspaceDocuments)
      .where(
        and(
          eq(workspaceDocuments.id, id),
          eq(workspaceDocuments.organizationId, organizationId)
        )
      )
      .returning()
      .all().length > 0
  );
}

export function getDocumentHistoryEntry(
  db: WorkspaceDb,
  organizationId: string,
  documentId: string,
  entryId: string
) {
  return db
    .select()
    .from(workspaceDocumentHistory)
    .where(
      and(
        eq(workspaceDocumentHistory.id, entryId),
        eq(workspaceDocumentHistory.documentId, documentId),
        eq(workspaceDocumentHistory.organizationId, organizationId)
      )
    )
    .get();
}

export function listDocumentHistory(
  db: WorkspaceDb,
  organizationId: string,
  documentId: string
) {
  return db
    .select()
    .from(workspaceDocumentHistory)
    .where(
      and(
        eq(workspaceDocumentHistory.documentId, documentId),
        eq(workspaceDocumentHistory.organizationId, organizationId)
      )
    )
    .orderBy(desc(workspaceDocumentHistory.createdAt))
    .all();
}

// ---- audit log ----

export interface AuditEntryInput {
  organizationId: string;
  actorId?: string | null;
  actorType?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  changes?: Record<string, { from: unknown; to: unknown }> | null;
}

export function recordAuditEntry(db: WorkspaceDb, input: AuditEntryInput) {
  return db
    .insert(workspaceAuditLog)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      actorId: input.actorId ?? null,
      actorType: input.actorType ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      changes: input.changes ? JSON.stringify(input.changes) : null,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export function listAuditLog(
  db: WorkspaceDb,
  organizationId: string,
  args: {
    entityType?: string;
    entityId?: string;
    action?: string;
    actorId?: string;
    limit?: number;
  } = {}
) {
  const conditions = [eq(workspaceAuditLog.organizationId, organizationId)];
  if (args.entityType !== undefined) {
    conditions.push(eq(workspaceAuditLog.entityType, args.entityType));
  }
  if (args.entityId !== undefined) {
    conditions.push(eq(workspaceAuditLog.entityId, args.entityId));
  }
  if (args.action !== undefined) {
    conditions.push(eq(workspaceAuditLog.action, args.action));
  }
  if (args.actorId !== undefined) {
    conditions.push(eq(workspaceAuditLog.actorId, args.actorId));
  }
  return db
    .select()
    .from(workspaceAuditLog)
    .where(and(...conditions))
    .orderBy(desc(workspaceAuditLog.createdAt))
    .limit(args.limit ?? 200)
    .all();
}

export function getAuditLogEntry(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceAuditLog)
    .where(
      and(
        eq(workspaceAuditLog.organizationId, organizationId),
        eq(workspaceAuditLog.id, id)
      )
    )
    .get();
}

// ---- notification preferences ----

export interface NotificationPreferenceInput {
  inApp?: boolean;
  webhook?: boolean;
  email?: boolean;
  mutedTypes?: string[] | null;
}

export function getNotificationPreferences(
  db: WorkspaceDb,
  organizationId: string,
  userId: string
) {
  return db
    .select()
    .from(workspaceNotificationPreferences)
    .where(
      and(
        eq(workspaceNotificationPreferences.organizationId, organizationId),
        eq(workspaceNotificationPreferences.userId, userId)
      )
    )
    .get();
}

export function upsertNotificationPreferences(
  db: WorkspaceDb,
  organizationId: string,
  userId: string,
  input: NotificationPreferenceInput
) {
  const now = new Date().toISOString();
  const existing = getNotificationPreferences(db, organizationId, userId);
  const mutedTypes =
    input.mutedTypes !== undefined
      ? input.mutedTypes
        ? input.mutedTypes.join(",")
        : null
      : (existing?.mutedTypes ?? null);
  const values = {
    inApp: input.inApp ?? existing?.inApp ?? true,
    webhook: input.webhook ?? existing?.webhook ?? true,
    email: input.email ?? existing?.email ?? false,
    mutedTypes,
    updatedAt: now,
  };
  if (existing) {
    db.update(workspaceNotificationPreferences)
      .set(values)
      .where(
        and(
          eq(workspaceNotificationPreferences.organizationId, organizationId),
          eq(workspaceNotificationPreferences.userId, userId)
        )
      )
      .run();
    return { organizationId, userId, ...values };
  }
  db.insert(workspaceNotificationPreferences)
    .values({ organizationId, userId, ...values })
    .run();
  return { organizationId, userId, ...values };
}

// ---- customers ----

export interface CustomerInput {
  organizationId: string;
  name: string;
  url?: string | null;
  logoUrl?: string | null;
  externalId?: string | null;
  tierId?: string | null;
  statusId?: string | null;
  ownerId?: string | null;
}

export function createCustomer(db: WorkspaceDb, input: CustomerInput) {
  const now = new Date().toISOString();
  return db
    .insert(workspaceCustomers)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      name: input.name,
      url: input.url ?? null,
      logoUrl: input.logoUrl ?? null,
      externalId: input.externalId ?? null,
      tierId: input.tierId ?? null,
      statusId: input.statusId ?? null,
      ownerId: input.ownerId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function listCustomers(db: WorkspaceDb, organizationId: string) {
  return db
    .select()
    .from(workspaceCustomers)
    .where(eq(workspaceCustomers.organizationId, organizationId))
    .all();
}

export function getCustomer(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceCustomers)
    .where(
      and(
        eq(workspaceCustomers.id, id),
        eq(workspaceCustomers.organizationId, organizationId)
      )
    )
    .get();
}

export function updateCustomer(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  patch: Partial<Omit<CustomerInput, "organizationId">>
) {
  const updates: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };
  for (const key of [
    "name",
    "url",
    "logoUrl",
    "externalId",
    "tierId",
    "statusId",
    "ownerId",
  ] as const) {
    if (patch[key] !== undefined) updates[key] = patch[key];
  }
  return db
    .update(workspaceCustomers)
    .set(updates)
    .where(
      and(
        eq(workspaceCustomers.id, id),
        eq(workspaceCustomers.organizationId, organizationId)
      )
    )
    .returning()
    .get();
}

export function deleteCustomer(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  db.delete(workspaceCustomerNeeds)
    .where(
      and(
        eq(workspaceCustomerNeeds.customerId, id),
        eq(workspaceCustomerNeeds.organizationId, organizationId)
      )
    )
    .run();
  return (
    db
      .delete(workspaceCustomers)
      .where(
        and(
          eq(workspaceCustomers.id, id),
          eq(workspaceCustomers.organizationId, organizationId)
        )
      )
      .returning()
      .all().length > 0
  );
}

// ---- external links ----

export interface ExternalLinkInput {
  entityType: string;
  entityId: string;
  url: string;
  label?: string | null;
}

export function listExternalLinks(
  db: WorkspaceDb,
  organizationId: string,
  args: { entityType?: string; entityId?: string } = {}
) {
  const conditions = [eq(externalLinks.organizationId, organizationId)];
  if (args.entityType !== undefined)
    conditions.push(eq(externalLinks.entityType, args.entityType));
  if (args.entityId !== undefined)
    conditions.push(eq(externalLinks.entityId, args.entityId));
  return db
    .select()
    .from(externalLinks)
    .where(and(...conditions))
    .all();
}

export function getExternalLink(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(externalLinks)
    .where(
      and(
        eq(externalLinks.organizationId, organizationId),
        eq(externalLinks.id, id)
      )
    )
    .get();
}

export async function createExternalLink(
  db: WorkspaceDb,
  organizationId: string,
  input: ExternalLinkInput
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(externalLinks).values({
    id,
    organizationId,
    entityType: input.entityType,
    entityId: input.entityId,
    url: input.url,
    label: input.label ?? null,
    createdAt: ts,
  });
  return getExternalLink(db, organizationId, id);
}

export async function updateExternalLink(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  input: { url?: string; label?: string | null }
) {
  const existing = await getExternalLink(db, organizationId, id);
  if (!existing) return undefined;
  await db
    .update(externalLinks)
    .set({
      url: input.url ?? existing.url,
      label: input.label === undefined ? existing.label : input.label,
    })
    .where(
      and(
        eq(externalLinks.organizationId, organizationId),
        eq(externalLinks.id, id)
      )
    );
  return getExternalLink(db, organizationId, id);
}

export async function deleteExternalLink(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  const existing = await getExternalLink(db, organizationId, id);
  if (!existing) return false;
  await db
    .delete(externalLinks)
    .where(
      and(
        eq(externalLinks.organizationId, organizationId),
        eq(externalLinks.id, id)
      )
    );
  return true;
}

// ---- time schedules ----

export interface TimeScheduleInput {
  name: string;
  timeData?: string | null;
}

export function listTimeSchedules(db: WorkspaceDb, organizationId: string) {
  return db
    .select()
    .from(timeSchedules)
    .where(eq(timeSchedules.organizationId, organizationId))
    .orderBy(timeSchedules.createdAt)
    .all();
}

export function getTimeSchedule(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(timeSchedules)
    .where(
      and(
        eq(timeSchedules.organizationId, organizationId),
        eq(timeSchedules.id, id)
      )
    )
    .get();
}

export async function createTimeSchedule(
  db: WorkspaceDb,
  organizationId: string,
  input: TimeScheduleInput
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(timeSchedules).values({
    id,
    organizationId,
    name: input.name,
    timeData: input.timeData ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return getTimeSchedule(db, organizationId, id);
}

export async function updateTimeSchedule(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  input: Partial<TimeScheduleInput>
) {
  const existing = await getTimeSchedule(db, organizationId, id);
  if (!existing) return undefined;
  const ts = new Date().toISOString();
  await db
    .update(timeSchedules)
    .set({
      name: input.name ?? existing.name,
      timeData:
        input.timeData === undefined ? existing.timeData : input.timeData,
      updatedAt: ts,
    })
    .where(
      and(
        eq(timeSchedules.organizationId, organizationId),
        eq(timeSchedules.id, id)
      )
    );
  return getTimeSchedule(db, organizationId, id);
}

export async function deleteTimeSchedule(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  const existing = await getTimeSchedule(db, organizationId, id);
  if (!existing) return false;
  await db
    .delete(timeSchedules)
    .where(
      and(
        eq(timeSchedules.organizationId, organizationId),
        eq(timeSchedules.id, id)
      )
    );
  return true;
}

// ---- git automation ----

export interface GitAutomationStateInput {
  stateId: string;
  prState: string;
}

export function listGitAutomationStates(
  db: WorkspaceDb,
  organizationId: string
) {
  return db
    .select()
    .from(gitAutomationStates)
    .where(eq(gitAutomationStates.organizationId, organizationId))
    .all();
}

export function getGitAutomationState(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(gitAutomationStates)
    .where(
      and(
        eq(gitAutomationStates.organizationId, organizationId),
        eq(gitAutomationStates.id, id)
      )
    )
    .get();
}

export async function createGitAutomationState(
  db: WorkspaceDb,
  organizationId: string,
  input: GitAutomationStateInput
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(gitAutomationStates).values({
    id,
    organizationId,
    stateId: input.stateId,
    prState: input.prState,
    createdAt: ts,
  });
  return getGitAutomationState(db, organizationId, id);
}

export async function updateGitAutomationState(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  input: Partial<GitAutomationStateInput>
) {
  const existing = await getGitAutomationState(db, organizationId, id);
  if (!existing) return undefined;
  await db
    .update(gitAutomationStates)
    .set({
      stateId: input.stateId ?? existing.stateId,
      prState: input.prState ?? existing.prState,
    })
    .where(
      and(
        eq(gitAutomationStates.organizationId, organizationId),
        eq(gitAutomationStates.id, id)
      )
    );
  return getGitAutomationState(db, organizationId, id);
}

export async function deleteGitAutomationState(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  const existing = await getGitAutomationState(db, organizationId, id);
  if (!existing) return false;
  await db
    .delete(gitAutomationStates)
    .where(
      and(
        eq(gitAutomationStates.organizationId, organizationId),
        eq(gitAutomationStates.id, id)
      )
    );
  return true;
}

export interface GitAutomationTargetBranchInput {
  name: string;
  pattern?: string | null;
}

export function listGitAutomationTargetBranches(
  db: WorkspaceDb,
  organizationId: string
) {
  return db
    .select()
    .from(gitAutomationTargetBranches)
    .where(eq(gitAutomationTargetBranches.organizationId, organizationId))
    .all();
}

export function getGitAutomationTargetBranch(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(gitAutomationTargetBranches)
    .where(
      and(
        eq(gitAutomationTargetBranches.organizationId, organizationId),
        eq(gitAutomationTargetBranches.id, id)
      )
    )
    .get();
}

export async function createGitAutomationTargetBranch(
  db: WorkspaceDb,
  organizationId: string,
  input: GitAutomationTargetBranchInput
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(gitAutomationTargetBranches).values({
    id,
    organizationId,
    name: input.name,
    pattern: input.pattern ?? null,
    createdAt: ts,
  });
  return getGitAutomationTargetBranch(db, organizationId, id);
}

export async function updateGitAutomationTargetBranch(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  input: Partial<GitAutomationTargetBranchInput>
) {
  const existing = await getGitAutomationTargetBranch(db, organizationId, id);
  if (!existing) return undefined;
  await db
    .update(gitAutomationTargetBranches)
    .set({
      name: input.name ?? existing.name,
      pattern: input.pattern === undefined ? existing.pattern : input.pattern,
    })
    .where(
      and(
        eq(gitAutomationTargetBranches.organizationId, organizationId),
        eq(gitAutomationTargetBranches.id, id)
      )
    );
  return getGitAutomationTargetBranch(db, organizationId, id);
}

export async function deleteGitAutomationTargetBranch(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  const existing = await getGitAutomationTargetBranch(db, organizationId, id);
  if (!existing) return false;
  await db
    .delete(gitAutomationTargetBranches)
    .where(
      and(
        eq(gitAutomationTargetBranches.organizationId, organizationId),
        eq(gitAutomationTargetBranches.id, id)
      )
    );
  return true;
}

// ---- customer tiers / statuses ----

export function createCustomerTier(
  db: WorkspaceDb,
  organizationId: string,
  input: { name: string; color?: string | null; position?: number }
) {
  return db
    .insert(workspaceCustomerTiers)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      name: input.name,
      color: input.color ?? null,
      position: input.position ?? 0,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export function listCustomerTiers(db: WorkspaceDb, organizationId: string) {
  return db
    .select()
    .from(workspaceCustomerTiers)
    .where(eq(workspaceCustomerTiers.organizationId, organizationId))
    .all();
}

export function getCustomerTier(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceCustomerTiers)
    .where(
      and(
        eq(workspaceCustomerTiers.id, id),
        eq(workspaceCustomerTiers.organizationId, organizationId)
      )
    )
    .get();
}

export function updateCustomerTier(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  input: { name?: string; color?: string | null; position?: number }
) {
  return db
    .update(workspaceCustomerTiers)
    .set({
      name: input.name,
      color: input.color,
      position: input.position,
    })
    .where(
      and(
        eq(workspaceCustomerTiers.id, id),
        eq(workspaceCustomerTiers.organizationId, organizationId)
      )
    )
    .returning()
    .get();
}

export function deleteCustomerTier(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return (
    db
      .delete(workspaceCustomerTiers)
      .where(
        and(
          eq(workspaceCustomerTiers.id, id),
          eq(workspaceCustomerTiers.organizationId, organizationId)
        )
      )
      .returning()
      .all().length > 0
  );
}

export function createCustomerStatus(
  db: WorkspaceDb,
  organizationId: string,
  input: { name: string; color?: string | null; position?: number }
) {
  return db
    .insert(workspaceCustomerStatuses)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      name: input.name,
      color: input.color ?? null,
      position: input.position ?? 0,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export function listCustomerStatuses(db: WorkspaceDb, organizationId: string) {
  return db
    .select()
    .from(workspaceCustomerStatuses)
    .where(eq(workspaceCustomerStatuses.organizationId, organizationId))
    .all();
}

export function getCustomerStatus(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceCustomerStatuses)
    .where(
      and(
        eq(workspaceCustomerStatuses.id, id),
        eq(workspaceCustomerStatuses.organizationId, organizationId)
      )
    )
    .get();
}

export function updateCustomerStatus(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  input: { name?: string; color?: string | null; position?: number }
) {
  return db
    .update(workspaceCustomerStatuses)
    .set({
      name: input.name,
      color: input.color,
      position: input.position,
    })
    .where(
      and(
        eq(workspaceCustomerStatuses.id, id),
        eq(workspaceCustomerStatuses.organizationId, organizationId)
      )
    )
    .returning()
    .get();
}

export function deleteCustomerStatus(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return (
    db
      .delete(workspaceCustomerStatuses)
      .where(
        and(
          eq(workspaceCustomerStatuses.id, id),
          eq(workspaceCustomerStatuses.organizationId, organizationId)
        )
      )
      .returning()
      .all().length > 0
  );
}

// ---- customer needs ----

export interface CustomerNeedInput {
  customerId: string;
  issueId?: string | null;
  projectId?: string | null;
  priority?: string | null;
  note?: string | null;
}

export interface CustomerNeedUpdateInput {
  customerId?: string;
  issueId?: string | null;
  projectId?: string | null;
  priority?: string | null;
  note?: string | null;
}

export function createCustomerNeed(
  db: WorkspaceDb,
  organizationId: string,
  input: CustomerNeedInput
) {
  return db
    .insert(workspaceCustomerNeeds)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      customerId: input.customerId,
      issueId: input.issueId ?? null,
      projectId: input.projectId ?? null,
      priority: input.priority ?? null,
      note: input.note ?? null,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export function listCustomerNeeds(
  db: WorkspaceDb,
  organizationId: string,
  args: { customerId?: string; issueId?: string; projectId?: string } = {}
) {
  const conditions = [
    eq(workspaceCustomerNeeds.organizationId, organizationId),
  ];
  if (args.customerId !== undefined)
    conditions.push(eq(workspaceCustomerNeeds.customerId, args.customerId));
  if (args.issueId !== undefined)
    conditions.push(eq(workspaceCustomerNeeds.issueId, args.issueId));
  if (args.projectId !== undefined)
    conditions.push(eq(workspaceCustomerNeeds.projectId, args.projectId));
  return db
    .select()
    .from(workspaceCustomerNeeds)
    .where(and(...conditions))
    .all();
}

export function getCustomerNeed(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceCustomerNeeds)
    .where(
      and(
        eq(workspaceCustomerNeeds.id, id),
        eq(workspaceCustomerNeeds.organizationId, organizationId)
      )
    )
    .get();
}

export function updateCustomerNeed(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  input: CustomerNeedUpdateInput
) {
  return db
    .update(workspaceCustomerNeeds)
    .set({
      customerId: input.customerId,
      issueId: input.issueId,
      projectId: input.projectId,
      priority: input.priority,
      note: input.note,
    })
    .where(
      and(
        eq(workspaceCustomerNeeds.id, id),
        eq(workspaceCustomerNeeds.organizationId, organizationId)
      )
    )
    .returning()
    .get();
}

export function deleteCustomerNeed(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return (
    db
      .delete(workspaceCustomerNeeds)
      .where(
        and(
          eq(workspaceCustomerNeeds.id, id),
          eq(workspaceCustomerNeeds.organizationId, organizationId)
        )
      )
      .returning()
      .all().length > 0
  );
}

// ---- release pipelines / releases ----

export function createReleasePipeline(
  db: WorkspaceDb,
  organizationId: string,
  input: { name: string; stages?: string[] }
) {
  return db
    .insert(workspaceReleasePipelines)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      name: input.name,
      stages: JSON.stringify(input.stages ?? []),
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export function listReleasePipelines(db: WorkspaceDb, organizationId: string) {
  return db
    .select()
    .from(workspaceReleasePipelines)
    .where(eq(workspaceReleasePipelines.organizationId, organizationId))
    .all();
}

export function deleteReleasePipeline(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return (
    db
      .delete(workspaceReleasePipelines)
      .where(
        and(
          eq(workspaceReleasePipelines.id, id),
          eq(workspaceReleasePipelines.organizationId, organizationId)
        )
      )
      .returning()
      .all().length > 0
  );
}

export interface ReleaseInput {
  organizationId: string;
  name: string;
  version?: string | null;
  projectId?: string | null;
  pipelineId?: string | null;
  stage?: string | null;
  status?: string;
  targetDate?: string | null;
  createdById?: string | null;
}

export function createRelease(db: WorkspaceDb, input: ReleaseInput) {
  const now = new Date().toISOString();
  return db
    .insert(workspaceReleases)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      name: input.name,
      version: input.version ?? null,
      projectId: input.projectId ?? null,
      pipelineId: input.pipelineId ?? null,
      stage: input.stage ?? null,
      status: input.status ?? "planned",
      targetDate: input.targetDate ?? null,
      createdById: input.createdById ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function listReleases(
  db: WorkspaceDb,
  organizationId: string,
  args: { projectId?: string } = {}
) {
  const conditions = [eq(workspaceReleases.organizationId, organizationId)];
  if (args.projectId !== undefined)
    conditions.push(eq(workspaceReleases.projectId, args.projectId));
  return db
    .select()
    .from(workspaceReleases)
    .where(and(...conditions))
    .all();
}

export function getRelease(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceReleases)
    .where(
      and(
        eq(workspaceReleases.id, id),
        eq(workspaceReleases.organizationId, organizationId)
      )
    )
    .get();
}

export function updateRelease(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  patch: Partial<Omit<ReleaseInput, "organizationId">>
) {
  const updates: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };
  for (const key of [
    "name",
    "version",
    "projectId",
    "pipelineId",
    "stage",
    "status",
    "targetDate",
  ] as const) {
    if (patch[key] !== undefined) updates[key] = patch[key];
  }
  return db
    .update(workspaceReleases)
    .set(updates)
    .where(
      and(
        eq(workspaceReleases.id, id),
        eq(workspaceReleases.organizationId, organizationId)
      )
    )
    .returning()
    .get();
}

export function deleteRelease(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return (
    db
      .delete(workspaceReleases)
      .where(
        and(
          eq(workspaceReleases.id, id),
          eq(workspaceReleases.organizationId, organizationId)
        )
      )
      .returning()
      .all().length > 0
  );
}

// ---- document spaces / shares / watchers ----

export function createDocumentSpace(
  db: WorkspaceDb,
  organizationId: string,
  input: {
    name: string;
    description?: string | null;
    icon?: string | null;
    publicSharing?: boolean;
    createdById: string;
  }
) {
  return db
    .insert(workspaceDocumentSpaces)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      name: input.name,
      description: input.description ?? null,
      icon: input.icon ?? null,
      publicSharing: input.publicSharing ?? true,
      createdById: input.createdById,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export function listDocumentSpaces(db: WorkspaceDb, organizationId: string) {
  return db
    .select()
    .from(workspaceDocumentSpaces)
    .where(eq(workspaceDocumentSpaces.organizationId, organizationId))
    .all();
}

export function getDocumentSpace(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceDocumentSpaces)
    .where(
      and(
        eq(workspaceDocumentSpaces.id, id),
        eq(workspaceDocumentSpaces.organizationId, organizationId)
      )
    )
    .get();
}

export function updateDocumentSpace(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    icon?: string | null;
    publicSharing?: boolean;
  }
) {
  const updates: Record<string, unknown> = {};
  for (const key of ["name", "description", "icon", "publicSharing"] as const) {
    if (patch[key] !== undefined) updates[key] = patch[key];
  }
  return db
    .update(workspaceDocumentSpaces)
    .set(updates)
    .where(
      and(
        eq(workspaceDocumentSpaces.id, id),
        eq(workspaceDocumentSpaces.organizationId, organizationId)
      )
    )
    .returning()
    .get();
}

export function deleteDocumentSpace(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  db.update(workspaceDocuments)
    .set({ spaceId: null })
    .where(
      and(
        eq(workspaceDocuments.spaceId, id),
        eq(workspaceDocuments.organizationId, organizationId)
      )
    )
    .run();
  return (
    db
      .delete(workspaceDocumentSpaces)
      .where(
        and(
          eq(workspaceDocumentSpaces.id, id),
          eq(workspaceDocumentSpaces.organizationId, organizationId)
        )
      )
      .returning()
      .all().length > 0
  );
}

export function createDocumentShare(
  db: WorkspaceDb,
  organizationId: string,
  input: {
    documentId: string;
    includeChildren?: boolean;
    createdById: string;
    expiresAt?: string | null;
  }
) {
  return db
    .insert(workspaceDocumentShares)
    .values({
      token: crypto.randomUUID().replace(/-/g, ""),
      organizationId,
      documentId: input.documentId,
      includeChildren: input.includeChildren ?? false,
      createdById: input.createdById,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt ?? null,
    })
    .returning()
    .get();
}

export function getDocumentShare(
  db: WorkspaceDb,
  organizationId: string,
  documentId: string
) {
  return db
    .select()
    .from(workspaceDocumentShares)
    .where(
      and(
        eq(workspaceDocumentShares.documentId, documentId),
        eq(workspaceDocumentShares.organizationId, organizationId)
      )
    )
    .get();
}

export function getDocumentShareByToken(db: WorkspaceDb, token: string) {
  return db
    .select()
    .from(workspaceDocumentShares)
    .where(eq(workspaceDocumentShares.token, token))
    .get();
}

export function deleteDocumentShare(
  db: WorkspaceDb,
  organizationId: string,
  token: string
) {
  return (
    db
      .delete(workspaceDocumentShares)
      .where(
        and(
          eq(workspaceDocumentShares.token, token),
          eq(workspaceDocumentShares.organizationId, organizationId)
        )
      )
      .returning()
      .all().length > 0
  );
}

export function watchDocument(
  db: WorkspaceDb,
  organizationId: string,
  documentId: string,
  userId: string
) {
  const existing = db
    .select()
    .from(workspaceDocumentWatchers)
    .where(
      and(
        eq(workspaceDocumentWatchers.documentId, documentId),
        eq(workspaceDocumentWatchers.userId, userId)
      )
    )
    .get();
  if (existing) return existing;
  return db
    .insert(workspaceDocumentWatchers)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      documentId,
      userId,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export function unwatchDocument(
  db: WorkspaceDb,
  documentId: string,
  userId: string
) {
  return (
    db
      .delete(workspaceDocumentWatchers)
      .where(
        and(
          eq(workspaceDocumentWatchers.documentId, documentId),
          eq(workspaceDocumentWatchers.userId, userId)
        )
      )
      .returning()
      .all().length > 0
  );
}

export function listDocumentWatchers(
  db: WorkspaceDb,
  documentId: string
): string[] {
  return db
    .select({ userId: workspaceDocumentWatchers.userId })
    .from(workspaceDocumentWatchers)
    .where(eq(workspaceDocumentWatchers.documentId, documentId))
    .all()
    .map((row) => row.userId);
}

// ---- document permissions & links ----

export function setDocumentPermission(
  db: WorkspaceDb,
  organizationId: string,
  documentId: string,
  actorId: string,
  actorType: string,
  level: "view" | "edit"
) {
  const existing = db
    .select()
    .from(workspaceDocumentPermissions)
    .where(
      and(
        eq(workspaceDocumentPermissions.documentId, documentId),
        eq(workspaceDocumentPermissions.actorId, actorId)
      )
    )
    .get();
  if (existing) {
    db.update(workspaceDocumentPermissions)
      .set({ level })
      .where(eq(workspaceDocumentPermissions.id, existing.id))
      .run();
    return { ...existing, level };
  }
  return db
    .insert(workspaceDocumentPermissions)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      documentId,
      actorId,
      actorType,
      level,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export function revokeDocumentPermission(
  db: WorkspaceDb,
  documentId: string,
  actorId: string
) {
  return (
    db
      .delete(workspaceDocumentPermissions)
      .where(
        and(
          eq(workspaceDocumentPermissions.documentId, documentId),
          eq(workspaceDocumentPermissions.actorId, actorId)
        )
      )
      .returning()
      .all().length > 0
  );
}

export function listDocumentPermissions(db: WorkspaceDb, documentId: string) {
  return db
    .select()
    .from(workspaceDocumentPermissions)
    .where(eq(workspaceDocumentPermissions.documentId, documentId))
    .all();
}

// Returns the effective level for an actor, or null when the doc is
// restricted and the actor is unlisted. Team grants (Better Auth
// organization teams) cover every member of the team.
export function documentAccessLevel(
  db: WorkspaceDb,
  documentId: string,
  actorId: string,
  teamIds: string[] = []
): "view" | "edit" | null {
  const grants = listDocumentPermissions(db, documentId);
  if (grants.length === 0) return "edit";
  let level: "view" | "edit" | null = null;
  for (const grant of grants) {
    const covered =
      grant.actorId === actorId ||
      (grant.actorType === "team" && teamIds.includes(grant.actorId));
    if (covered && (level === null || grant.level === "edit")) {
      level = grant.level;
    }
  }
  return level;
}

export function replaceDocumentLinks(
  db: WorkspaceDb,
  organizationId: string,
  documentId: string,
  links: Array<{ targetType: string; targetId: string }>
) {
  db.delete(workspaceDocumentLinks)
    .where(eq(workspaceDocumentLinks.documentId, documentId))
    .run();
  if (links.length === 0) return;
  db.insert(workspaceDocumentLinks)
    .values(
      links.map((link) => ({
        id: crypto.randomUUID(),
        organizationId,
        documentId,
        targetType: link.targetType,
        targetId: link.targetId,
        createdAt: new Date().toISOString(),
      }))
    )
    .run();
}

export function listDocumentLinks(
  db: WorkspaceDb,
  organizationId: string,
  args: { documentId?: string; targetType?: string; targetId?: string } = {}
) {
  const conditions = [
    eq(workspaceDocumentLinks.organizationId, organizationId),
  ];
  if (args.documentId !== undefined)
    conditions.push(eq(workspaceDocumentLinks.documentId, args.documentId));
  if (args.targetType !== undefined)
    conditions.push(eq(workspaceDocumentLinks.targetType, args.targetType));
  if (args.targetId !== undefined)
    conditions.push(eq(workspaceDocumentLinks.targetId, args.targetId));
  return db
    .select()
    .from(workspaceDocumentLinks)
    .where(and(...conditions))
    .all();
}

export function shiftIssueCycle(
  db: WorkspaceDb,
  fromCycleId: string,
  toCycleId: string
) {
  const now = new Date().toISOString();
  const ids = db
    .select({ id: workspaceIssues.id })
    .from(workspaceIssues)
    .where(eq(workspaceIssues.cycleId, fromCycleId))
    .all()
    .map((row) => row.id);
  if (ids.length === 0) return 0;
  db.update(workspaceIssues)
    .set({ cycleId: toCycleId, updatedAt: now })
    .where(inArray(workspaceIssues.id, ids))
    .run();
  return ids.length;
}
