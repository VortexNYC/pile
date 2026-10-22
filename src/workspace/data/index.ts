// Workspace-local data layer. These functions run inside the workspace's
// Durable Object against its own SQLite — they replace the D1 modules for
// all per-workspace content (comments, history, subscribers, relations,
// approvals, reactions, attachments, notifications, saved views, agent
// sessions, webhook subs, linear users).
import {
  and,
  like,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";
import type { DrizzleSqliteDODatabase } from "drizzle-orm/durable-sqlite";

import type { AgentSessionStatus } from "../../types/workspace.js";
import type { FilterCondition } from "../filter.js";
import type { workspaceSchema } from "../schema-map.js";
import {
  workspaceAgentActivities,
  workspaceAgentAutomations,
  workspaceAgentTypes,
  workspaceDomainEvents,
  workspaceStageConfigs,
  workspaceAgentPauses,
  workspaceAgentRunReceipts,
  workspaceAgentSessionEvents,
  workspaceAgentSpendCaps,
  workspaceDocumentHistory,
  workspaceDocumentLinks,
  workspaceDocumentPermissions,
  workspaceSpacePermissions,
  workspaceDocuments,
  workspaceDocumentSpaces,
  workspaceEntityAttachments,
  workspaceEntityLinks,
  workspaceAgentProviderConfigs,
  workspaceMemory,
  workspaceLaneCosts,
  laneTokens,
  workspaceAgentSessions,
  workspaceAgentEnvironmentFiles,
  workspaceAttachments,
  workspaceAuditLog,
  workspaceCustomerIntakeItems,
  workspaceCustomerNeeds,
  workspaceCustomers,
  workspaceCustomerContacts,
  workspaceSuppression,
  workspaceMarketRuns,
  workspaceMerchantSources,
  workspaceDeals,
  workspaceFieldDefinitions,
  workspaceFieldValues,
  workspaceGuidancePacks,
  workspaceGuidancePackVersions,
  workspaceImportReceipts,
  workspaceStageTemplates,
  workspaceTriageRuleEvaluations,
  workspaceTriageRules,
  workspaceExternalEventDeliveries,
  workspaceExternalEventMappings,
  workspaceCustomerStatuses,
  workspaceCustomerTiers,
  workspaceIssueApprovals,
  workspaceIssuePermissions,
  workspaceShares,
  workspaceSubscriptions,
  workspaceIssues,
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
import { inArrayJson } from "../sql.js";

export type WorkspaceDb = DrizzleSqliteDODatabase<typeof workspaceSchema>;

// ---- issue_subscribers ----

function subscriptionAsIssueSubscriber(row: {
  id: string;
  organizationId: string;
  entityId: string;
  userId: string;
  createdAt: string;
}) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    issueId: row.entityId,
    linearUserId: row.userId,
    createdAt: row.createdAt,
  };
}

export function listIssueSubscribers(
  db: WorkspaceDb,
  organizationId: string,
  issueId: string
) {
  return db
    .select()
    .from(workspaceSubscriptions)
    .where(
      and(
        eq(workspaceSubscriptions.organizationId, organizationId),
        eq(workspaceSubscriptions.entityType, "issue"),
        eq(workspaceSubscriptions.entityId, issueId)
      )
    )
    .all()
    .map(subscriptionAsIssueSubscriber);
}

export function getIssueSubscriber(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  const row = db
    .select()
    .from(workspaceSubscriptions)
    .where(
      and(
        eq(workspaceSubscriptions.organizationId, organizationId),
        eq(workspaceSubscriptions.id, id)
      )
    )
    .get();
  return row ? subscriptionAsIssueSubscriber(row) : undefined;
}

export async function deleteIssueSubscriber(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  await db
    .delete(workspaceSubscriptions)
    .where(
      and(
        eq(workspaceSubscriptions.organizationId, organizationId),
        eq(workspaceSubscriptions.id, id)
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
    .from(workspaceSubscriptions)
    .where(
      and(
        eq(workspaceSubscriptions.organizationId, organizationId),
        eq(workspaceSubscriptions.entityType, "issue"),
        eq(workspaceSubscriptions.entityId, values.issueId),
        eq(workspaceSubscriptions.userId, values.linearUserId)
      )
    )
    .get();
  if (existing) return subscriptionAsIssueSubscriber(existing);
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(workspaceSubscriptions).values({
    id,
    organizationId,
    entityType: "issue",
    entityId: values.issueId,
    userId: values.linearUserId,
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
    .select({
      id: workspaceEntityLinks.id,
      organizationId: workspaceEntityLinks.organizationId,
      fromIssueId: workspaceEntityLinks.fromId,
      toIssueId: workspaceEntityLinks.toId,
      type: workspaceEntityLinks.kind,
      createdAt: workspaceEntityLinks.createdAt,
    })
    .from(workspaceEntityLinks)
    .where(
      and(
        eq(workspaceEntityLinks.organizationId, organizationId),
        eq(workspaceEntityLinks.fromType, "issue"),
        eq(workspaceEntityLinks.fromId, fromIssueId),
        eq(workspaceEntityLinks.toType, "issue")
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
    .select({
      id: workspaceEntityLinks.id,
      organizationId: workspaceEntityLinks.organizationId,
      fromIssueId: workspaceEntityLinks.fromId,
      toIssueId: workspaceEntityLinks.toId,
      type: workspaceEntityLinks.kind,
      createdAt: workspaceEntityLinks.createdAt,
    })
    .from(workspaceEntityLinks)
    .where(
      and(
        eq(workspaceEntityLinks.organizationId, organizationId),
        eq(workspaceEntityLinks.fromType, "issue"),
        eq(workspaceEntityLinks.toType, "issue"),
        eq(workspaceEntityLinks.toId, toIssueId)
      )
    )
    .all();
}

export function getIssueRelation(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  const row = db
    .select()
    .from(workspaceEntityLinks)
    .where(
      and(
        eq(workspaceEntityLinks.organizationId, organizationId),
        eq(workspaceEntityLinks.id, id)
      )
    )
    .get();
  if (!row) return undefined;
  return {
    id: row.id,
    organizationId: row.organizationId,
    fromIssueId: row.fromId,
    toIssueId: row.toId,
    type: row.kind,
    createdAt: row.createdAt,
  };
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
  await db.insert(workspaceEntityLinks).values({
    id,
    organizationId,
    fromType: "issue",
    fromId: values.fromIssueId,
    toType: "issue",
    toId: values.toIssueId,
    kind: values.type,
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
    .delete(workspaceEntityLinks)
    .where(
      and(
        eq(workspaceEntityLinks.organizationId, organizationId),
        eq(workspaceEntityLinks.id, id)
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

export async function setHiddenSurfaces(
  db: WorkspaceDb,
  organizationId: string,
  userId: string,
  hiddenSurfaces: string[] | null
) {
  const value = hiddenSurfaces ? JSON.stringify(hiddenSurfaces) : null;
  const existing = await getUserViewPreferences(db, organizationId, userId);
  const ts = new Date().toISOString();
  if (existing) {
    await db
      .update(workspaceUserPreferences)
      .set({ hiddenSurfaces: value, updatedAt: ts })
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
      hiddenSurfaces: value,
      updatedAt: ts,
    });
  }
  return getUserViewPreferences(db, organizationId, userId);
}

export interface EntityFavorite {
  type: "issue" | "document";
  id: string;
  title: string;
  identifier?: string | null;
  addedAt: string;
}

export async function setFavorites(
  db: WorkspaceDb,
  organizationId: string,
  userId: string,
  favorites: EntityFavorite[] | null
) {
  const value = favorites ? JSON.stringify(favorites) : null;
  const existing = await getUserViewPreferences(db, organizationId, userId);
  const ts = new Date().toISOString();
  if (existing) {
    await db
      .update(workspaceUserPreferences)
      .set({ favorites: value, updatedAt: ts })
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
      favorites: value,
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
  | "issue_assigned"
  | "issue_updated"
  | "issue_deleted"
  | "comment_created"
  | "document_updated"
  | "document_commented"
  | "mention"
  | "lane_needs_input"
  | "lane_elicitation_escalated"
  | "lane_stale"
  // PILE-428 — an agent write landed in draft_outputs on a sensitive
  // record and waits on a human publish/discard decision.
  | "draft_pending"
  // PILE-425 — an agent type breached its spend/token caps; the CoS alert
  // channel fires `agent.cap_exceeded` event automations alongside this.
  | "agent_cap_exceeded";

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
    // Restricted issues the recipient isn't granted — their events stay out
    // of the feed entirely (issue_permissions).
    excludeIssueCondition?: SQL;
  } = {}
) {
  const nowIso = new Date().toISOString();
  const conditions = [
    eq(workspaceNotifications.organizationId, organizationId),
    eq(workspaceNotifications.recipientId, recipientId),
    eq(workspaceNotifications.recipientType, recipientType),
  ];
  if (options.excludeIssueCondition) {
    conditions.push(options.excludeIssueCondition);
  }
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
  recipientType: RecipientType,
  excludeIssueCondition?: SQL
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
        ...(excludeIssueCondition ? [excludeIssueCondition] : []),
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
    | "stale"
    | "waiting"
    | "completed"
    | "failed"
    | "canceled";
  result?: string | null;
  url?: string | null;
  providerSessionId?: string | null;
  createdAt?: string;
  /** PILE-420 — 1 when this dispatch is held by an agent-type pause. */
  paused?: number;
  startedAt?: string | null;
  prUrl?: string | null;
  prState?: string | null;
  queuedAfter?: string | null;
  parentSessionId?: string | null;
  spawnDepth?: number;
  laneDbRef?: string | null;
  purpose?: string | null;
  secondaryRepos?: string | null;
  maxDurationMinutes?: number | null;
  effort?: "low" | "medium" | "high" | "max" | null;
  label?: string | null;
  resultSchema?: string | null;
  /** PILE-423 — pipeline sub-step this lane works; drives step-scoped
   *  guidance resolution on promote/retry. */
  stepKey?: string | null;
  /** PILE-423 — JSON [{id, name, scope, scopeKey, version}] of the guidance
   *  packs injected into this lane's dispatch prompt. */
  guidance?: string | null;
  /** Flue profile memory — resume key ({merchantId}-{agentSlug}). */
  conversationKey?: string | null;
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
    createdAt: input.createdAt ?? ts,
    paused: input.paused ?? 0,
    startedAt: input.startedAt ?? null,
    prUrl: input.prUrl ?? null,
    prState: input.prState ?? null,
    queuedAfter: input.queuedAfter ?? null,
    parentSessionId: input.parentSessionId ?? null,
    spawnDepth: input.spawnDepth ?? 0,
    laneDbRef: input.laneDbRef ?? null,
    purpose: input.purpose ?? null,
    secondaryRepos: input.secondaryRepos ?? null,
    maxDurationMinutes: input.maxDurationMinutes ?? null,
    effort: input.effort ?? null,
    label: input.label ?? null,
    resultSchema: input.resultSchema ?? null,
    stepKey: input.stepKey ?? null,
    guidance: input.guidance ?? null,
    conversationKey: input.conversationKey ?? null,
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

// ---- lane_tokens (PILE-457) ----
// The lane bearer is derived, not stored: sha256(org:session:seed:secret).
// The per-session seed lives in this table — never on the session row, so
// response spreads can't leak it — which makes rotation a real revocation:
// a new seed invalidates every token minted under the old one. Sessions
// created before the table existed have no row and verify against the
// legacy seedless derivation until they go terminal.

const TERMINAL_SESSION_STATUSES = new Set(["completed", "failed", "canceled"]);

export async function laneTokenSeed(
  db: WorkspaceDb,
  organizationId: string,
  sessionId: string
): Promise<string | null> {
  const row = await db
    .select({ seed: laneTokens.seed })
    .from(laneTokens)
    .where(
      and(
        eq(laneTokens.organizationId, organizationId),
        eq(laneTokens.sessionId, sessionId)
      )
    )
    .get();
  return row?.seed ?? null;
}

/** Seed for token minting: existing row wins, else mint for a live session. */
export async function ensureLaneTokenSeed(
  db: WorkspaceDb,
  organizationId: string,
  sessionId: string
): Promise<string | null> {
  const session = await getAgentSession(db, organizationId, sessionId);
  if (!session || TERMINAL_SESSION_STATUSES.has(session.status)) {
    return null;
  }
  const existing = await laneTokenSeed(db, organizationId, sessionId);
  if (existing) return existing;
  const seed = crypto.randomUUID().replaceAll("-", "");
  await db
    .insert(laneTokens)
    .values({
      sessionId,
      organizationId,
      seed,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing({ target: laneTokens.sessionId });
  return (await laneTokenSeed(db, organizationId, sessionId)) ?? seed;
}

/** Rotate the seed — every bearer minted for the session dies at once. */
export async function rotateLaneTokenSeed(
  db: WorkspaceDb,
  organizationId: string,
  sessionId: string
): Promise<string | null> {
  const session = await getAgentSession(db, organizationId, sessionId);
  if (!session) return null;
  const seed = crypto.randomUUID().replaceAll("-", "");
  await db
    .insert(laneTokens)
    .values({
      sessionId,
      organizationId,
      seed,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: laneTokens.sessionId,
      set: { seed, createdAt: new Date().toISOString() },
    });
  return seed;
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

export function getAgentSessionByProviderSessionId(
  db: WorkspaceDb,
  organizationId: string,
  providerSessionId: string
) {
  return db
    .select()
    .from(workspaceAgentSessions)
    .where(
      and(
        eq(workspaceAgentSessions.organizationId, organizationId),
        eq(workspaceAgentSessions.providerSessionId, providerSessionId)
      )
    )
    .get();
}

type ListAgentSessionsOptions = {
  issueId?: string;
  agentId?: string;
  agentSlug?: string;
  status?: AgentSessionStatus;
  openPr?: boolean;
  retryOf?: string;
  limit?: number;
  // Restricted issues the caller isn't granted (issue_permissions) —
  // session rows carry lane results that can embed issue content.
  excludeIssueCondition?: SQL;
};

function agentSessionListConditions(
  organizationId: string,
  options: ListAgentSessionsOptions
) {
  const conditions = [
    eq(workspaceAgentSessions.organizationId, organizationId),
  ];
  if (options.issueId) {
    conditions.push(eq(workspaceAgentSessions.issueId, options.issueId));
  }
  if (options.agentId) {
    conditions.push(eq(workspaceAgentSessions.agentId, options.agentId));
  }
  if (options.excludeIssueCondition) {
    conditions.push(options.excludeIssueCondition);
  }
  if (options.status) {
    conditions.push(eq(workspaceAgentSessions.status, options.status));
  }
  if (options.retryOf) {
    conditions.push(eq(workspaceAgentSessions.retryOf, options.retryOf));
  }
  // "Not known closed", not `= 'open'` (PILE-269): drafts, unreported
  // (null) and provider-cased states ("OPEN") still need the sweep to
  // reconcile them from GitHub — an exact match silently dropped them.
  if (options.openPr) {
    conditions.push(isNotNull(workspaceAgentSessions.prUrl));
    conditions.push(
      sql`lower(coalesce(${workspaceAgentSessions.prState}, 'open')) not in ('merged', 'closed')`
    );
  }
  return conditions;
}

export function getAgentSessionByConversationKey(
  db: WorkspaceDb,
  organizationId: string,
  conversationKey: string
) {
  return db
    .select()
    .from(workspaceAgentSessions)
    .where(
      and(
        eq(workspaceAgentSessions.organizationId, organizationId),
        eq(workspaceAgentSessions.conversationKey, conversationKey)
      )
    )
    .orderBy(desc(workspaceAgentSessions.createdAt))
    .get();
}

export function listAgentSessions(
  db: WorkspaceDb,
  organizationId: string,
  options: ListAgentSessionsOptions = {}
) {
  // agentSlug isn't a session column — resolve it to the agent type's id.
  let resolved = options;
  if (options.agentSlug && !options.agentId) {
    const type = db
      .select({ id: workspaceAgentTypes.id })
      .from(workspaceAgentTypes)
      .where(
        and(
          eq(workspaceAgentTypes.organizationId, organizationId),
          eq(workspaceAgentTypes.slug, options.agentSlug)
        )
      )
      .get();
    resolved = { ...options, agentId: type?.id ?? "__none__" };
  }
  return db
    .select()
    .from(workspaceAgentSessions)
    .where(and(...agentSessionListConditions(organizationId, resolved)))
    .orderBy(
      desc(workspaceAgentSessions.createdAt),
      desc(workspaceAgentSessions.id)
    )
    .limit(options.limit ?? 100)
    .all();
}

/** Timing of the agent's most recent completed lanes — the ETA baseline on
 *  lane progress comments (PILE-290). Preflight critiques are excluded. */
export function listRecentLaneTimings(
  db: WorkspaceDb,
  organizationId: string,
  agentId: string,
  limit = 20
) {
  return db
    .select({
      createdAt: workspaceAgentSessions.createdAt,
      startedAt: workspaceAgentSessions.startedAt,
      endedAt: workspaceAgentSessions.endedAt,
    })
    .from(workspaceAgentSessions)
    .where(
      and(
        eq(workspaceAgentSessions.organizationId, organizationId),
        eq(workspaceAgentSessions.agentId, agentId),
        eq(workspaceAgentSessions.status, "completed"),
        isNotNull(workspaceAgentSessions.endedAt),
        or(
          isNull(workspaceAgentSessions.purpose),
          ne(workspaceAgentSessions.purpose, "preflight")
        )
      )
    )
    .orderBy(desc(workspaceAgentSessions.endedAt))
    .limit(limit)
    .all();
}

// Lane-row scalars only (PILE-256): list consumers like the fleet TUI and
// dashboards poll this shape — `result`, `lastStateHash`, and the
// actor/retry/lane internals stay on the detail routes. `lastProgressAt` is
// projected so the API can still derive the `stalled` badge.
const agentSessionSummaryColumns = {
  id: workspaceAgentSessions.id,
  issueId: workspaceAgentSessions.issueId,
  agentId: workspaceAgentSessions.agentId,
  provider: workspaceAgentSessions.provider,
  status: workspaceAgentSessions.status,
  prUrl: workspaceAgentSessions.prUrl,
  prState: workspaceAgentSessions.prState,
  createdAt: workspaceAgentSessions.createdAt,
  startedAt: workspaceAgentSessions.startedAt,
  updatedAt: workspaceAgentSessions.updatedAt,
  endedAt: workspaceAgentSessions.endedAt,
  lastProgressAt: workspaceAgentSessions.lastProgressAt,
  label: workspaceAgentSessions.label,
  // PILE-419 — summary rows carry the open-elicitation marker so the
  // fleet/summary views can derive `needs_input` without activity blobs.
  awaitingActivityId: workspaceAgentSessions.awaitingActivityId,
  // PILE-418 — summary rows carry these so the list can flag lanes that
  // never produced a first activity (queued lanes are exempt).
  firstActivityAt: workspaceAgentSessions.firstActivityAt,
  queuedAfter: workspaceAgentSessions.queuedAfter,
};

export type AgentSessionSummary = Pick<
  typeof workspaceAgentSessions.$inferSelect,
  keyof typeof agentSessionSummaryColumns
>;

export function listAgentSessionSummaries(
  db: WorkspaceDb,
  organizationId: string,
  options: ListAgentSessionsOptions = {}
) {
  return db
    .select(agentSessionSummaryColumns)
    .from(workspaceAgentSessions)
    .where(and(...agentSessionListConditions(organizationId, options)))
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
      | "stale"
      | "waiting"
      | "completed"
      | "failed"
      | "canceled";
    result: string | null;
    url: string | null;
    providerSessionId: string | null;
    lastProgressAt: string | null;
    lastStateHash: string | null;
    /** PILE-418 — stamped on the first recorded activity; written once
     *  (subsequent writes are ignored so the original ack time wins). */
    firstActivityAt: string | null;
    retryOf: string | null;
    retryCount: number;
    /** Queue promotion rewinds createdAt — the provision/run clocks anchor
     *  here, and queue dwell must not count against them (PILE-260). */
    createdAt: string;
    startedAt: string | null;
    prUrl: string | null;
    prState: string | null;
    branch: string | null;
    queuedAfter: string | null;
    parentSessionId: string | null;
    spawnDepth: number;
    laneDbRef: string | null;
    endedAt: string | null;
    lastReviewedSha: string | null;
    reviewSummary: string | null;
    sandboxBackupRef: string | null;
    /** PILE-419 — open elicitation marker + escalation dedupe stamp. */
    awaitingActivityId: string | null;
    awaitingEscalatedAt: string | null;
    /** PILE-420 — operator pause hold marker. Cleared when the row leaves
     *  `waiting` (promotion, resume drain, terminal), or set explicitly. */
    paused: number;
    /** PILE-423 — JSON guidance-pack refs recorded at dispatch. */
    guidance: string | null;
    stepKey: string | null;
    /** PILE-426 — serialized plan checklist JSON (or null to clear). */
    plan: string | null;
  }>
) {
  const existing = await getAgentSession(db, organizationId, id);
  if (!existing) return null;
  const set: Record<string, string | number | null> = {
    updatedAt: new Date().toISOString(),
  };
  if (input.status !== undefined) {
    set.status = input.status;
    // Anchor the first terminal transition — the kept-sandbox reaper keys
    // its resume window off endedAt, which later writes can't push.
    if (
      ["completed", "failed", "canceled"].includes(input.status) &&
      !existing.endedAt
    ) {
      set.endedAt = set.updatedAt;
    }
    // PILE-419 — an open elicitation only exists while the session is
    // parked in `waiting`; any other status (resumed, terminal, re-queued
    // to `created`) closes it. Explicit awaiting* writes below win.
    if (input.status !== "waiting" && input.awaitingActivityId === undefined) {
      set.awaitingActivityId = null;
      set.awaitingEscalatedAt = null;
    }
    // A hold only exists while the lane is parked in `waiting`; any other
    // status (promoted, resumed, stale, terminal) releases it. An explicit
    // paused write below wins.
    if (input.status !== "waiting" && input.paused === undefined) {
      set.paused = 0;
    }
  }
  if (input.paused !== undefined) set.paused = input.paused;
  if (input.result !== undefined) set.result = input.result;
  if (input.url !== undefined) set.url = input.url;
  if (input.providerSessionId !== undefined)
    set.providerSessionId = input.providerSessionId;
  if (input.lastProgressAt !== undefined)
    set.lastProgressAt = input.lastProgressAt;
  // PILE-418 — first ack is write-once; later activities don't push it.
  if (input.firstActivityAt !== undefined && !existing.firstActivityAt)
    set.firstActivityAt = input.firstActivityAt;
  if (input.lastStateHash !== undefined)
    set.lastStateHash = input.lastStateHash;
  if (input.retryOf !== undefined) set.retryOf = input.retryOf;
  if (input.retryCount !== undefined) set.retryCount = input.retryCount;
  if (input.createdAt !== undefined) set.createdAt = input.createdAt;
  if (input.startedAt !== undefined) set.startedAt = input.startedAt;
  if (input.prUrl !== undefined) set.prUrl = input.prUrl;
  if (input.prState !== undefined) set.prState = input.prState;
  if (input.branch !== undefined) set.branch = input.branch;
  if (input.queuedAfter !== undefined) set.queuedAfter = input.queuedAfter;
  if (input.parentSessionId !== undefined)
    set.parentSessionId = input.parentSessionId;
  if (input.spawnDepth !== undefined) set.spawnDepth = input.spawnDepth;
  if (input.laneDbRef !== undefined) set.laneDbRef = input.laneDbRef;
  if (input.sandboxBackupRef !== undefined)
    set.sandboxBackupRef = input.sandboxBackupRef;
  if (input.endedAt !== undefined) set.endedAt = input.endedAt;
  if (input.lastReviewedSha !== undefined)
    set.lastReviewedSha = input.lastReviewedSha;
  if (input.reviewSummary !== undefined)
    set.reviewSummary = input.reviewSummary;
  if (input.awaitingActivityId !== undefined)
    set.awaitingActivityId = input.awaitingActivityId;
  if (input.awaitingEscalatedAt !== undefined)
    set.awaitingEscalatedAt = input.awaitingEscalatedAt;
  if (input.guidance !== undefined) set.guidance = input.guidance;
  if (input.stepKey !== undefined) set.stepKey = input.stepKey;
  if (input.plan !== undefined) set.plan = input.plan;
  // A retry/redispatch lane inherits the review history of the lane it
  // replaces, so the next review still range-diffs from the last verdict.
  if (
    input.retryOf &&
    input.reviewSummary === undefined &&
    existing.reviewSummary === null
  ) {
    const source = await getAgentSession(db, organizationId, input.retryOf);
    if (source?.reviewSummary) {
      set.reviewSummary = source.reviewSummary;
      set.lastReviewedSha = source.lastReviewedSha;
    }
  }
  await db
    .update(workspaceAgentSessions)
    .set(set)
    .where(eq(workspaceAgentSessions.id, id));
  return getAgentSession(db, organizationId, id);
}

/** Sessions parked in `waiting` because a blocker lane owns the same file
 *  surface (queuedAfter). The sweep promotes them once the blocker session
 *  is terminal or gone. */
export function listQueuedAgentSessions(
  db: WorkspaceDb,
  organizationId: string
) {
  return db
    .select()
    .from(workspaceAgentSessions)
    .where(
      and(
        eq(workspaceAgentSessions.organizationId, organizationId),
        eq(workspaceAgentSessions.status, "waiting")
      )
    )
    .orderBy(workspaceAgentSessions.createdAt, workspaceAgentSessions.id)
    .all();
}

/** PILE-419 — live sessions suspended on an open elicitation. The sweep
 *  scans this set to escalate questions that went unanswered past the
 *  workspace's configured window. */
export function listAwaitingElicitationSessions(
  db: WorkspaceDb,
  organizationId: string
) {
  const terminal: AgentSessionStatus[] = ["completed", "failed", "canceled"];
  return db
    .select()
    .from(workspaceAgentSessions)
    .where(
      and(
        eq(workspaceAgentSessions.organizationId, organizationId),
        isNotNull(workspaceAgentSessions.awaitingActivityId),
        not(inArray(workspaceAgentSessions.status, terminal))
      )
    )
    .all();
}

/** PILE-420 — `waiting` sessions held by an agent-type pause for this
 *  agent, oldest first — the order resume drains them. A held row may also
 *  carry a queuedAfter edge (dedupe parked it before the pause); those stay
 *  for the queue chain, not the drain. */
export function listPauseHeldSessions(
  db: WorkspaceDb,
  organizationId: string,
  agentId: string
) {
  return db
    .select()
    .from(workspaceAgentSessions)
    .where(
      and(
        eq(workspaceAgentSessions.organizationId, organizationId),
        eq(workspaceAgentSessions.agentId, agentId),
        eq(workspaceAgentSessions.status, "waiting"),
        eq(workspaceAgentSessions.paused, 1)
      )
    )
    .orderBy(workspaceAgentSessions.createdAt, workspaceAgentSessions.id)
    .all();
}

// ---- agent_pauses (PILE-420 — global pause per agent type) ----

export function listAgentPauses(db: WorkspaceDb, organizationId: string) {
  return db
    .select()
    .from(workspaceAgentPauses)
    .where(eq(workspaceAgentPauses.organizationId, organizationId))
    .orderBy(workspaceAgentPauses.createdAt, workspaceAgentPauses.id)
    .all();
}

export function getAgentPause(
  db: WorkspaceDb,
  organizationId: string,
  agentId: string
) {
  return db
    .select()
    .from(workspaceAgentPauses)
    .where(
      and(
        eq(workspaceAgentPauses.organizationId, organizationId),
        eq(workspaceAgentPauses.agentId, agentId)
      )
    )
    .get();
}

export async function upsertAgentPause(
  db: WorkspaceDb,
  organizationId: string,
  agentId: string,
  input: { reason?: string | null; createdBy?: string | null }
) {
  const existing = await getAgentPause(db, organizationId, agentId);
  if (existing) {
    await db
      .update(workspaceAgentPauses)
      .set({
        reason: input.reason ?? null,
        createdBy: input.createdBy ?? existing.createdBy,
      })
      .where(eq(workspaceAgentPauses.id, existing.id));
    return getAgentPause(db, organizationId, agentId);
  }
  const id = crypto.randomUUID();
  await db.insert(workspaceAgentPauses).values({
    id,
    organizationId,
    agentId,
    reason: input.reason ?? null,
    createdBy: input.createdBy ?? null,
    createdAt: new Date().toISOString(),
  });
  return getAgentPause(db, organizationId, agentId);
}

export async function deleteAgentPause(
  db: WorkspaceDb,
  organizationId: string,
  agentId: string
): Promise<boolean> {
  const rows = await db
    .delete(workspaceAgentPauses)
    .where(
      and(
        eq(workspaceAgentPauses.organizationId, organizationId),
        eq(workspaceAgentPauses.agentId, agentId)
      )
    )
    .returning({ id: workspaceAgentPauses.id })
    .all();
  return rows.length > 0;
}

// ---- agent spend caps + run receipts (PILE-425) ----

export type AgentSpendCap = typeof workspaceAgentSpendCaps.$inferSelect;
export type AgentRunReceipt = typeof workspaceAgentRunReceipts.$inferSelect;

/** Fields of a caps row a PUT may set; omitted keys keep their value. */
export interface AgentSpendCapPatch {
  maxRunsPerDay?: number | null;
  maxRunsPerMonth?: number | null;
  maxTokensPerDay?: number | null;
  maxTokensPerMonth?: number | null;
  maxCostMicrosPerDay?: number | null;
  maxCostMicrosPerMonth?: number | null;
  maxTokensPerRun?: number | null;
  maxCostMicrosPerRun?: number | null;
}

const SPEND_CAP_PATCH_COLUMNS = [
  "maxRunsPerDay",
  "maxRunsPerMonth",
  "maxTokensPerDay",
  "maxTokensPerMonth",
  "maxCostMicrosPerDay",
  "maxCostMicrosPerMonth",
  "maxTokensPerRun",
  "maxCostMicrosPerRun",
] as const;

export function listAgentSpendCaps(db: WorkspaceDb, organizationId: string) {
  return db
    .select()
    .from(workspaceAgentSpendCaps)
    .where(eq(workspaceAgentSpendCaps.organizationId, organizationId))
    .orderBy(workspaceAgentSpendCaps.agentId)
    .all();
}

export function getAgentSpendCap(
  db: WorkspaceDb,
  organizationId: string,
  agentId: string
) {
  return db
    .select()
    .from(workspaceAgentSpendCaps)
    .where(
      and(
        eq(workspaceAgentSpendCaps.organizationId, organizationId),
        eq(workspaceAgentSpendCaps.agentId, agentId)
      )
    )
    .get();
}

/** The caps an agent type actually runs under: its own row, else the
 *  workspace default ("*"), else uncapped. */
export function resolveAgentSpendCap(
  db: WorkspaceDb,
  organizationId: string,
  agentId: string
) {
  return (
    getAgentSpendCap(db, organizationId, agentId) ??
    getAgentSpendCap(db, organizationId, "*")
  );
}

export async function upsertAgentSpendCap(
  db: WorkspaceDb,
  organizationId: string,
  agentId: string,
  input: AgentSpendCapPatch & { createdBy?: string | null }
) {
  const existing = await getAgentSpendCap(db, organizationId, agentId);
  const ts = new Date().toISOString();
  if (existing) {
    const set: Record<string, number | string | null> = { updatedAt: ts };
    for (const key of SPEND_CAP_PATCH_COLUMNS) {
      if (input[key] !== undefined) set[key] = input[key];
    }
    await db
      .update(workspaceAgentSpendCaps)
      .set(set)
      .where(eq(workspaceAgentSpendCaps.id, existing.id));
    return getAgentSpendCap(db, organizationId, agentId);
  }
  const id = crypto.randomUUID();
  await db.insert(workspaceAgentSpendCaps).values({
    id,
    organizationId,
    agentId,
    maxRunsPerDay: input.maxRunsPerDay ?? null,
    maxRunsPerMonth: input.maxRunsPerMonth ?? null,
    maxTokensPerDay: input.maxTokensPerDay ?? null,
    maxTokensPerMonth: input.maxTokensPerMonth ?? null,
    maxCostMicrosPerDay: input.maxCostMicrosPerDay ?? null,
    maxCostMicrosPerMonth: input.maxCostMicrosPerMonth ?? null,
    maxTokensPerRun: input.maxTokensPerRun ?? null,
    maxCostMicrosPerRun: input.maxCostMicrosPerRun ?? null,
    createdBy: input.createdBy ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return getAgentSpendCap(db, organizationId, agentId);
}

export async function deleteAgentSpendCap(
  db: WorkspaceDb,
  organizationId: string,
  agentId: string
): Promise<boolean> {
  const rows = await db
    .delete(workspaceAgentSpendCaps)
    .where(
      and(
        eq(workspaceAgentSpendCaps.organizationId, organizationId),
        eq(workspaceAgentSpendCaps.agentId, agentId)
      )
    )
    .returning({ id: workspaceAgentSpendCaps.id })
    .all();
  return rows.length > 0;
}

/** Stamp the caps row that produced the current breach so the once-a-day
 *  CoS alert doesn't refire while the breach persists. Stamps the row the
 *  cap resolved from (agent's own row or the "*" default). Returns the
 *  stamped row, or null when the agent has no caps row at all. */
export async function markAgentSpendCapAlerted(
  db: WorkspaceDb,
  organizationId: string,
  agentId: string
): Promise<AgentSpendCap | undefined> {
  const row = await resolveAgentSpendCap(db, organizationId, agentId);
  if (!row) return undefined;
  await db
    .update(workspaceAgentSpendCaps)
    .set({
      lastCapAlertAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(workspaceAgentSpendCaps.id, row.id));
  return getAgentSpendCap(db, organizationId, row.agentId);
}

// ---- run receipts ----

export function getRunReceipt(
  db: WorkspaceDb,
  organizationId: string,
  sessionId: string
) {
  return db
    .select()
    .from(workspaceAgentRunReceipts)
    .where(
      and(
        eq(workspaceAgentRunReceipts.organizationId, organizationId),
        eq(workspaceAgentRunReceipts.sessionId, sessionId)
      )
    )
    .get();
}

export interface RunReceiptFilter {
  sessionId?: string;
  agentId?: string;
  issueId?: string;
  stepKey?: string;
  dealId?: string;
  /** ISO createdAt bounds — receipt written inside the window. */
  since?: string;
  until?: string;
  limit?: number;
}

function runReceiptConditions(
  organizationId: string,
  filter: RunReceiptFilter
) {
  const conditions = [
    eq(workspaceAgentRunReceipts.organizationId, organizationId),
  ];
  if (filter.sessionId) {
    conditions.push(eq(workspaceAgentRunReceipts.sessionId, filter.sessionId));
  }
  if (filter.agentId) {
    conditions.push(eq(workspaceAgentRunReceipts.agentId, filter.agentId));
  }
  if (filter.issueId) {
    conditions.push(eq(workspaceAgentRunReceipts.issueId, filter.issueId));
  }
  if (filter.stepKey) {
    conditions.push(eq(workspaceAgentRunReceipts.stepKey, filter.stepKey));
  }
  if (filter.dealId) {
    conditions.push(eq(workspaceAgentRunReceipts.dealId, filter.dealId));
  }
  if (filter.since) {
    conditions.push(gte(workspaceAgentRunReceipts.createdAt, filter.since));
  }
  if (filter.until) {
    conditions.push(lte(workspaceAgentRunReceipts.createdAt, filter.until));
  }
  return conditions;
}

export function listRunReceipts(
  db: WorkspaceDb,
  organizationId: string,
  filter: RunReceiptFilter = {}
) {
  return db
    .select()
    .from(workspaceAgentRunReceipts)
    .where(and(...runReceiptConditions(organizationId, filter)))
    .orderBy(
      desc(workspaceAgentRunReceipts.createdAt),
      desc(workspaceAgentRunReceipts.id)
    )
    .limit(filter.limit ?? 100)
    .all();
}

/** Identity + immutable-ish fields set when the receipt row is created;
 *  usage/outcome fields update on every write. */
export interface RunReceiptInsert {
  sessionId: string;
  issueId: string;
  agentId: string;
  stepKey?: string | null;
  dealId?: string | null;
  status?: string;
  model?: string | null;
  effort?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  toolCalls?: number | null;
  costMicros?: number | null;
  externalSpendMicros?: number | null;
  costSource?: string | null;
  capExceeded?: number;
  stopReason?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number | null;
}

const RECEIPT_PATCH_COLUMNS = [
  "status",
  "model",
  "effort",
  "stepKey",
  "dealId",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "toolCalls",
  "costMicros",
  "externalSpendMicros",
  "costSource",
  "capExceeded",
  "stopReason",
  "startedAt",
  "endedAt",
  "durationMs",
] as const;

/** Insert-or-update keyed by session — usage reports land mid-run, the
 *  terminal transition finalizes status/timing. Only provided fields are
 *  written, so a later partial report can't null out earlier data. */
export async function upsertRunReceipt(
  db: WorkspaceDb,
  organizationId: string,
  input: RunReceiptInsert
): Promise<AgentRunReceipt | undefined> {
  const existing = await getRunReceipt(db, organizationId, input.sessionId);
  const ts = new Date().toISOString();
  if (existing) {
    const set: Record<string, number | string | null> = { updatedAt: ts };
    for (const key of RECEIPT_PATCH_COLUMNS) {
      const value = input[key];
      if (value !== undefined) set[key] = value;
    }
    await db
      .update(workspaceAgentRunReceipts)
      .set(set)
      .where(eq(workspaceAgentRunReceipts.id, existing.id));
    return getRunReceipt(db, organizationId, input.sessionId);
  }
  const id = crypto.randomUUID();
  await db.insert(workspaceAgentRunReceipts).values({
    id,
    organizationId,
    sessionId: input.sessionId,
    issueId: input.issueId,
    agentId: input.agentId,
    stepKey: input.stepKey ?? null,
    dealId: input.dealId ?? null,
    status: input.status ?? "running",
    model: input.model ?? null,
    effort: input.effort ?? null,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    toolCalls: input.toolCalls ?? null,
    costMicros: input.costMicros ?? null,
    externalSpendMicros: input.externalSpendMicros ?? null,
    costSource: input.costSource ?? null,
    capExceeded: input.capExceeded ?? 0,
    stopReason: input.stopReason ?? null,
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null,
    durationMs: input.durationMs ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  return getRunReceipt(db, organizationId, input.sessionId);
}

export interface RunUsageSums {
  receipts: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: number;
  externalSpendMicros: number;
}

/** Sum receipt usage for an agent (or the whole org when agentId is null)
 *  since an ISO bound. `totalTokens` falls back to in+out so runs that only
 *  reported halves still count. */
export async function sumRunReceipts(
  db: WorkspaceDb,
  organizationId: string,
  filter: { agentId?: string | null; since: string }
): Promise<RunUsageSums> {
  const conditions = [
    eq(workspaceAgentRunReceipts.organizationId, organizationId),
    gte(workspaceAgentRunReceipts.createdAt, filter.since),
  ];
  if (filter.agentId) {
    conditions.push(eq(workspaceAgentRunReceipts.agentId, filter.agentId));
  }
  const row = await db
    .select({
      receipts: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(${workspaceAgentRunReceipts.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${workspaceAgentRunReceipts.outputTokens}), 0)`,
      totalTokens: sql<number>`coalesce(sum(coalesce(${workspaceAgentRunReceipts.totalTokens}, ${workspaceAgentRunReceipts.inputTokens} + ${workspaceAgentRunReceipts.outputTokens})), 0)`,
      costMicros: sql<number>`coalesce(sum(${workspaceAgentRunReceipts.costMicros}), 0)`,
      externalSpendMicros: sql<number>`coalesce(sum(${workspaceAgentRunReceipts.externalSpendMicros}), 0)`,
    })
    .from(workspaceAgentRunReceipts)
    .where(and(...conditions))
    .get();
  return {
    receipts: row?.receipts ?? 0,
    inputTokens: row?.inputTokens ?? 0,
    outputTokens: row?.outputTokens ?? 0,
    totalTokens: row?.totalTokens ?? 0,
    costMicros: row?.costMicros ?? 0,
    externalSpendMicros: row?.externalSpendMicros ?? 0,
  };
}

/** Sessions created since an ISO bound — the "runs per day/month" count.
 *  Counts sessions, not receipts: a queued lane still consumed a run slot. */
export async function countAgentSessionsSince(
  db: WorkspaceDb,
  organizationId: string,
  agentId: string,
  since: string
) {
  const row = await db
    .select({ count: sql<number>`count(*)` })
    .from(workspaceAgentSessions)
    .where(
      and(
        eq(workspaceAgentSessions.organizationId, organizationId),
        eq(workspaceAgentSessions.agentId, agentId),
        gte(workspaceAgentSessions.createdAt, since)
      )
    )
    .get();
  return row?.count ?? 0;
}

export type RunReceiptGroupBy = "agentId" | "stepKey" | "issueId" | "dealId";

export interface RunReceiptSummaryRow {
  key: string | null;
  runs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  costMicros: number;
  externalSpendMicros: number;
  capExceededRuns: number;
}

const RECEIPT_GROUP_COLUMNS = {
  agentId: workspaceAgentRunReceipts.agentId,
  stepKey: workspaceAgentRunReceipts.stepKey,
  issueId: workspaceAgentRunReceipts.issueId,
  dealId: workspaceAgentRunReceipts.dealId,
} as const;

/** Receipts aggregated per agent, step (pipeline stage), issue, or deal —
 *  the spec's "receipts can be aggregated per agent, stage, and deal". */
export async function summarizeRunReceipts(
  db: WorkspaceDb,
  organizationId: string,
  input: RunReceiptFilter & { groupBy: RunReceiptGroupBy }
): Promise<RunReceiptSummaryRow[]> {
  const groupColumn = RECEIPT_GROUP_COLUMNS[input.groupBy];
  const rows = await db
    .select({
      key: groupColumn,
      runs: sql<number>`count(*)`,
      inputTokens: sql<number>`coalesce(sum(${workspaceAgentRunReceipts.inputTokens}), 0)`,
      outputTokens: sql<number>`coalesce(sum(${workspaceAgentRunReceipts.outputTokens}), 0)`,
      totalTokens: sql<number>`coalesce(sum(coalesce(${workspaceAgentRunReceipts.totalTokens}, ${workspaceAgentRunReceipts.inputTokens} + ${workspaceAgentRunReceipts.outputTokens})), 0)`,
      toolCalls: sql<number>`coalesce(sum(${workspaceAgentRunReceipts.toolCalls}), 0)`,
      costMicros: sql<number>`coalesce(sum(${workspaceAgentRunReceipts.costMicros}), 0)`,
      externalSpendMicros: sql<number>`coalesce(sum(${workspaceAgentRunReceipts.externalSpendMicros}), 0)`,
      capExceededRuns: sql<number>`coalesce(sum(${workspaceAgentRunReceipts.capExceeded}), 0)`,
    })
    .from(workspaceAgentRunReceipts)
    .where(and(...runReceiptConditions(organizationId, input)))
    .groupBy(groupColumn)
    .orderBy(desc(sql`count(*)`))
    .limit(input.limit ?? 500)
    .all();
  return rows.map((row) => ({
    key: row.key,
    runs: row.runs,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    toolCalls: row.toolCalls,
    costMicros: row.costMicros,
    externalSpendMicros: row.externalSpendMicros,
    capExceededRuns: row.capExceededRuns,
  }));
}

// ---- guidance_packs (PILE-423 — scoped agent instruction packs) ----

export type GuidanceScope = "workspace" | "team" | "status" | "step";

export interface GuidancePackInput {
  organizationId: string;
  name: string;
  scope: GuidanceScope;
  /** Team id / status value / step key; null for workspace scope. */
  scopeKey?: string | null;
  body: string;
  /** JSON array of {label?, url} reference links rendered with the body. */
  links?: string | null;
  createdBy?: string | null;
}

export type GuidancePack = typeof workspaceGuidancePacks.$inferSelect;
export type GuidancePackVersion =
  typeof workspaceGuidancePackVersions.$inferSelect;

async function recordGuidancePackVersion(
  db: WorkspaceDb,
  pack: GuidancePack,
  actorId: string | null
) {
  await db.insert(workspaceGuidancePackVersions).values({
    id: crypto.randomUUID(),
    organizationId: pack.organizationId,
    packId: pack.id,
    version: pack.version,
    name: pack.name,
    body: pack.body,
    links: pack.links,
    actorId,
    createdAt: new Date().toISOString(),
  });
}

export async function createGuidancePack(
  db: WorkspaceDb,
  input: GuidancePackInput
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  await db.insert(workspaceGuidancePacks).values({
    id,
    organizationId: input.organizationId,
    name: input.name,
    scope: input.scope,
    scopeKey: input.scope === "workspace" ? null : (input.scopeKey ?? null),
    body: input.body,
    links: input.links ?? null,
    version: 1,
    createdBy: input.createdBy ?? null,
    updatedBy: input.createdBy ?? null,
    createdAt: ts,
    updatedAt: ts,
  });
  const pack = await getGuidancePack(db, input.organizationId, id);
  if (!pack) throw new Error("Failed to create guidance pack");
  await recordGuidancePackVersion(db, pack, input.createdBy ?? null);
  return pack;
}

export function getGuidancePack(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceGuidancePacks)
    .where(
      and(
        eq(workspaceGuidancePacks.organizationId, organizationId),
        eq(workspaceGuidancePacks.id, id)
      )
    )
    .get();
}

export function listGuidancePacks(
  db: WorkspaceDb,
  organizationId: string,
  filter: { scope?: GuidanceScope; scopeKey?: string } = {}
) {
  const conditions = [
    eq(workspaceGuidancePacks.organizationId, organizationId),
  ];
  if (filter.scope) {
    conditions.push(eq(workspaceGuidancePacks.scope, filter.scope));
  }
  if (filter.scopeKey !== undefined) {
    conditions.push(eq(workspaceGuidancePacks.scopeKey, filter.scopeKey));
  }
  return db
    .select()
    .from(workspaceGuidancePacks)
    .where(and(...conditions))
    .orderBy(workspaceGuidancePacks.createdAt, workspaceGuidancePacks.id)
    .all();
}

/** Every edit bumps `version` and snapshots the new revision into
 *  guidance_pack_versions — a session's recorded {packId, version} refs
 *  always resolve to the exact text the lane was dispatched with.
 *  Returns null when the pack is gone. */
export async function updateGuidancePack(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  input: {
    name?: string;
    scope?: GuidanceScope;
    scopeKey?: string | null;
    body?: string;
    links?: string | null;
  },
  actorId: string | null
) {
  const existing = await getGuidancePack(db, organizationId, id);
  if (!existing) return null;
  const scope = input.scope ?? existing.scope;
  const scopeKey =
    scope === "workspace"
      ? null
      : input.scopeKey !== undefined
        ? input.scopeKey
        : existing.scopeKey;
  const next = {
    name: input.name ?? existing.name,
    scope,
    scopeKey,
    body: input.body ?? existing.body,
    links: input.links !== undefined ? input.links : existing.links,
    version: existing.version + 1,
    updatedBy: actorId,
    updatedAt: new Date().toISOString(),
  };
  await db
    .update(workspaceGuidancePacks)
    .set(next)
    .where(eq(workspaceGuidancePacks.id, id));
  const pack = await getGuidancePack(db, organizationId, id);
  if (pack) await recordGuidancePackVersion(db, pack, actorId);
  return pack;
}

export async function deleteGuidancePack(
  db: WorkspaceDb,
  organizationId: string,
  id: string
): Promise<boolean> {
  const rows = await db
    .delete(workspaceGuidancePacks)
    .where(
      and(
        eq(workspaceGuidancePacks.organizationId, organizationId),
        eq(workspaceGuidancePacks.id, id)
      )
    )
    .returning({ id: workspaceGuidancePacks.id })
    .all();
  if (rows.length === 0) return false;
  // Versions are the audit trail for sessions that ran with this pack —
  // deleting a pack must not orphan the history its sessions reference, so
  // the snapshots stay even though the live row is gone.
  return true;
}

export function listGuidancePackVersions(
  db: WorkspaceDb,
  organizationId: string,
  packId: string
): GuidancePackVersion[] {
  return db
    .select()
    .from(workspaceGuidancePackVersions)
    .where(
      and(
        eq(workspaceGuidancePackVersions.organizationId, organizationId),
        eq(workspaceGuidancePackVersions.packId, packId)
      )
    )
    .orderBy(workspaceGuidancePackVersions.version)
    .all();
}

/** Injection order: least specific first so the most specific pack's text
 *  lands last in the prompt (workspace → team → status → step), ties broken
 *  by creation order within a scope. */
const GUIDANCE_SCOPE_ORDER: Record<GuidanceScope, number> = {
  workspace: 0,
  team: 1,
  status: 2,
  step: 3,
};

export async function resolveGuidancePacks(
  db: WorkspaceDb,
  organizationId: string,
  keys: {
    teamId?: string | null;
    status?: string | null;
    stepKey?: string | null;
  }
): Promise<GuidancePack[]> {
  const rows = await db
    .select()
    .from(workspaceGuidancePacks)
    .where(
      and(
        eq(workspaceGuidancePacks.organizationId, organizationId),
        or(
          eq(workspaceGuidancePacks.scope, "workspace"),
          keys.teamId
            ? and(
                eq(workspaceGuidancePacks.scope, "team"),
                eq(workspaceGuidancePacks.scopeKey, keys.teamId)
              )
            : undefined,
          keys.status
            ? and(
                eq(workspaceGuidancePacks.scope, "status"),
                eq(workspaceGuidancePacks.scopeKey, keys.status)
              )
            : undefined,
          keys.stepKey
            ? and(
                eq(workspaceGuidancePacks.scope, "step"),
                eq(workspaceGuidancePacks.scopeKey, keys.stepKey)
              )
            : undefined
        )
      )
    )
    .all();
  return rows.toSorted(
    (a, b) =>
      GUIDANCE_SCOPE_ORDER[a.scope] - GUIDANCE_SCOPE_ORDER[b.scope] ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id)
  );
}

// ---- stage_templates (PILE-411 — sub-steps auto-created on entering a
// status; Salesforce Flow Orchestration model) ----

export type StageEntityType = "issue" | "deal" | "customer";
export type StageTemplate = typeof workspaceStageTemplates.$inferSelect;

/** Optional JSON rule gating a sub-step definition. `{field}` alone means
 *  "create only when the record's field resolves truthy"; `{field, equals}`
 *  compares the stored value for equality. */
export interface StepCondition {
  field: string;
  equals?: string | number | boolean;
}

export interface StageTemplateInput {
  organizationId: string;
  entityType?: StageEntityType;
  status: string;
  stepKey: string;
  title: string;
  required?: boolean;
  ownerAgent?: string | null;
  condition?: StepCondition | null;
  position?: number;
  teamId?: string | null;
  createdBy?: string | null;
}

export interface StageTemplatePatch {
  entityType?: StageEntityType;
  status?: string;
  stepKey?: string;
  title?: string;
  required?: boolean;
  ownerAgent?: string | null;
  condition?: StepCondition | null;
  position?: number;
  teamId?: string | null;
}

/** Stage/status and step keys are slug-normalized at write AND match time,
 *  so "Prospect", "prospect", and "Onboarding & go-live" all resolve to one
 *  canonical key ("prospect", "onboarding_go_live"). */
export function stageKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Condition field names normalize more aggressively than stage keys — all
 *  separators collapse away so a `hardware_needed` rule matches a custom
 *  field named "Hardware needed" or "hardwareNeeded" alike. */
function conditionFieldKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === 0) return false;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    return (
      lowered !== "" &&
      lowered !== "false" &&
      lowered !== "0" &&
      lowered !== "no"
    );
  }
  return true;
}

/** The context a condition rule reads: the record's own columns plus its
 *  custom field values, keyed by normalized field name. */
export function buildStepContext(
  db: WorkspaceDb,
  organizationId: string,
  entityType: string,
  entityId: string,
  record: object
): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && value !== undefined) {
      context[conditionFieldKey(key)] = value;
    }
  }
  const definitions = db
    .select()
    .from(workspaceFieldDefinitions)
    .where(
      and(
        eq(workspaceFieldDefinitions.organizationId, organizationId),
        eq(workspaceFieldDefinitions.entityType, entityType)
      )
    )
    .all();
  const nameById = new Map(definitions.map((d) => [d.id, d.name]));
  const values = db
    .select()
    .from(workspaceFieldValues)
    .where(
      and(
        eq(workspaceFieldValues.organizationId, organizationId),
        eq(workspaceFieldValues.entityId, entityId)
      )
    )
    .all();
  // Custom fields land last — a named field beats a same-keyed column.
  for (const value of values) {
    const name = nameById.get(value.fieldId);
    if (name && value.value !== null) {
      context[conditionFieldKey(name)] = value.value;
    }
  }
  return context;
}

/** Fails closed: an unparseable or field-less rule skips the step rather
 *  than creating work nobody verified the precondition for. */
export function evaluateStepCondition(
  raw: string | null,
  context: Record<string, unknown>
): boolean {
  if (raw === null || raw === "") return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const condition = parsed as { field?: unknown; equals?: unknown };
  if (typeof condition.field !== "string" || condition.field === "") {
    return false;
  }
  const value = context[conditionFieldKey(condition.field)];
  if (condition.equals !== undefined) {
    if (value === undefined || value === null) return false;
    return String(value) === String(condition.equals);
  }
  return isTruthy(value);
}

function serializeCondition(condition: StepCondition | null | undefined) {
  return condition ? JSON.stringify(condition) : null;
}

export function createStageTemplate(
  db: WorkspaceDb,
  input: StageTemplateInput
) {
  const now = new Date().toISOString();
  return db
    .insert(workspaceStageTemplates)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      entityType: input.entityType ?? "issue",
      status: stageKey(input.status),
      stepKey: stageKey(input.stepKey),
      title: input.title,
      required: input.required ?? true,
      ownerAgent: input.ownerAgent ?? null,
      condition: serializeCondition(input.condition),
      position: input.position ?? 0,
      teamId: input.teamId ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function getStageTemplate(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceStageTemplates)
    .where(
      and(
        eq(workspaceStageTemplates.organizationId, organizationId),
        eq(workspaceStageTemplates.id, id)
      )
    )
    .get();
}

export function listStageTemplates(
  db: WorkspaceDb,
  organizationId: string,
  filter: { entityType?: StageEntityType; status?: string } = {}
) {
  const conditions = [
    eq(workspaceStageTemplates.organizationId, organizationId),
  ];
  if (filter.entityType !== undefined) {
    conditions.push(eq(workspaceStageTemplates.entityType, filter.entityType));
  }
  if (filter.status !== undefined) {
    conditions.push(
      eq(workspaceStageTemplates.status, stageKey(filter.status))
    );
  }
  return db
    .select()
    .from(workspaceStageTemplates)
    .where(and(...conditions))
    .orderBy(
      workspaceStageTemplates.position,
      workspaceStageTemplates.createdAt
    )
    .all();
}

/** The step definitions a record entering `status` materializes — the
 *  trigger path (status transition) resolves through this one lookup. */
export function listStageTemplatesForStatus(
  db: WorkspaceDb,
  organizationId: string,
  entityType: StageEntityType,
  status: string
) {
  return listStageTemplates(db, organizationId, {
    entityType,
    status: stageKey(status),
  });
}

export function updateStageTemplate(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  patch: StageTemplatePatch
) {
  const set: Partial<typeof workspaceStageTemplates.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };
  if (patch.entityType !== undefined) set.entityType = patch.entityType;
  if (patch.status !== undefined) set.status = stageKey(patch.status);
  if (patch.stepKey !== undefined) set.stepKey = stageKey(patch.stepKey);
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.required !== undefined) set.required = patch.required;
  if (patch.ownerAgent !== undefined) set.ownerAgent = patch.ownerAgent;
  if (patch.condition !== undefined)
    set.condition = serializeCondition(patch.condition);
  if (patch.position !== undefined) set.position = patch.position;
  if (patch.teamId !== undefined) set.teamId = patch.teamId;
  return db
    .update(workspaceStageTemplates)
    .set(set)
    .where(
      and(
        eq(workspaceStageTemplates.id, id),
        eq(workspaceStageTemplates.organizationId, organizationId)
      )
    )
    .returning()
    .get();
}

export function deleteStageTemplate(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return (
    db
      .delete(workspaceStageTemplates)
      .where(
        and(
          eq(workspaceStageTemplates.id, id),
          eq(workspaceStageTemplates.organizationId, organizationId)
        )
      )
      .returning({ id: workspaceStageTemplates.id })
      .all().length > 0
  );
}

/** Ids of issues linked to a non-issue record (both link directions — a
 *  "deal" is a parent issue linked to the customer). These parents are
 *  where deal/customer stage templates materialize their sub-steps. */
export function listLinkedIssueIds(
  db: WorkspaceDb,
  organizationId: string,
  entityType: string,
  entityId: string
): string[] {
  return db
    .select()
    .from(workspaceEntityLinks)
    .where(
      and(
        eq(workspaceEntityLinks.organizationId, organizationId),
        or(
          and(
            eq(workspaceEntityLinks.fromType, entityType),
            eq(workspaceEntityLinks.fromId, entityId),
            eq(workspaceEntityLinks.toType, "issue")
          ),
          and(
            eq(workspaceEntityLinks.toType, entityType),
            eq(workspaceEntityLinks.toId, entityId),
            eq(workspaceEntityLinks.fromType, "issue")
          )
        )
      )
    )
    .all()
    .map((row) => (row.fromType === "issue" ? row.fromId : row.toId));
}

// ---- external event mappings + deliveries (PILE-422) ----
// An inbound provider event (Finix merchant approved, Seal agreement
// signed, carrier delivered) resolves through a mapping to a sub-step and
// completes the child issue carrying that stepKey. The deliveries table is
// both the dedupe ledger and the audit log — every inbound event lands one
// row recording why it did or didn't move state.

export type ExternalEventMapping =
  typeof workspaceExternalEventMappings.$inferSelect;
export type ExternalEventDelivery =
  typeof workspaceExternalEventDeliveries.$inferSelect;

export interface ExternalEventMappingInput {
  organizationId: string;
  source: string;
  eventType: string;
  entityType: "issue" | "deal" | "customer";
  matchPath: string;
  stepKey: string;
  secret: string;
  enabled?: boolean;
  createdBy?: string | null;
}

export type ExternalEventMappingPatch = Partial<
  Omit<ExternalEventMappingInput, "organizationId" | "createdBy">
>;

export function createExternalEventMapping(
  db: WorkspaceDb,
  input: ExternalEventMappingInput
) {
  const now = new Date().toISOString();
  return db
    .insert(workspaceExternalEventMappings)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      // Source and stepKey slug-normalize like stage keys; eventType stays
      // verbatim — provider event names are literals ("merchant.updated").
      source: stageKey(input.source),
      eventType: input.eventType,
      entityType: input.entityType,
      matchPath: input.matchPath,
      stepKey: stageKey(input.stepKey),
      secret: input.secret,
      enabled: input.enabled ?? true,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function getExternalEventMapping(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceExternalEventMappings)
    .where(
      and(
        eq(workspaceExternalEventMappings.organizationId, organizationId),
        eq(workspaceExternalEventMappings.id, id)
      )
    )
    .get();
}

export function listExternalEventMappings(
  db: WorkspaceDb,
  organizationId: string,
  filter: { source?: string; enabledOnly?: boolean } = {}
) {
  const conditions = [
    eq(workspaceExternalEventMappings.organizationId, organizationId),
  ];
  if (filter.source !== undefined) {
    conditions.push(
      eq(workspaceExternalEventMappings.source, stageKey(filter.source))
    );
  }
  if (filter.enabledOnly) {
    conditions.push(eq(workspaceExternalEventMappings.enabled, true));
  }
  return db
    .select()
    .from(workspaceExternalEventMappings)
    .where(and(...conditions))
    .orderBy(
      workspaceExternalEventMappings.source,
      workspaceExternalEventMappings.eventType
    )
    .all();
}

export function updateExternalEventMapping(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  patch: ExternalEventMappingPatch
) {
  const set: Partial<typeof workspaceExternalEventMappings.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };
  if (patch.source !== undefined) set.source = stageKey(patch.source);
  if (patch.eventType !== undefined) set.eventType = patch.eventType;
  if (patch.entityType !== undefined) set.entityType = patch.entityType;
  if (patch.matchPath !== undefined) set.matchPath = patch.matchPath;
  if (patch.stepKey !== undefined) set.stepKey = stageKey(patch.stepKey);
  if (patch.secret !== undefined) set.secret = patch.secret;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  return db
    .update(workspaceExternalEventMappings)
    .set(set)
    .where(
      and(
        eq(workspaceExternalEventMappings.id, id),
        eq(workspaceExternalEventMappings.organizationId, organizationId)
      )
    )
    .returning()
    .get();
}

export function deleteExternalEventMapping(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return (
    db
      .delete(workspaceExternalEventMappings)
      .where(
        and(
          eq(workspaceExternalEventMappings.id, id),
          eq(workspaceExternalEventMappings.organizationId, organizationId)
        )
      )
      .returning({ id: workspaceExternalEventMappings.id })
      .all().length > 0
  );
}

export interface ExternalEventDeliveryInput {
  organizationId: string;
  source: string;
  eventType?: string | null;
  eventId?: string | null;
  dedupeKey: string;
  status: string;
  entityType?: string | null;
  entityId?: string | null;
  completedIssueIds?: string[];
  payload?: string | null;
}

/** Insert returns undefined on a (org, source, dedupe_key) conflict — the
 *  caller treats that as a replay and reads back the recorded row. */
export function insertExternalEventDelivery(
  db: WorkspaceDb,
  input: ExternalEventDeliveryInput
) {
  return db
    .insert(workspaceExternalEventDeliveries)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      source: input.source,
      eventType: input.eventType ?? null,
      eventId: input.eventId ?? null,
      dedupeKey: input.dedupeKey,
      status: input.status,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      completedIssueIds: input.completedIssueIds
        ? JSON.stringify(input.completedIssueIds)
        : null,
      payload: input.payload ?? null,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .returning()
    .get();
}

/** Finalizes a claimed delivery row — ingest writes the row as
 *  "processing" first (the dedupe claim), then updates it with the
 *  outcome. */
export function updateExternalEventDelivery(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  patch: {
    status?: string;
    eventType?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    completedIssueIds?: string[];
  }
) {
  const set: Partial<typeof workspaceExternalEventDeliveries.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.eventType !== undefined) set.eventType = patch.eventType;
  if (patch.entityType !== undefined) set.entityType = patch.entityType;
  if (patch.entityId !== undefined) set.entityId = patch.entityId;
  if (patch.completedIssueIds !== undefined) {
    set.completedIssueIds = JSON.stringify(patch.completedIssueIds);
  }
  return db
    .update(workspaceExternalEventDeliveries)
    .set(set)
    .where(
      and(
        eq(workspaceExternalEventDeliveries.id, id),
        eq(workspaceExternalEventDeliveries.organizationId, organizationId)
      )
    )
    .returning()
    .get();
}

export function getExternalEventDeliveryByDedupeKey(
  db: WorkspaceDb,
  organizationId: string,
  source: string,
  dedupeKey: string
) {
  return db
    .select()
    .from(workspaceExternalEventDeliveries)
    .where(
      and(
        eq(workspaceExternalEventDeliveries.organizationId, organizationId),
        eq(workspaceExternalEventDeliveries.source, source),
        eq(workspaceExternalEventDeliveries.dedupeKey, dedupeKey)
      )
    )
    .get();
}

export function listExternalEventDeliveries(
  db: WorkspaceDb,
  organizationId: string,
  filter: { source?: string; status?: string; limit?: number } = {}
) {
  const conditions = [
    eq(workspaceExternalEventDeliveries.organizationId, organizationId),
  ];
  if (filter.source !== undefined) {
    conditions.push(
      eq(workspaceExternalEventDeliveries.source, stageKey(filter.source))
    );
  }
  if (filter.status !== undefined) {
    conditions.push(eq(workspaceExternalEventDeliveries.status, filter.status));
  }
  return db
    .select()
    .from(workspaceExternalEventDeliveries)
    .where(and(...conditions))
    .orderBy(desc(workspaceExternalEventDeliveries.createdAt))
    .limit(filter.limit ?? 100)
    .all();
}

/** Pulls a scalar out of a payload by dotted path ("data.merchant.id");
 *  numeric segments index arrays. Returns null when the path resolves to
 *  nothing stringifiable — the caller treats that as no record match. */
export function resolvePayloadPath(
  payload: unknown,
  path: string
): string | null {
  let node: unknown = payload;
  for (const segment of path.split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node === "string" && node !== "") return node;
  if (typeof node === "number") return String(node);
  return null;
}

/** Reads the first present string field — provider envelopes disagree on
 *  naming ("type" vs "event_type" vs "event"; "id" vs "event_id"). */
export function extractEventField(
  payload: unknown,
  keys: string[]
): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/** The sales-led merchant pipeline's seven stages (design doc
 *  ffa468a8-82e7-454d-bf66-30ed0988a9be). R = required for stage completion;
 *  owner_agent is the named pipeline role — dispatch resolves it to a
 *  registered agent (PILE-413). "Hardware shipped" gates on the record's
 *  `hardware_needed` field. The stages hang on the customer record: the
 *  merchant's stage is its customer status, and the deal is the parent
 *  issue linked to that customer. */
export const DEFAULT_STAGE_TEMPLATES: ReadonlyArray<{
  entityType: StageEntityType;
  status: string;
  stepKey: string;
  title: string;
  required: boolean;
  ownerAgent: string | null;
  condition?: StepCondition;
}> = [
  // 1. Prospect
  {
    entityType: "customer",
    status: "prospect",
    stepKey: "sourced",
    title: "Sourced",
    required: true,
    ownerAgent: "scout",
  },
  {
    entityType: "customer",
    status: "prospect",
    stepKey: "profiled",
    title: "Profiled",
    required: true,
    ownerAgent: "profiler",
  },
  {
    entityType: "customer",
    status: "prospect",
    stepKey: "contact_found",
    title: "Contact found",
    required: true,
    ownerAgent: "detective",
  },
  {
    entityType: "customer",
    status: "prospect",
    stepKey: "field_visit",
    title: "Field visit",
    required: false,
    ownerAgent: "field_dispatcher",
  },
  {
    entityType: "customer",
    status: "prospect",
    stepKey: "ready_for_outreach",
    title: "Ready for outreach",
    required: true,
    ownerAgent: "ranker",
  },
  // 2. Outreach
  {
    entityType: "customer",
    status: "outreach",
    stepKey: "contacted",
    title: "Contacted",
    required: true,
    ownerAgent: "courier",
  },
  {
    entityType: "customer",
    status: "outreach",
    stepKey: "replied",
    title: "Replied",
    required: true,
    ownerAgent: "chaser",
  },
  {
    entityType: "customer",
    status: "outreach",
    stepKey: "meeting_booked",
    title: "Meeting booked",
    required: true,
    ownerAgent: "booker",
  },
  // 3. Discovery
  {
    entityType: "customer",
    status: "discovery",
    stepKey: "brief_ready",
    title: "Brief ready",
    required: true,
    ownerAgent: "briefer",
  },
  {
    entityType: "customer",
    status: "discovery",
    stepKey: "statement_requested",
    title: "Statement requested",
    required: true,
    ownerAgent: "recorder",
  },
  {
    entityType: "customer",
    status: "discovery",
    stepKey: "statement_analyzed",
    title: "Statement analyzed",
    required: true,
    ownerAgent: "analyst",
  },
  // 4. Proposal
  {
    entityType: "customer",
    status: "proposal",
    stepKey: "proposal_drafted",
    title: "Proposal drafted",
    required: true,
    ownerAgent: "quoter",
  },
  {
    entityType: "customer",
    status: "proposal",
    stepKey: "proposal_sent",
    title: "Proposal sent",
    required: true,
    ownerAgent: "closer",
  },
  {
    entityType: "customer",
    status: "proposal",
    stepKey: "accepted",
    title: "Accepted",
    required: true,
    ownerAgent: "closer",
  },
  // 5. Application & underwriting
  {
    entityType: "customer",
    status: "application_underwriting",
    stepKey: "application_complete",
    title: "Application complete",
    required: true,
    ownerAgent: "clerk",
  },
  {
    entityType: "customer",
    status: "application_underwriting",
    stepKey: "submitted_to_finix",
    title: "Submitted to Finix",
    required: true,
    ownerAgent: "underwriter",
  },
  {
    entityType: "customer",
    status: "application_underwriting",
    stepKey: "approved",
    title: "Approved",
    required: true,
    ownerAgent: "underwriter",
  },
  // 6. Contracting
  {
    entityType: "customer",
    status: "contracting",
    stepKey: "agreement_signed",
    title: "Agreement signed",
    required: true,
    ownerAgent: "signer",
  },
  // 7. Onboarding & go-live
  {
    entityType: "customer",
    status: "onboarding_go_live",
    stepKey: "plan_ready",
    title: "Plan ready",
    required: true,
    ownerAgent: "tailor",
  },
  {
    entityType: "customer",
    status: "onboarding_go_live",
    stepKey: "hardware_shipped",
    title: "Hardware shipped",
    required: false,
    ownerAgent: "outfitter",
    condition: { field: "hardware_needed" },
  },
  {
    entityType: "customer",
    status: "onboarding_go_live",
    stepKey: "live_ready",
    title: "Live-ready",
    required: true,
    ownerAgent: "integrator",
  },
  {
    entityType: "customer",
    status: "onboarding_go_live",
    stepKey: "first_dollar_processed",
    title: "First dollar processed",
    required: true,
    ownerAgent: "activator",
  },
];

/** Installs the default pipeline templates. Idempotent — existing
 *  (entity_type, status, step_key) rows are skipped so re-seeding after an
 *  edit never stomps operator changes; a deleted row is re-created. */
export function seedStageTemplates(
  db: WorkspaceDb,
  organizationId: string,
  actorId?: string | null
) {
  const created: StageTemplate[] = [];
  let skipped = 0;
  for (const def of DEFAULT_STAGE_TEMPLATES) {
    const existing = db
      .select({ id: workspaceStageTemplates.id })
      .from(workspaceStageTemplates)
      .where(
        and(
          eq(workspaceStageTemplates.organizationId, organizationId),
          eq(workspaceStageTemplates.entityType, def.entityType),
          eq(workspaceStageTemplates.status, stageKey(def.status)),
          eq(workspaceStageTemplates.stepKey, stageKey(def.stepKey))
        )
      )
      .get();
    if (existing) {
      skipped += 1;
      continue;
    }
    created.push(
      createStageTemplate(db, {
        organizationId,
        entityType: def.entityType,
        status: def.status,
        stepKey: def.stepKey,
        title: def.title,
        required: def.required,
        ownerAgent: def.ownerAgent,
        condition: def.condition ?? null,
        position: created.length + skipped,
        createdBy: actorId ?? null,
      })
    );
  }
  return { created, skipped };
}

/** Re-point still-waiting dependents of a dead session onto its retry —
 *  called wherever a replacement lane is created so a queuedAfter chain
 *  survives redispatch instead of promoting off the corpse (PILE-260). */
export async function reanchorQueuedDependents(
  db: WorkspaceDb,
  organizationId: string,
  fromSessionId: string,
  toSessionId: string
) {
  await db
    .update(workspaceAgentSessions)
    .set({
      queuedAfter: toSessionId,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(workspaceAgentSessions.organizationId, organizationId),
        eq(workspaceAgentSessions.status, "waiting"),
        eq(workspaceAgentSessions.queuedAfter, fromSessionId)
      )
    );
}

/** Direct children of a session (agent-spawned lanes). */
export function listChildAgentSessions(
  db: WorkspaceDb,
  organizationId: string,
  parentSessionId: string
) {
  return db
    .select()
    .from(workspaceAgentSessions)
    .where(
      and(
        eq(workspaceAgentSessions.organizationId, organizationId),
        eq(workspaceAgentSessions.parentSessionId, parentSessionId)
      )
    )
    .orderBy(workspaceAgentSessions.createdAt)
    .all();
}

/** Non-terminal sessions in the whole spawn tree rooted at rootSessionId —
 *  breadth-first walk over parentSessionId. Caps bound total descendant
 *  lanes regardless of which level spawns them. */
export async function countActiveDescendantSessions(
  db: WorkspaceDb,
  organizationId: string,
  rootSessionId: string
): Promise<number> {
  const terminal = new Set<AgentSessionStatus>([
    "completed",
    "failed",
    "canceled",
  ]);
  const rows = await db
    .select({
      id: workspaceAgentSessions.id,
      parentSessionId: workspaceAgentSessions.parentSessionId,
      status: workspaceAgentSessions.status,
    })
    .from(workspaceAgentSessions)
    .where(eq(workspaceAgentSessions.organizationId, organizationId))
    .all();
  const childrenByParent = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.parentSessionId) continue;
    const list = childrenByParent.get(row.parentSessionId) ?? [];
    list.push(row);
    childrenByParent.set(row.parentSessionId, list);
  }
  let active = 0;
  const queue = [rootSessionId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const parent = queue.shift();
    if (!parent || seen.has(parent)) continue;
    seen.add(parent);
    for (const child of childrenByParent.get(parent) ?? []) {
      if (!terminal.has(child.status as AgentSessionStatus)) active += 1;
      queue.push(child.id);
    }
  }
  return active;
}

export interface AgentActivityInput {
  sessionId: string;
  actorId?: string;
  type:
    | "thought"
    | "response"
    | "error"
    | "elicitation"
    | "prompt"
    | "action"
    | "status"
    | "artifact";
  message: string;
  payload?: Record<string, unknown>;
  /** Parent activity id — links child events under a span. */
  parentId?: string;
  /** PILE-418 — system-side bookkeeping (dispatch status lines, stale
   *  markers) doesn't count as the lane's first ack. */
  system?: boolean;
  /** Span timing. `startedAt` alone marks an open span; pair with `endedAt`
   *  (or `durationMs`) to record a completed span. */
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

export async function addAgentActivity(
  db: WorkspaceDb,
  input: AgentActivityInput
) {
  const id = crypto.randomUUID();
  const ts = new Date().toISOString();
  const startedAt = input.startedAt ?? null;
  const endedAt = input.endedAt ?? null;
  const durationMs =
    input.durationMs ??
    (startedAt && endedAt
      ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt))
      : null);
  await db.insert(workspaceAgentActivities).values({
    id,
    sessionId: input.sessionId,
    actorId: input.actorId ?? null,
    type: input.type,
    message: input.message,
    payload: input.payload ? JSON.stringify(input.payload) : null,
    parentId: input.parentId ?? null,
    startedAt,
    endedAt,
    durationMs,
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
  await db
    .update(workspaceAgentSessions)
    .set({ lastProgressAt: ts, updatedAt: ts })
    .where(eq(workspaceAgentSessions.id, input.sessionId));
  return row;
}

export function getAgentActivity(db: WorkspaceDb, id: string) {
  return db
    .select()
    .from(workspaceAgentActivities)
    .where(eq(workspaceAgentActivities.id, id))
    .get();
}

export function listAgentActivities(
  db: WorkspaceDb,
  sessionId: string,
  options: { limit?: number; order?: "asc" | "desc" } = {}
) {
  return db
    .select()
    .from(workspaceAgentActivities)
    .where(eq(workspaceAgentActivities.sessionId, sessionId))
    .orderBy(
      options.order === "desc"
        ? desc(workspaceAgentActivities.createdAt)
        : workspaceAgentActivities.createdAt
    )
    .limit(options.limit ?? 100)
    .all();
}

/** Close an open span: stamps ended_at and computes duration_ms from
 *  started_at. No-op when the activity is missing or not a span. */
export async function closeAgentActivity(db: WorkspaceDb, id: string) {
  const row = await db
    .select()
    .from(workspaceAgentActivities)
    .where(eq(workspaceAgentActivities.id, id))
    .get();
  if (!row?.startedAt) return null;
  const endedAt = new Date().toISOString();
  const durationMs = Math.max(
    0,
    Date.parse(endedAt) - Date.parse(row.startedAt)
  );
  await db
    .update(workspaceAgentActivities)
    .set({ endedAt, durationMs })
    .where(eq(workspaceAgentActivities.id, id));
  return { ...row, endedAt, durationMs };
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
  options: { afterId?: number; limit?: number; order?: "asc" | "desc" } = {}
) {
  const conditions = [eq(workspaceAgentSessionEvents.sessionId, sessionId)];
  if (options.afterId !== undefined) {
    conditions.push(gt(workspaceAgentSessionEvents.id, options.afterId));
  }
  return db
    .select()
    .from(workspaceAgentSessionEvents)
    .where(and(...conditions))
    .orderBy(
      options.order === "desc"
        ? desc(workspaceAgentSessionEvents.id)
        : workspaceAgentSessionEvents.id
    )
    .limit(options.limit ?? 100)
    .all();
}

/** One chronological stream for a lane: activity spans (thoughts,
 *  responses, elicitations) interleaved with lifecycle events
 *  (pr.review, pr.ci_failed, prompt.followup, ...). The single
 *  developer-facing timeline — dedupe and delivery evidence live here.
 *  Returns the most recent `limit` entries, oldest first (PILE-269): a
 *  head-of-stream window froze long lanes at their first 100 entries, so
 *  post-terminal pr.conflict / nudge events never showed up. */
export function listAgentTimeline(
  db: WorkspaceDb,
  sessionId: string,
  options: { limit?: number } = {}
) {
  const limit = options.limit ?? 100;
  const [activities, events] = [
    listAgentActivities(db, sessionId, { limit, order: "desc" }),
    listAgentSessionEvents(db, sessionId, { limit, order: "desc" }),
  ];
  const merged = [
    ...activities.map((row) =>
      Object.assign({ kind: "activity" as const }, row)
    ),
    ...events.map((row) => Object.assign({ kind: "event" as const }, row)),
  ];
  merged.sort((a, b) => {
    const t = a.createdAt.localeCompare(b.createdAt);
    if (t !== 0) return t;
    const ai = typeof a.id === "number" ? a.id : 0;
    const bi = typeof b.id === "number" ? b.id : 0;
    return ai - bi;
  });
  return merged.slice(-limit);
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
  // Review side lanes (PILE-273) never own the issue.
  // Triage lanes (PILE-282) only report on the issue — they never own it, so
  // they must not block a real lane from dispatching.
  const active = sessions.find(
    (s) =>
      !["review", "triage"].includes(s.purpose ?? "") &&
      !["completed", "failed", "canceled"].includes(s.status)
  );
  if (!active) return null;
  const activities = await listAgentActivities(db, active.id, { limit: 50 });
  return { session: active, activities };
}

// ---- agent automations (PILE-211) ----

export interface AgentAutomationInput {
  name: string;
  prompt: string;
  agentId: string;
  teamId?: string | null;
  issueId?: string | null;
  triggerKind: "cron" | "event";
  triggerValue: string;
  enabled?: boolean;
  createdBy?: string | null;
}

export async function createAgentAutomation(
  db: WorkspaceDb,
  organizationId: string,
  input: AgentAutomationInput
) {
  const id = crypto.randomUUID();
  await db.insert(workspaceAgentAutomations).values({
    id,
    organizationId,
    name: input.name,
    prompt: input.prompt,
    agentId: input.agentId,
    teamId: input.teamId ?? null,
    issueId: input.issueId ?? null,
    triggerKind: input.triggerKind,
    triggerValue: input.triggerValue,
    enabled: input.enabled === false ? 0 : 1,
    createdBy: input.createdBy ?? null,
    createdAt: new Date().toISOString(),
  });
  return db
    .select()
    .from(workspaceAgentAutomations)
    .where(eq(workspaceAgentAutomations.id, id))
    .get();
}

export function listAgentAutomations(
  db: WorkspaceDb,
  organizationId: string,
  options: { enabledOnly?: boolean; triggerKind?: "cron" | "event" } = {}
) {
  const conditions = [
    eq(workspaceAgentAutomations.organizationId, organizationId),
  ];
  if (options.enabledOnly) {
    conditions.push(eq(workspaceAgentAutomations.enabled, 1));
  }
  if (options.triggerKind) {
    conditions.push(
      eq(workspaceAgentAutomations.triggerKind, options.triggerKind)
    );
  }
  return db
    .select()
    .from(workspaceAgentAutomations)
    .where(and(...conditions))
    .orderBy(workspaceAgentAutomations.createdAt)
    .all();
}

export function getAgentAutomation(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceAgentAutomations)
    .where(
      and(
        eq(workspaceAgentAutomations.organizationId, organizationId),
        eq(workspaceAgentAutomations.id, id)
      )
    )
    .get();
}

/** PILE-414 — board chip: per-parent {done, total, blocked, owner} over
 *  required step-keyed sub-issues, one grouped query. "Done" matches the
 *  stage gate: status done, or canceled with resolution=skipped. */
export function subStepProgressByParent(
  db: WorkspaceDb,
  organizationId: string,
  parentIds: string[]
): Map<
  string,
  { total: number; done: number; blocked: number; ownerAgent: string | null }
> {
  const out = new Map<
    string,
    { total: number; done: number; blocked: number; ownerAgent: string | null }
  >();
  if (parentIds.length === 0) return out;
  const rows = db
    .select()
    .from(workspaceIssues)
    .where(
      and(
        eq(workspaceIssues.organizationId, organizationId),
        inArrayJson(workspaceIssues.parentId, parentIds),
        eq(workspaceIssues.required, true)
      )
    )
    .all();
  for (const row of rows) {
    const parent = row.parentId as string;
    const acc = out.get(parent) ?? {
      total: 0,
      done: 0,
      blocked: 0,
      ownerAgent: null,
    };
    acc.total += 1;
    const satisfied =
      row.status === "done" ||
      (row.status === "canceled" && row.resolution === "skipped");
    if (satisfied) {
      acc.done += 1;
    } else {
      acc.blocked += 1;
      if (acc.ownerAgent === null) acc.ownerAgent = row.ownerAgent;
    }
    out.set(parent, acc);
  }
  return out;
}

export async function markAgentAutomationFired(db: WorkspaceDb, id: string) {
  await db
    .update(workspaceAgentAutomations)
    .set({ lastFiredAt: new Date().toISOString() })
    .where(eq(workspaceAgentAutomations.id, id));
}

export async function deleteAgentAutomation(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  const existing = await getAgentAutomation(db, organizationId, id);
  if (!existing) return false;
  await db
    .delete(workspaceAgentAutomations)
    .where(eq(workspaceAgentAutomations.id, id));
  return true;
}

// ---- pipeline runtime: domain events, stage configs, agent types ----
// (PILE-401/405/413)

export type DomainEventType =
  | "record.stage_entered"
  | "substep.actionable"
  | "substeps.all_required_done"
  | "substep.review";
export type DomainEvent = typeof workspaceDomainEvents.$inferSelect;
export type StageConfig = typeof workspaceStageConfigs.$inferSelect;
export type AgentType = typeof workspaceAgentTypes.$inferSelect;

/** Append an outbox event; `dedupeKey` makes the write idempotent — the same
 *  logical event can be emitted twice (e.g. a retried transition) without
 *  double-dispatching. */
export async function emitDomainEvent(
  db: WorkspaceDb,
  organizationId: string,
  input: {
    type: DomainEventType;
    payload: Record<string, unknown>;
    dedupeKey?: string;
  }
): Promise<DomainEvent | undefined> {
  const id = crypto.randomUUID();
  const dedupeKey = input.dedupeKey ?? null;
  if (dedupeKey) {
    const existing = db
      .select({ id: workspaceDomainEvents.id })
      .from(workspaceDomainEvents)
      .where(
        and(
          eq(workspaceDomainEvents.organizationId, organizationId),
          eq(workspaceDomainEvents.type, input.type),
          eq(workspaceDomainEvents.dedupeKey, dedupeKey)
        )
      )
      .get();
    if (existing) return undefined;
  }
  await db.insert(workspaceDomainEvents).values({
    id,
    organizationId,
    type: input.type,
    payload: JSON.stringify(input.payload),
    dedupeKey,
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
  });
  return db
    .select()
    .from(workspaceDomainEvents)
    .where(eq(workspaceDomainEvents.id, id))
    .get();
}

export function listPendingDomainEvents(
  db: WorkspaceDb,
  organizationId: string
) {
  return db
    .select()
    .from(workspaceDomainEvents)
    .where(
      and(
        eq(workspaceDomainEvents.organizationId, organizationId),
        eq(workspaceDomainEvents.status, "pending")
      )
    )
    .orderBy(workspaceDomainEvents.createdAt)
    .all();
}

export async function markDomainEvent(
  db: WorkspaceDb,
  id: string,
  status: "delivered" | "failed",
  error?: string
) {
  await db
    .update(workspaceDomainEvents)
    .set({
      status,
      error: error ?? null,
      attempts: sql`${workspaceDomainEvents.attempts} + 1`,
      deliveredAt: status === "delivered" ? new Date().toISOString() : null,
    })
    .where(eq(workspaceDomainEvents.id, id));
}

export interface StageConfigInput {
  entityType?: "issue" | "deal" | "customer";
  status: string;
  ownerAgent?: string | null;
  instructions?: string | null;
  advancePolicy?: "none" | "auto" | "ready_flag";
  enabled?: boolean;
  createdBy?: string | null;
}

/** Upsert keyed on (entityType, status) — a stage has one owning config. */
export async function upsertStageConfig(
  db: WorkspaceDb,
  organizationId: string,
  input: StageConfigInput
): Promise<StageConfig> {
  const statusKey = stageKey(input.status);
  const entityType = input.entityType ?? "issue";
  const existing = db
    .select()
    .from(workspaceStageConfigs)
    .where(
      and(
        eq(workspaceStageConfigs.organizationId, organizationId),
        eq(workspaceStageConfigs.entityType, entityType),
        eq(workspaceStageConfigs.status, statusKey)
      )
    )
    .get();
  const now = new Date().toISOString();
  if (existing) {
    await db
      .update(workspaceStageConfigs)
      .set({
        ownerAgent: input.ownerAgent ?? existing.ownerAgent,
        instructions: input.instructions ?? existing.instructions,
        advancePolicy: input.advancePolicy ?? existing.advancePolicy,
        enabled:
          input.enabled === undefined
            ? existing.enabled
            : input.enabled
              ? 1
              : 0,
        updatedAt: now,
      })
      .where(eq(workspaceStageConfigs.id, existing.id));
    return db
      .select()
      .from(workspaceStageConfigs)
      .where(eq(workspaceStageConfigs.id, existing.id))
      .get() as StageConfig;
  }
  const id = crypto.randomUUID();
  const row: typeof workspaceStageConfigs.$inferInsert = {
    id,
    organizationId,
    entityType,
    status: statusKey,
    ownerAgent: input.ownerAgent ?? null,
    instructions: input.instructions ?? null,
    advancePolicy: input.advancePolicy ?? "none",
    enabled: input.enabled === false ? 0 : 1,
    createdBy: input.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(workspaceStageConfigs).values(row);
  return db
    .select()
    .from(workspaceStageConfigs)
    .where(eq(workspaceStageConfigs.id, id))
    .get() as StageConfig;
}

export function getStageConfigById(
  db: WorkspaceDb,
  organizationId: string,
  id: string
): StageConfig | undefined {
  return db
    .select()
    .from(workspaceStageConfigs)
    .where(
      and(
        eq(workspaceStageConfigs.organizationId, organizationId),
        eq(workspaceStageConfigs.id, id)
      )
    )
    .get();
}

/** PILE-437 — partial update by id (the upsert keys on entityType+status,
 *  which makes targeted edits awkward for callers holding an id). */
export async function updateStageConfig(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  patch: Partial<Omit<StageConfigInput, "entityType" | "status">>
): Promise<StageConfig | undefined> {
  const existing = getStageConfigById(db, organizationId, id);
  if (!existing) return undefined;
  const set: Partial<typeof workspaceStageConfigs.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };
  if (patch.ownerAgent !== undefined) set.ownerAgent = patch.ownerAgent;
  if (patch.instructions !== undefined) set.instructions = patch.instructions;
  if (patch.advancePolicy !== undefined)
    set.advancePolicy = patch.advancePolicy;
  if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
  await db
    .update(workspaceStageConfigs)
    .set(set)
    .where(eq(workspaceStageConfigs.id, id));
  return getStageConfigById(db, organizationId, id);
}

export function getStageConfig(
  db: WorkspaceDb,
  organizationId: string,
  entityType: "issue" | "deal" | "customer",
  status: string
): StageConfig | undefined {
  return db
    .select()
    .from(workspaceStageConfigs)
    .where(
      and(
        eq(workspaceStageConfigs.organizationId, organizationId),
        eq(workspaceStageConfigs.entityType, entityType),
        eq(workspaceStageConfigs.status, stageKey(status)),
        eq(workspaceStageConfigs.enabled, 1)
      )
    )
    .get();
}

export function listStageConfigs(db: WorkspaceDb, organizationId: string) {
  return db
    .select()
    .from(workspaceStageConfigs)
    .where(eq(workspaceStageConfigs.organizationId, organizationId))
    .orderBy(workspaceStageConfigs.createdAt)
    .all();
}

export async function deleteStageConfig(
  db: WorkspaceDb,
  organizationId: string,
  id: string
): Promise<boolean> {
  const existing = db
    .select({ id: workspaceStageConfigs.id })
    .from(workspaceStageConfigs)
    .where(
      and(
        eq(workspaceStageConfigs.organizationId, organizationId),
        eq(workspaceStageConfigs.id, id)
      )
    )
    .get();
  if (!existing) return false;
  await db
    .delete(workspaceStageConfigs)
    .where(eq(workspaceStageConfigs.id, id));
  return true;
}

export interface AgentTypeInput {
  slug: string;
  name: string;
  providerAgentId: string;
  jobSpec?: string | null;
  /** System prompt the profile runs with. */
  prompt?: string | null;
  /** Model tier or id — e.g. "claude-sonnet" or a Workers AI model. */
  model?: string | null;
  /** JSON allowlist of tool names the profile may call. */
  tools?: string | null;
  /** "agent" (default) runs a provider lane; "human" resolves the owner
   *  slug for lint but is never dispatched; "external" POSTs a webhook to
   *  endpointUrl instead of launching a lane. */
  kind?: "agent" | "human" | "external";
  /** Webhook URL for kind="external" owners. */
  endpointUrl?: string | null;
  /** Bearer the receiver verifies — write-only; the DO encrypts it at
   *  rest before it reaches this layer. */
  endpointSecret?: string | null;
  toolScope?: string | null;
  permissionsTier?: string | null;
  enabled?: boolean;
  createdBy?: string | null;
}

/** Upsert keyed on slug — registry rows are workspace-scoped. */
export async function upsertAgentType(
  db: WorkspaceDb,
  organizationId: string,
  input: AgentTypeInput
): Promise<AgentType> {
  const slug = stageKey(input.slug);
  const existing = db
    .select()
    .from(workspaceAgentTypes)
    .where(
      and(
        eq(workspaceAgentTypes.organizationId, organizationId),
        eq(workspaceAgentTypes.slug, slug)
      )
    )
    .get();
  const now = new Date().toISOString();
  if (existing) {
    await db
      .update(workspaceAgentTypes)
      .set({
        name: input.name,
        providerAgentId: input.providerAgentId,
        jobSpec: input.jobSpec ?? existing.jobSpec,
        prompt: input.prompt ?? existing.prompt,
        model: input.model ?? existing.model,
        tools: input.tools ?? existing.tools,
        kind: input.kind ?? existing.kind,
        endpointUrl: input.endpointUrl ?? existing.endpointUrl,
        endpointSecret: input.endpointSecret ?? existing.endpointSecret,
        toolScope: input.toolScope ?? existing.toolScope,
        permissionsTier: input.permissionsTier ?? existing.permissionsTier,
        enabled:
          input.enabled === undefined
            ? existing.enabled
            : input.enabled
              ? 1
              : 0,
        updatedAt: now,
      })
      .where(eq(workspaceAgentTypes.id, existing.id));
    return db
      .select()
      .from(workspaceAgentTypes)
      .where(eq(workspaceAgentTypes.id, existing.id))
      .get() as AgentType;
  }
  const id = crypto.randomUUID();
  await db.insert(workspaceAgentTypes).values({
    id,
    organizationId,
    slug,
    name: input.name,
    providerAgentId: input.providerAgentId,
    jobSpec: input.jobSpec ?? null,
    prompt: input.prompt ?? null,
    model: input.model ?? null,
    tools: input.tools ?? null,
    kind: input.kind ?? "agent",
    endpointUrl: input.endpointUrl ?? null,
    endpointSecret: input.endpointSecret ?? null,
    toolScope: input.toolScope ?? null,
    permissionsTier: input.permissionsTier ?? null,
    enabled: input.enabled === false ? 0 : 1,
    createdBy: input.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return db
    .select()
    .from(workspaceAgentTypes)
    .where(eq(workspaceAgentTypes.id, id))
    .get() as AgentType;
}

export function getAgentTypeBySlug(
  db: WorkspaceDb,
  organizationId: string,
  slug: string
): AgentType | undefined {
  return db
    .select()
    .from(workspaceAgentTypes)
    .where(
      and(
        eq(workspaceAgentTypes.organizationId, organizationId),
        eq(workspaceAgentTypes.slug, stageKey(slug)),
        eq(workspaceAgentTypes.enabled, 1)
      )
    )
    .get();
}

export function listAgentTypes(db: WorkspaceDb, organizationId: string) {
  return db
    .select()
    .from(workspaceAgentTypes)
    .where(eq(workspaceAgentTypes.organizationId, organizationId))
    .orderBy(workspaceAgentTypes.slug)
    .all();
}

export function getAgentTypeById(
  db: WorkspaceDb,
  organizationId: string,
  id: string
): AgentType | undefined {
  return db
    .select()
    .from(workspaceAgentTypes)
    .where(
      and(
        eq(workspaceAgentTypes.organizationId, organizationId),
        eq(workspaceAgentTypes.id, id)
      )
    )
    .get();
}

/** PILE-437 — partial update by id (upsert keys on slug; PATCH-by-id is
 *  the friendlier contract for a registry entry). */
export async function updateAgentType(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  patch: Partial<AgentTypeInput>
): Promise<AgentType | undefined> {
  const existing = getAgentTypeById(db, organizationId, id);
  if (!existing) return undefined;
  const set: Partial<typeof workspaceAgentTypes.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };
  if (patch.slug !== undefined) set.slug = stageKey(patch.slug);
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.providerAgentId !== undefined)
    set.providerAgentId = patch.providerAgentId;
  if (patch.jobSpec !== undefined) set.jobSpec = patch.jobSpec;
  if (patch.prompt !== undefined) set.prompt = patch.prompt;
  if (patch.model !== undefined) set.model = patch.model;
  if (patch.tools !== undefined) set.tools = patch.tools;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.endpointUrl !== undefined) set.endpointUrl = patch.endpointUrl;
  if (patch.endpointSecret !== undefined)
    set.endpointSecret = patch.endpointSecret;
  if (patch.toolScope !== undefined) set.toolScope = patch.toolScope;
  if (patch.permissionsTier !== undefined)
    set.permissionsTier = patch.permissionsTier;
  if (patch.enabled !== undefined) set.enabled = patch.enabled ? 1 : 0;
  await db
    .update(workspaceAgentTypes)
    .set(set)
    .where(eq(workspaceAgentTypes.id, id));
  return getAgentTypeById(db, organizationId, id);
}

export async function deleteAgentType(
  db: WorkspaceDb,
  organizationId: string,
  id: string
): Promise<boolean> {
  const existing = db
    .select({ id: workspaceAgentTypes.id })
    .from(workspaceAgentTypes)
    .where(
      and(
        eq(workspaceAgentTypes.organizationId, organizationId),
        eq(workspaceAgentTypes.id, id)
      )
    )
    .get();
  if (!existing) return false;
  await db.delete(workspaceAgentTypes).where(eq(workspaceAgentTypes.id, id));
  return true;
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
  computeApiKey?: string | null;
  computeApiUrl?: string | null;
  computeSnapshot?: string | null;
  computeVolumeId?: string | null;
  config?: Record<string, unknown> | null;
  teamIds?: string | string[] | null;
}

export interface LaneCostInput {
  sessionId: string;
  agentSlug?: string | null;
  issueId?: string | null;
  provider?: string | null;
  effort?: string | null;
  status: string;
  createdAt: string;
  settledAt: string;
  durationMs: number;
  attempts?: number;
}

export async function recordLaneCost(
  db: WorkspaceDb,
  organizationId: string,
  input: LaneCostInput
) {
  await db
    .insert(workspaceLaneCosts)
    .values({
      sessionId: input.sessionId,
      organizationId,
      agentSlug: input.agentSlug ?? null,
      issueId: input.issueId ?? null,
      provider: input.provider ?? null,
      effort: input.effort ?? null,
      status: input.status,
      createdAt: input.createdAt,
      settledAt: input.settledAt,
      durationMs: input.durationMs,
      attempts: input.attempts ?? 1,
    })
    .onConflictDoUpdate({
      target: workspaceLaneCosts.sessionId,
      set: {
        status: input.status,
        settledAt: input.settledAt,
        durationMs: input.durationMs,
      },
    });
}

export async function listLaneCosts(
  db: WorkspaceDb,
  organizationId: string,
  args: { agentSlug?: string; since?: string; limit?: number } = {}
) {
  const conds = [eq(workspaceLaneCosts.organizationId, organizationId)];
  if (args.agentSlug)
    conds.push(eq(workspaceLaneCosts.agentSlug, args.agentSlug));
  if (args.since) conds.push(gte(workspaceLaneCosts.settledAt, args.since));
  return db
    .select()
    .from(workspaceLaneCosts)
    .where(and(...conds))
    .orderBy(desc(workspaceLaneCosts.settledAt))
    .limit(args.limit ?? 200)
    .all();
}

export interface MemoryInput {
  entityType: string;
  entityId: string;
  kind: string;
  fact: string;
  sourceSessionId?: string | null;
  sourceAgentSlug?: string | null;
  validUntil?: string | null;
}

export async function memoryRemember(
  db: WorkspaceDb,
  organizationId: string,
  input: MemoryInput
) {
  // Supersede: a new fact of the same kind on the same entity marks the
  // previous row superseded rather than deleting it — contradictions and
  // temporal updates keep the audit trail.
  const prior = await db
    .select({ id: workspaceMemory.id })
    .from(workspaceMemory)
    .where(
      and(
        eq(workspaceMemory.organizationId, organizationId),
        eq(workspaceMemory.entityType, input.entityType),
        eq(workspaceMemory.entityId, input.entityId),
        eq(workspaceMemory.kind, input.kind),
        isNull(workspaceMemory.supersedes)
      )
    )
    .get();
  const id = crypto.randomUUID();
  await db.insert(workspaceMemory).values({
    id,
    organizationId,
    entityType: input.entityType,
    entityId: input.entityId,
    kind: input.kind,
    fact: input.fact,
    sourceSessionId: input.sourceSessionId ?? null,
    sourceAgentSlug: input.sourceAgentSlug ?? null,
    validUntil: input.validUntil ?? null,
    supersedes: prior?.id ?? null,
    createdAt: new Date().toISOString(),
  });
  return id;
}

export async function memoryRecall(
  db: WorkspaceDb,
  organizationId: string,
  query: {
    entityType?: string;
    entityId?: string;
    kind?: string;
    search?: string;
    limit?: number;
  }
) {
  const conds = [
    eq(workspaceMemory.organizationId, organizationId),
    isNull(workspaceMemory.supersedes),
  ];
  if (query.entityType)
    conds.push(eq(workspaceMemory.entityType, query.entityType));
  if (query.entityId) conds.push(eq(workspaceMemory.entityId, query.entityId));
  if (query.kind) conds.push(eq(workspaceMemory.kind, query.kind));
  // Fuzzy fact search — LIKE over the fact text so "did we sweep
  // Smith?" finds corridor:smith-st without the exact entity key.
  if (query.search) conds.push(like(workspaceMemory.fact, `%${query.search}%`));
  return db
    .select()
    .from(workspaceMemory)
    .where(and(...conds))
    .orderBy(desc(workspaceMemory.createdAt))
    .limit(query.limit ?? 25)
    .all();
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

export function listAgentEnvironmentFiles(
  db: WorkspaceDb,
  organizationId: string
) {
  return db
    .select()
    .from(workspaceAgentEnvironmentFiles)
    .where(eq(workspaceAgentEnvironmentFiles.organizationId, organizationId))
    .orderBy(workspaceAgentEnvironmentFiles.path)
    .all();
}

export function getAgentEnvironmentFile(
  db: WorkspaceDb,
  organizationId: string,
  path: string
) {
  return db
    .select()
    .from(workspaceAgentEnvironmentFiles)
    .where(
      and(
        eq(workspaceAgentEnvironmentFiles.organizationId, organizationId),
        eq(workspaceAgentEnvironmentFiles.path, path)
      )
    )
    .get();
}

export async function upsertAgentEnvironmentFile(
  db: WorkspaceDb,
  organizationId: string,
  path: string,
  content: string
) {
  const existing = await getAgentEnvironmentFile(db, organizationId, path);
  const now = new Date().toISOString();
  if (existing) {
    await db
      .update(workspaceAgentEnvironmentFiles)
      .set({ content, updatedAt: now })
      .where(eq(workspaceAgentEnvironmentFiles.id, existing.id));
    return getAgentEnvironmentFile(db, organizationId, path);
  }
  const id = crypto.randomUUID();
  await db.insert(workspaceAgentEnvironmentFiles).values({
    id,
    organizationId,
    path,
    content,
    createdAt: now,
    updatedAt: now,
  });
  return getAgentEnvironmentFile(db, organizationId, path);
}

export async function deleteAgentEnvironmentFile(
  db: WorkspaceDb,
  organizationId: string,
  path: string
) {
  const existing = await getAgentEnvironmentFile(db, organizationId, path);
  if (!existing) return false;
  await db
    .delete(workspaceAgentEnvironmentFiles)
    .where(eq(workspaceAgentEnvironmentFiles.id, existing.id));
  return true;
}

// ---- documents ----

export interface DocumentInput {
  organizationId: string;
  title: string;
  icon?: string | null;
  content?: unknown[] | string; // BlockNote blocks or markdown
  contentFormat?: "blocks" | "markdown" | "canvas";
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

/** Spaces where contained documents are deny-by-default (PILE-409). */
export function restrictedSpaceIds(db: WorkspaceDb, organizationId: string) {
  return new Set(
    db
      .select({ id: workspaceDocumentSpaces.id })
      .from(workspaceDocumentSpaces)
      .where(
        and(
          eq(workspaceDocumentSpaces.organizationId, organizationId),
          eq(workspaceDocumentSpaces.restricted, true)
        )
      )
      .all()
      .map((s) => s.id)
  );
}

/** List scope: open docs plus docs the actor is granted on —
 * restricted docs disappear from the list for ungranted members. */
export function listDocumentsVisibleTo(
  db: WorkspaceDb,
  organizationId: string,
  actorId: string,
  teamIds: string[] = [],
  args: ListDocumentsArgs = {}
) {
  const all = listDocuments(db, organizationId, args);
  const grants = db
    .select()
    .from(workspaceDocumentPermissions)
    .where(eq(workspaceDocumentPermissions.organizationId, organizationId))
    .all();
  const restricted = new Set(grants.map((g) => g.documentId));
  const restrictedSpaces = restrictedSpaceIds(db, organizationId);
  const actorSet = new Set([actorId, ...teamIds]);
  const granted = new Set(
    grants.filter((g) => actorSet.has(g.actorId)).map((g) => g.documentId)
  );
  // Space grants open only docs with NO doc-level ACL — a granted doc is a
  // closed ACL the space grant cannot widen.
  const spaceGranted = new Set<string>();
  for (const row of db
    .select({
      spaceId: workspaceSpacePermissions.spaceId,
      actorId: workspaceSpacePermissions.actorId,
    })
    .from(workspaceSpacePermissions)
    .where(eq(workspaceSpacePermissions.organizationId, organizationId))
    .all()) {
    if (actorSet.has(row.actorId)) spaceGranted.add(row.spaceId);
  }
  return all.filter(
    (d) =>
      !(
        restricted.has(d.id) ||
        (d.spaceId && restrictedSpaces.has(d.spaceId))
      ) ||
      granted.has(d.id) ||
      (!restricted.has(d.id) &&
        d.spaceId != null &&
        spaceGranted.has(d.spaceId))
  );
}

/** Guest-scope: docs visible iff the actor holds an explicit grant —
 * default-deny, matching "shared with me" semantics. */
export function listDocumentsForActor(
  db: WorkspaceDb,
  organizationId: string,
  actorId: string,
  args: ListDocumentsArgs = {}
) {
  const all = listDocuments(db, organizationId, args);
  const grants = db
    .select({
      documentId: workspaceDocumentPermissions.documentId,
      actorId: workspaceDocumentPermissions.actorId,
      actorType: workspaceDocumentPermissions.actorType,
    })
    .from(workspaceDocumentPermissions)
    .where(eq(workspaceDocumentPermissions.organizationId, organizationId))
    .all();
  const visible = new Set(
    grants.filter((g) => g.actorId === actorId).map((g) => g.documentId)
  );
  // Space grants widen guests the same way — only docs with no doc ACL.
  const granted = new Set(grants.map((g) => g.documentId));
  const spaceGranted = new Set<string>();
  for (const row of db
    .select({
      spaceId: workspaceSpacePermissions.spaceId,
      actorId: workspaceSpacePermissions.actorId,
    })
    .from(workspaceSpacePermissions)
    .where(eq(workspaceSpacePermissions.organizationId, organizationId))
    .all()) {
    if (row.actorId === actorId) spaceGranted.add(row.spaceId);
  }
  // Team grants resolve caller-side (the API layer supplies teamIds).
  return all.filter(
    (d) =>
      visible.has(d.id) ||
      (!granted.has(d.id) && d.spaceId != null && spaceGranted.has(d.spaceId))
  );
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
  contentFormat?: "blocks" | "markdown" | "canvas";
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
    const resolvedFormat: "blocks" | "markdown" | "canvas" =
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
  ip?: string | null;
  country?: string | null;
  userAgent?: string | null;
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
      ip: input.ip ?? null,
      country: input.country ?? null,
      userAgent: input.userAgent ?? null,
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
    // Restricted issues the caller isn't granted — their entries carry
    // field diffs (titles) and stay out of the feed.
    excludeIssueCondition?: SQL;
  } = {}
) {
  const conditions = [eq(workspaceAuditLog.organizationId, organizationId)];
  if (args.entityType !== undefined) {
    conditions.push(eq(workspaceAuditLog.entityType, args.entityType));
  }
  if (args.excludeIssueCondition) {
    const hiddenFilter = or(
      ne(workspaceAuditLog.entityType, "issue"),
      args.excludeIssueCondition
    );
    if (hiddenFilter) {
      conditions.push(hiddenFilter);
    }
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
    // `email` only counts as a choice when the caller passes it — a row
    // created to toggle inApp/mutedTypes stays unset so the DO's
    // default-on types still reach the member.
    emailExplicit:
      input.email !== undefined ? true : (existing?.emailExplicit ?? false),
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
  bookingUrl?: string | null;
  notes?: string | null;
  domain?: string | null;
  externalId?: string | null;
  phone?: string | null;
  address?: string | null;
  vertical?: string | null;
  neighborhood?: string | null;
  source?: string | null;
  sourceSessionId?: string | null;
  sourceAgentSlug?: string | null;
  readiness?: string | null;
  nextAction?: string | null;
  fit?: string | null;
  fitScore?: number | null;
  fitStatus?: string | null;
  processor?: string | null;
  evidenceUri?: string | null;
  tierId?: string | null;
  statusId?: string | null;
  ownerId?: string | null;
  nextStepText?: string | null;
  nextStepDueAt?: string | null;
  needsHuman?: boolean | null;
  needsHumanReason?: string | null;
  signal?: string | null;
  signalDate?: string | null;
  priorityScore?: number | null;
  createdAt?: string;
}

/** Canonical domain for dedup — strips scheme, www., ports, trailing
 *  slash, path. "www.cloverclubny.com/" ≡ "cloverclubny.com". */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const host = new URL(
      raw.includes("://") ? raw : `https://${raw}`
    ).hostname.toLowerCase();
    return host.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export function createCustomer(db: WorkspaceDb, input: CustomerInput) {
  // externalId is a hard dedupe key (same contract as issues' externalRef):
  // re-creating with an existing key returns the record instead of
  // duplicating — importers can re-run blindly.
  if (input.externalId) {
    const existing = getCustomerByExternalId(
      db,
      input.organizationId,
      input.externalId
    );
    if (existing) return existing;
  }
  const now = new Date().toISOString();
  return db
    .insert(workspaceCustomers)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      name: input.name,
      url: input.url ?? null,
      logoUrl: input.logoUrl ?? null,
      bookingUrl: input.bookingUrl ?? null,
      notes: input.notes ?? null,
      domain: normalizeDomain(input.domain),
      externalId: input.externalId ?? null,
      phone: input.phone ?? null,
      address: input.address ?? null,
      vertical: input.vertical ?? null,
      neighborhood: input.neighborhood ?? null,
      source: input.source ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      sourceAgentSlug: input.sourceAgentSlug ?? null,
      readiness: input.readiness ?? null,
      nextAction: input.nextAction ?? null,
      fit: input.fit ?? null,
      fitScore: input.fitScore ?? null,
      fitStatus: input.fitStatus ?? null,
      processor: input.processor ?? null,
      evidenceUri: input.evidenceUri ?? null,
      tierId: input.tierId ?? null,
      statusId: input.statusId ?? null,
      ownerId: input.ownerId ?? null,
      nextStepText: input.nextStepText ?? null,
      nextStepDueAt: input.nextStepDueAt ?? null,
      needsHuman: input.needsHuman ?? null,
      needsHumanReason: input.needsHumanReason ?? null,
      signal: input.signal ?? null,
      signalDate: input.signalDate ?? null,
      priorityScore: input.priorityScore ?? null,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function getCustomerByExternalId(
  db: WorkspaceDb,
  organizationId: string,
  externalId: string
) {
  return db
    .select()
    .from(workspaceCustomers)
    .where(
      and(
        eq(workspaceCustomers.organizationId, organizationId),
        eq(workspaceCustomers.externalId, externalId)
      )
    )
    .get();
}

export interface ContactInput {
  customerId: string;
  type?: "business_channel" | "named_person";
  role?: string | null;
  channel: "email" | "phone" | "form" | "social" | "other";
  value: string;
  label?: string | null;
  status?: "candidate" | "verified" | "rejected" | "no_contact";
  confidence?: "low" | "medium" | "high";
  source?: string | null;
  evidenceUri?: string | null;
}

/** Dedup on (customer, channel, value) — the same contact found twice is
 *  one row. */
export function upsertCustomerContact(
  db: WorkspaceDb,
  organizationId: string,
  input: ContactInput
) {
  const existing = db
    .select()
    .from(workspaceCustomerContacts)
    .where(
      and(
        eq(workspaceCustomerContacts.organizationId, organizationId),
        eq(workspaceCustomerContacts.customerId, input.customerId),
        eq(workspaceCustomerContacts.channel, input.channel),
        eq(workspaceCustomerContacts.value, input.value)
      )
    )
    .all()[0];
  if (existing) return existing;
  const now = new Date().toISOString();
  return db
    .insert(workspaceCustomerContacts)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      customerId: input.customerId,
      type: input.type ?? "business_channel",
      role: input.role ?? null,
      channel: input.channel,
      value: input.value,
      label: input.label ?? null,
      status: input.status ?? "candidate",
      confidence: input.confidence ?? null,
      source: input.source ?? null,
      evidenceUri: input.evidenceUri ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all()[0];
}

export function listCustomerContacts(
  db: WorkspaceDb,
  organizationId: string,
  customerId: string
) {
  return db
    .select()
    .from(workspaceCustomerContacts)
    .where(
      and(
        eq(workspaceCustomerContacts.organizationId, organizationId),
        eq(workspaceCustomerContacts.customerId, customerId)
      )
    )
    .all();
}

export interface SuppressionInput {
  kind: "email" | "domain" | "placeId" | "phone" | "customerId";
  value: string;
  customerId?: string | null;
  reason?: string | null;
  source?: string | null;
}

export function upsertSuppression(
  db: WorkspaceDb,
  organizationId: string,
  input: SuppressionInput
) {
  const existing = db
    .select()
    .from(workspaceSuppression)
    .where(
      and(
        eq(workspaceSuppression.organizationId, organizationId),
        eq(workspaceSuppression.kind, input.kind),
        eq(workspaceSuppression.value, input.value)
      )
    )
    .all()[0];
  if (existing) return existing;
  return db
    .insert(workspaceSuppression)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      kind: input.kind,
      value: input.value,
      customerId: input.customerId ?? null,
      reason: input.reason ?? null,
      source: input.source ?? null,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .all()[0];
}

export function listSuppression(
  db: WorkspaceDb,
  organizationId: string,
  kind?: string
) {
  const conds = [eq(workspaceSuppression.organizationId, organizationId)];
  if (kind) conds.push(eq(workspaceSuppression.kind, kind));
  return db
    .select()
    .from(workspaceSuppression)
    .where(and(...conds))
    .all();
}

export function isSuppressed(
  db: WorkspaceDb,
  organizationId: string,
  kind: string,
  value: string
) {
  const row = db
    .select()
    .from(workspaceSuppression)
    .where(
      and(
        eq(workspaceSuppression.organizationId, organizationId),
        eq(workspaceSuppression.kind, kind),
        eq(workspaceSuppression.value, value)
      )
    )
    .all()[0];
  return row ?? null;
}

export interface MarketRunInput {
  vertical: string;
  geo: string;
  source: string;
  sourceQuery?: string | null;
  coverageTarget?: number | null;
  issueId?: string | null;
  createdBySlug?: string | null;
  sourceSessionId?: string | null;
}

export function createMarketRun(
  db: WorkspaceDb,
  organizationId: string,
  input: MarketRunInput
) {
  return db
    .insert(workspaceMarketRuns)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      vertical: input.vertical,
      geo: input.geo,
      source: input.source,
      sourceQuery: input.sourceQuery ?? null,
      coverageTarget: input.coverageTarget ?? null,
      issueId: input.issueId ?? null,
      createdBySlug: input.createdBySlug ?? null,
      sourceSessionId: input.sourceSessionId ?? null,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .all()[0];
}

export function updateMarketRun(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  patch: { producedCount?: number; status?: string }
) {
  const updates: Record<string, unknown> = {};
  if (patch.producedCount !== undefined)
    updates.producedCount = patch.producedCount;
  if (patch.status !== undefined) {
    updates.status = patch.status;
    if (patch.status === "completed" || patch.status === "failed")
      updates.completedAt = new Date().toISOString();
  }
  return db
    .update(workspaceMarketRuns)
    .set(updates)
    .where(
      and(
        eq(workspaceMarketRuns.id, id),
        eq(workspaceMarketRuns.organizationId, organizationId)
      )
    )
    .returning()
    .all()[0];
}

export function listMarketRuns(
  db: WorkspaceDb,
  organizationId: string,
  args: {
    vertical?: string;
    geo?: string;
    issueId?: string;
    limit?: number;
  } = {}
) {
  const conds = [eq(workspaceMarketRuns.organizationId, organizationId)];
  if (args.vertical)
    conds.push(eq(workspaceMarketRuns.vertical, args.vertical));
  if (args.geo) conds.push(eq(workspaceMarketRuns.geo, args.geo));
  if (args.issueId) conds.push(eq(workspaceMarketRuns.issueId, args.issueId));
  return db
    .select()
    .from(workspaceMarketRuns)
    .where(and(...conds))
    .orderBy(desc(workspaceMarketRuns.createdAt))
    .limit(args.limit ?? 50)
    .all();
}

export function listCustomers(
  db: WorkspaceDb,
  organizationId: string,
  opts: { cold?: boolean; dueBefore?: string; needsHuman?: boolean } = {}
) {
  const rows = db
    .select()
    .from(workspaceCustomers)
    .where(eq(workspaceCustomers.organizationId, organizationId))
    .all();
  return rows.filter((c) => {
    if (opts.cold && (c.nextStepText !== null || c.nextStepDueAt !== null))
      return false;
    if (
      opts.dueBefore &&
      (c.nextStepDueAt === null || c.nextStepDueAt > opts.dueBefore)
    )
      return false;
    if (opts.needsHuman && c.needsHuman !== true) return false;
    return true;
  });
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
    "bookingUrl",
    "notes",
    "domain",
    "externalId",
    "phone",
    "address",
    "vertical",
    "neighborhood",
    "source",
    "readiness",
    "nextAction",
    "fit",
    "fitScore",
    "fitStatus",
    "evidenceUri",
    "tierId",
    "statusId",
    "ownerId",
    "nextStepText",
    "nextStepDueAt",
    "needsHuman",
    "needsHumanReason",
    "priorityScore",
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
  db.delete(workspaceCustomerContacts)
    .where(
      and(
        eq(workspaceCustomerContacts.customerId, id),
        eq(workspaceCustomerContacts.organizationId, organizationId)
      )
    )
    .run();
  db.delete(workspaceCustomerNeeds)
    .where(
      and(
        eq(workspaceCustomerNeeds.customerId, id),
        eq(workspaceCustomerNeeds.organizationId, organizationId)
      )
    )
    .run();
  db.delete(workspaceEntityAttachments)
    .where(
      and(
        eq(workspaceEntityAttachments.entityType, "customer"),
        eq(workspaceEntityAttachments.entityId, id),
        eq(workspaceEntityAttachments.organizationId, organizationId)
      )
    )
    .run();
  db.delete(workspaceCustomerIntakeItems)
    .where(
      and(
        eq(workspaceCustomerIntakeItems.customerId, id),
        eq(workspaceCustomerIntakeItems.organizationId, organizationId)
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

// ---- bulk customer import (PILE-403) ----
// Scout's write path: a batch of merchant rows → deduped customer records
// (+ optional initial deals) with a durable per-row receipt. Idempotent —
// the same corridor re-run produces zero new records because externalId
// ("gplace:<place_id>" for Places pulls) is a hard dedupe key.

export interface ImportDealSpec {
  name?: string;
  stage?: DealStage;
  amountCents?: number | null;
  currency?: string | null;
  expectedCloseAt?: string | null;
  description?: string | null;
  priorityScore?: number | null;
}

export interface ImportCustomerRow {
  placeId?: string | null;
  externalId?: string | null;
  name: string;
  url?: string | null;
  notes?: string | null;
  /** Customer status *name* — resolved case-insensitively, auto-created
   *  when the pipeline column doesn't exist yet. `statusId` wins when
   *  both are provided. */
  status?: string | null;
  statusId?: string | null;
  tierId?: string | null;
  ownerId?: string | null;
  nextStepText?: string | null;
  nextStepDueAt?: string | null;
  needsHuman?: boolean | null;
  needsHumanReason?: string | null;
  priorityScore?: number | null;
  /** Custom field values keyed by field name — missing definitions are
   *  auto-created as text fields (PILE-383). */
  customFields?: Record<string, string | null>;
  deal?: ImportDealSpec;
}

export interface ImportRowReceipt {
  index: number;
  externalId: string | null;
  outcome: "created" | "existing" | "failed";
  customerId?: string;
  dealId?: string;
  error?: string;
}

export interface ImportReceipt {
  id: string;
  organizationId: string;
  source: string | null;
  corridor: string | null;
  total: number;
  created: number;
  existing: number;
  failed: number;
  rows: ImportRowReceipt[];
  createdById: string | null;
  createdAt: string;
}

export interface ImportReceiptSummary extends Omit<ImportReceipt, "rows"> {}

/** Resolve a customer status by name — importers speak pipeline column
 *  names ("New", "Contacted"), not uuids. A missing name becomes a new
 *  status appended at the end so a corridor file can introduce its own
 *  stages. */
export function resolveCustomerStatusId(
  db: WorkspaceDb,
  organizationId: string,
  name: string
): string {
  const trimmed = name.trim();
  const statuses = listCustomerStatuses(db, organizationId);
  const match =
    // key match first — immutable across renames (PILE-438); fall back to
    // name for rows/imports that still speak display names.
    statuses.find((s) => s.key === stageKey(trimmed)) ??
    statuses.find((s) => s.name === trimmed) ??
    statuses.find((s) => stageKey(s.name) === stageKey(trimmed));
  if (match) return match.id;
  return createCustomerStatus(db, organizationId, {
    name: trimmed,
    position: statuses.length,
  }).id;
}

function importRowDeal(
  db: WorkspaceDb,
  organizationId: string,
  customer: { id: string; name: string },
  externalId: string | null,
  spec: ImportDealSpec
): string {
  // Deals dedupe on the same externalId — a re-run reuses the record
  // instead of minting a second pipeline entry.
  if (externalId) {
    const existing = getDealByExternalId(db, organizationId, externalId);
    if (existing) return existing.id;
  }
  return createDeal(db, {
    organizationId,
    customerId: customer.id,
    name: spec.name ?? customer.name,
    externalId,
    stage: spec.stage ?? "lead",
    amountCents: spec.amountCents ?? null,
    currency: spec.currency ?? null,
    expectedCloseAt: spec.expectedCloseAt ?? null,
    description: spec.description ?? null,
    priorityScore: spec.priorityScore ?? null,
  }).id;
}

export function importCustomers(
  db: WorkspaceDb,
  organizationId: string,
  input: {
    source?: string | null;
    corridor?: string | null;
    rows: ImportCustomerRow[];
    createdById?: string | null;
  }
): ImportReceipt {
  const rows: ImportRowReceipt[] = [];
  let createdCount = 0;
  let existingCount = 0;
  let failedCount = 0;

  input.rows.forEach((row, index) => {
    const externalId = row.placeId
      ? `gplace:${row.placeId}`
      : (row.externalId ?? null);
    try {
      if (typeof row.name !== "string" || row.name.trim() === "") {
        throw new Error("Row requires a name");
      }
      // Validate before any write so a failed row leaves no partial
      // record behind — the re-run can then retry the same place_id.
      if (row.customFields) {
        assertFieldValuesValid(
          db,
          organizationId,
          "customer",
          row.customFields
        );
      }
      let statusId = row.statusId ?? null;
      if (!statusId && row.status) {
        statusId = resolveCustomerStatusId(db, organizationId, row.status);
      }
      let customer = externalId
        ? getCustomerByExternalId(db, organizationId, externalId)
        : undefined;
      let outcome: ImportRowReceipt["outcome"];
      if (customer) {
        outcome = "existing";
        existingCount += 1;
        // Enrich, never clobber: importer-provided scalars only fill
        // slots that are still empty, so a human's edits survive
        // re-runs. Custom fields below always upsert.
        const patch: Partial<Omit<CustomerInput, "organizationId">> = {};
        if (row.url != null && customer.url === null) patch.url = row.url;
        if (row.notes != null && customer.notes === null)
          patch.notes = row.notes;
        if (row.tierId != null && customer.tierId === null)
          patch.tierId = row.tierId;
        if (statusId != null && customer.statusId === null)
          patch.statusId = statusId;
        if (row.ownerId != null && customer.ownerId === null)
          patch.ownerId = row.ownerId;
        if (row.nextStepText != null && customer.nextStepText === null)
          patch.nextStepText = row.nextStepText;
        if (row.nextStepDueAt != null && customer.nextStepDueAt === null)
          patch.nextStepDueAt = row.nextStepDueAt;
        if (row.needsHuman != null && customer.needsHuman === null)
          patch.needsHuman = row.needsHuman;
        if (row.needsHumanReason != null && customer.needsHumanReason === null)
          patch.needsHumanReason = row.needsHumanReason;
        if (row.priorityScore != null && customer.priorityScore === null)
          patch.priorityScore = row.priorityScore;
        if (Object.keys(patch).length > 0) {
          customer = updateCustomer(db, organizationId, customer.id, patch);
        }
      } else {
        customer = createCustomer(db, {
          organizationId,
          name: row.name,
          url: row.url ?? null,
          notes: row.notes ?? null,
          externalId,
          tierId: row.tierId ?? null,
          statusId,
          ownerId: row.ownerId ?? null,
          nextStepText: row.nextStepText ?? null,
          nextStepDueAt: row.nextStepDueAt ?? null,
          needsHuman: row.needsHuman ?? null,
          needsHumanReason: row.needsHumanReason ?? null,
          priorityScore: row.priorityScore ?? null,
        });
        outcome = "created";
        createdCount += 1;
      }
      if (customer === undefined) {
        throw new Error("Customer write returned no record");
      }
      if (row.customFields) {
        setFieldValuesByName(
          db,
          organizationId,
          "customer",
          customer.id,
          row.customFields
        );
      }
      const dealId = row.deal
        ? importRowDeal(db, organizationId, customer, externalId, row.deal)
        : undefined;
      rows.push({
        index,
        externalId,
        outcome,
        customerId: customer.id,
        dealId,
      });
    } catch (error) {
      failedCount += 1;
      rows.push({
        index,
        externalId,
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return createImportReceipt(db, organizationId, {
    source: input.source ?? null,
    corridor: input.corridor ?? null,
    rowCount: input.rows.length,
    createdCount,
    existingCount,
    failedCount,
    rows,
    createdById: input.createdById ?? null,
  });
}

type ImportReceiptRow = typeof workspaceImportReceipts.$inferSelect;

function toImportReceipt(row: ImportReceiptRow): ImportReceipt {
  return {
    ...toImportReceiptSummary(row),
    rows: JSON.parse(row.rows) as ImportRowReceipt[],
  };
}

function toImportReceiptSummary(row: ImportReceiptRow): ImportReceiptSummary {
  return {
    id: row.id,
    organizationId: row.organizationId,
    source: row.source,
    corridor: row.corridor,
    total: row.rowCount,
    created: row.createdCount,
    existing: row.existingCount,
    failed: row.failedCount,
    createdById: row.createdById,
    createdAt: row.createdAt,
  };
}

export function createImportReceipt(
  db: WorkspaceDb,
  organizationId: string,
  input: {
    source?: string | null;
    corridor?: string | null;
    rowCount: number;
    createdCount: number;
    existingCount: number;
    failedCount: number;
    rows: ImportRowReceipt[];
    createdById?: string | null;
  }
): ImportReceipt {
  const row = db
    .insert(workspaceImportReceipts)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      source: input.source ?? null,
      corridor: input.corridor ?? null,
      rowCount: input.rowCount,
      createdCount: input.createdCount,
      existingCount: input.existingCount,
      failedCount: input.failedCount,
      rows: JSON.stringify(input.rows),
      createdById: input.createdById ?? null,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
  return toImportReceipt(row);
}

export function getImportReceipt(
  db: WorkspaceDb,
  organizationId: string,
  id: string
): ImportReceipt | undefined {
  const row = db
    .select()
    .from(workspaceImportReceipts)
    .where(
      and(
        eq(workspaceImportReceipts.id, id),
        eq(workspaceImportReceipts.organizationId, organizationId)
      )
    )
    .get();
  return row ? toImportReceipt(row) : undefined;
}

export function listImportReceipts(
  db: WorkspaceDb,
  organizationId: string
): ImportReceiptSummary[] {
  return db
    .select()
    .from(workspaceImportReceipts)
    .where(eq(workspaceImportReceipts.organizationId, organizationId))
    .orderBy(desc(workspaceImportReceipts.createdAt))
    .all()
    .map(toImportReceiptSummary);
}

// ---- deals ----
// The CRM pipeline: deals belong to a customer (company), carry a stage,
// amount + currency + expected close, and link to contact people.

export const DEAL_STAGES = [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export interface DealInput {
  organizationId: string;
  customerId: string;
  name: string;
  externalId?: string | null;
  stage: DealStage;
  amountCents?: number | null;
  currency?: string | null;
  expectedCloseAt?: string | null;
  description?: string | null;
  contactIds?: string[];
  nextStepText?: string | null;
  nextStepDueAt?: string | null;
  needsHuman?: boolean | null;
  needsHumanReason?: string | null;
  priorityScore?: number | null;
}

export function getDealByExternalId(
  db: WorkspaceDb,
  organizationId: string,
  externalId: string
) {
  const deal = db
    .select()
    .from(workspaceDeals)
    .where(
      and(
        eq(workspaceDeals.organizationId, organizationId),
        eq(workspaceDeals.externalId, externalId)
      )
    )
    .get();
  if (!deal) return undefined;
  return {
    ...deal,
    stage: deal.stage as DealStage,
    contactIds: listDealContactIds(db, deal.id),
  };
}

export function createDeal(db: WorkspaceDb, input: DealInput) {
  // externalId is a hard dedupe key (same contract as issues' externalRef):
  // Scout keys imports on Google place_id, so a re-run returns the record.
  if (input.externalId) {
    const existing = getDealByExternalId(
      db,
      input.organizationId,
      input.externalId
    );
    if (existing) return existing;
  }
  const now = new Date().toISOString();
  const deal = db
    .insert(workspaceDeals)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      customerId: input.customerId,
      name: input.name,
      externalId: input.externalId ?? null,
      stage: input.stage,
      amountCents: input.amountCents ?? null,
      currency: input.currency ?? null,
      expectedCloseAt: input.expectedCloseAt ?? null,
      description: input.description ?? null,
      closedAt: input.stage === "won" || input.stage === "lost" ? now : null,
      archivedAt: null,
      nextStepText: input.nextStepText ?? null,
      nextStepDueAt: input.nextStepDueAt ?? null,
      needsHuman: input.needsHuman ?? null,
      needsHumanReason: input.needsHumanReason ?? null,
      priorityScore: input.priorityScore ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  if (input.contactIds?.length) {
    setDealContacts(db, input.organizationId, deal.id, input.contactIds);
  }
  return {
    ...deal,
    stage: deal.stage as DealStage,
    contactIds: listDealContactIds(db, deal.id),
  };
}

export function listDeals(
  db: WorkspaceDb,
  organizationId: string,
  opts: {
    includeArchived?: boolean;
    stage?: DealStage;
    dueBefore?: string;
    cold?: boolean;
    needsHuman?: boolean;
  } = {}
) {
  const rows = db
    .select()
    .from(workspaceDeals)
    .where(eq(workspaceDeals.organizationId, organizationId))
    .all();
  const filtered = rows.filter((d) => {
    if (!opts.includeArchived && d.archivedAt !== null) return false;
    if (opts.stage && d.stage !== opts.stage) return false;
    // Cold = open record with no next step and no due date — the sweep-
    // missed-something view. Closed deals aren't leads, so they're out.
    if (opts.cold) {
      if (d.stage === "won" || d.stage === "lost") return false;
      if (d.nextStepText !== null || d.nextStepDueAt !== null) return false;
    }
    if (
      opts.dueBefore &&
      (d.nextStepDueAt === null || d.nextStepDueAt > opts.dueBefore)
    )
      return false;
    if (opts.needsHuman && d.needsHuman !== true) return false;
    return true;
  });
  return filtered.map((deal) => ({
    ...deal,
    stage: deal.stage as DealStage,
    contactIds: listDealContactIds(db, deal.id),
  }));
}

export function getDeal(db: WorkspaceDb, organizationId: string, id: string) {
  const deal = db
    .select()
    .from(workspaceDeals)
    .where(
      and(
        eq(workspaceDeals.id, id),
        eq(workspaceDeals.organizationId, organizationId)
      )
    )
    .get();
  if (!deal) return undefined;
  return {
    ...deal,
    stage: deal.stage as DealStage,
    contactIds: listDealContactIds(db, id),
  };
}

export function updateDeal(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  patch: Partial<
    Omit<DealInput, "organizationId" | "customerId" | "contactIds">
  > & {
    customerId?: string;
    contactIds?: string[];
    archivedAt?: string | null;
  }
) {
  const updates: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };
  for (const key of [
    "name",
    "customerId",
    "externalId",
    "stage",
    "amountCents",
    "currency",
    "expectedCloseAt",
    "description",
    "archivedAt",
    "nextStepText",
    "nextStepDueAt",
    "needsHuman",
    "needsHumanReason",
    "priorityScore",
  ] as const) {
    if (patch[key] !== undefined) updates[key] = patch[key];
  }
  if (patch.stage === "won" || patch.stage === "lost") {
    updates.closedAt = new Date().toISOString();
  } else if (patch.stage !== undefined) {
    updates.closedAt = null;
  }
  const deal = db
    .update(workspaceDeals)
    .set(updates)
    .where(
      and(
        eq(workspaceDeals.id, id),
        eq(workspaceDeals.organizationId, organizationId)
      )
    )
    .returning()
    .get();
  if (patch.contactIds !== undefined) {
    setDealContacts(db, organizationId, id, patch.contactIds);
  }
  if (!deal) return undefined;
  return {
    ...deal,
    stage: deal.stage as DealStage,
    contactIds: listDealContactIds(db, id),
  };
}

export function deleteDeal(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  db.delete(workspaceEntityLinks)
    .where(
      and(
        eq(workspaceEntityLinks.organizationId, organizationId),
        or(
          and(
            eq(workspaceEntityLinks.fromType, "deal"),
            eq(workspaceEntityLinks.fromId, id)
          ),
          and(
            eq(workspaceEntityLinks.toType, "deal"),
            eq(workspaceEntityLinks.toId, id)
          )
        )
      )
    )
    .run();
  return (
    db
      .delete(workspaceDeals)
      .where(
        and(
          eq(workspaceDeals.id, id),
          eq(workspaceDeals.organizationId, organizationId)
        )
      )
      .returning()
      .all().length > 0
  );
}

function listDealContactIds(db: WorkspaceDb, dealId: string) {
  return db
    .select({ contactId: workspaceEntityLinks.toId })
    .from(workspaceEntityLinks)
    .where(
      and(
        eq(workspaceEntityLinks.fromType, "deal"),
        eq(workspaceEntityLinks.fromId, dealId),
        eq(workspaceEntityLinks.toType, "contact")
      )
    )
    .all()
    .map((r) => r.contactId);
}

export function setDealContacts(
  db: WorkspaceDb,
  organizationId: string,
  dealId: string,
  contactIds: string[]
) {
  db.delete(workspaceEntityLinks)
    .where(
      and(
        eq(workspaceEntityLinks.fromType, "deal"),
        eq(workspaceEntityLinks.fromId, dealId),
        eq(workspaceEntityLinks.toType, "contact")
      )
    )
    .run();
  for (const contactId of contactIds) {
    db.insert(workspaceEntityLinks)
      .values({
        id: crypto.randomUUID(),
        organizationId: organizationId,
        fromType: "deal",
        fromId: dealId,
        toType: "contact",
        toId: contactId,
        kind: "contact",
        createdAt: new Date().toISOString(),
      })
      .run();
  }
}

export function linkDealIssue(
  db: WorkspaceDb,
  organizationId: string,
  dealId: string,
  issueId: string
) {
  linkEntities(db, {
    organizationId,
    fromType: "deal",
    fromId: dealId,
    toType: "issue",
    toId: issueId,
    kind: "relates",
  });
}

export function unlinkDealIssue(
  db: WorkspaceDb,
  dealId: string,
  issueId: string
) {
  db.delete(workspaceEntityLinks)
    .where(
      and(
        eq(workspaceEntityLinks.fromType, "deal"),
        eq(workspaceEntityLinks.fromId, dealId),
        eq(workspaceEntityLinks.toType, "issue"),
        eq(workspaceEntityLinks.toId, issueId)
      )
    )
    .run();
}

export function listDealIssueIds(db: WorkspaceDb, dealId: string) {
  return db
    .select({ issueId: workspaceEntityLinks.toId })
    .from(workspaceEntityLinks)
    .where(
      and(
        eq(workspaceEntityLinks.fromType, "deal"),
        eq(workspaceEntityLinks.fromId, dealId),
        eq(workspaceEntityLinks.toType, "issue")
      )
    )
    .all()
    .map((r) => r.issueId);
}

export function listDealsForIssue(
  db: WorkspaceDb,
  organizationId: string,
  issueId: string
) {
  const links = db
    .select({ dealId: workspaceEntityLinks.fromId })
    .from(workspaceEntityLinks)
    .where(
      and(
        eq(workspaceEntityLinks.organizationId, organizationId),
        eq(workspaceEntityLinks.fromType, "deal"),
        eq(workspaceEntityLinks.toType, "issue"),
        eq(workspaceEntityLinks.toId, issueId)
      )
    )
    .all();
  return links
    .map((l) => getDeal(db, organizationId, l.dealId))
    .filter((d): d is NonNullable<typeof d> => d !== undefined);
}

// ---- entity links — the graph ----
// Edges between any two nodes. Issues↔deals↔contacts↔documents↔
// tickets↔customers are all the same kind of fact.

export interface EntityLinkInput {
  organizationId: string;
  fromType: string;
  fromId: string;
  toType: string;
  toId: string;
  kind?: string;
  label?: string;
}

function resolveLinkLabel(
  db: WorkspaceDb,
  type: string,
  id: string
): string | null {
  if (type === "issue") {
    const row = db
      .select({
        identifier: workspaceIssues.identifier,
        title: workspaceIssues.title,
      })
      .from(workspaceIssues)
      .where(eq(workspaceIssues.id, id))
      .get();
    return row
      ? `${row.identifier ? `${row.identifier} ` : ""}${row.title}`
      : null;
  }
  if (type === "deal") {
    return (
      db
        .select({ name: workspaceDeals.name })
        .from(workspaceDeals)
        .where(eq(workspaceDeals.id, id))
        .get()?.name ?? null
    );
  }
  if (type === "customer") {
    return (
      db
        .select({ name: workspaceCustomers.name })
        .from(workspaceCustomers)
        .where(eq(workspaceCustomers.id, id))
        .get()?.name ?? null
    );
  }
  if (type === "document") {
    return (
      db
        .select({ title: workspaceDocuments.title })
        .from(workspaceDocuments)
        .where(eq(workspaceDocuments.id, id))
        .get()?.title ?? null
    );
  }
  return null;
}

export function linkEntities(db: WorkspaceDb, input: EntityLinkInput) {
  const label =
    input.label ??
    resolveLinkLabel(db, input.toType, input.toId) ??
    resolveLinkLabel(db, input.fromType, input.fromId);
  return db
    .insert(workspaceEntityLinks)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      fromType: input.fromType,
      fromId: input.fromId,
      toType: input.toType,
      toId: input.toId,
      kind: input.kind ?? "relates",
      label,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .returning()
    .get();
}

export function unlinkEntities(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return (
    db
      .delete(workspaceEntityLinks)
      .where(
        and(
          eq(workspaceEntityLinks.id, id),
          eq(workspaceEntityLinks.organizationId, organizationId)
        )
      )
      .returning()
      .all().length > 0
  );
}

// Both directions — a link reads the same from either node.
export function listEntityLinks(
  db: WorkspaceDb,
  organizationId: string,
  type: string,
  id: string
) {
  return db
    .select()
    .from(workspaceEntityLinks)
    .where(
      and(
        eq(workspaceEntityLinks.organizationId, organizationId),
        or(
          and(
            eq(workspaceEntityLinks.fromType, type),
            eq(workspaceEntityLinks.fromId, id)
          ),
          and(
            eq(workspaceEntityLinks.toType, type),
            eq(workspaceEntityLinks.toId, id)
          )
        )
      )
    )
    .all();
}

// ---- custom fields ----
// Field definitions scoped per entity type; values join entityId.

export const FIELD_TYPES = [
  "text",
  "number",
  "select",
  "date",
  "boolean",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldDefinitionInput {
  organizationId: string;
  entityType: string;
  name: string;
  type: FieldType;
  options?: string[];
  position?: number;
}

export function createFieldDefinition(
  db: WorkspaceDb,
  input: FieldDefinitionInput
) {
  const now = new Date().toISOString();
  const field = db
    .insert(workspaceFieldDefinitions)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      entityType: input.entityType,
      name: input.name,
      type: input.type,
      options: input.options ? JSON.stringify(input.options) : null,
      position: input.position ?? 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  return {
    ...field,
    type: field.type as FieldType,
    options: field.options ? (JSON.parse(field.options) as string[]) : null,
  };
}

export function listFieldDefinitions(
  db: WorkspaceDb,
  organizationId: string,
  entityType?: string
) {
  return db
    .select()
    .from(workspaceFieldDefinitions)
    .where(
      and(
        eq(workspaceFieldDefinitions.organizationId, organizationId),
        entityType !== undefined
          ? eq(workspaceFieldDefinitions.entityType, entityType)
          : undefined
      )
    )
    .orderBy(workspaceFieldDefinitions.position, workspaceFieldDefinitions.name)
    .all()
    .map((d) => ({
      ...d,
      type: d.type as FieldType,
      options: d.options ? (JSON.parse(d.options) as string[]) : null,
    }));
}

export function deleteFieldDefinition(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  db.delete(workspaceFieldValues)
    .where(
      and(
        eq(workspaceFieldValues.fieldId, id),
        eq(workspaceFieldValues.organizationId, organizationId)
      )
    )
    .run();
  return (
    db
      .delete(workspaceFieldDefinitions)
      .where(
        and(
          eq(workspaceFieldDefinitions.id, id),
          eq(workspaceFieldDefinitions.organizationId, organizationId)
        )
      )
      .returning()
      .all().length > 0
  );
}

export function setFieldValue(
  db: WorkspaceDb,
  organizationId: string,
  fieldId: string,
  entityId: string,
  value: string | null
) {
  const now = new Date().toISOString();
  if (value === null) {
    db.delete(workspaceFieldValues)
      .where(
        and(
          eq(workspaceFieldValues.fieldId, fieldId),
          eq(workspaceFieldValues.entityId, entityId),
          eq(workspaceFieldValues.organizationId, organizationId)
        )
      )
      .run();
    return;
  }
  db.insert(workspaceFieldValues)
    .values({
      fieldId,
      entityId,
      organizationId,
      value,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [workspaceFieldValues.fieldId, workspaceFieldValues.entityId],
      set: { value, updatedAt: now },
    })
    .run();
}

export function listFieldValues(
  db: WorkspaceDb,
  organizationId: string,
  entityId: string
) {
  return db
    .select()
    .from(workspaceFieldValues)
    .where(
      and(
        eq(workspaceFieldValues.organizationId, organizationId),
        eq(workspaceFieldValues.entityId, entityId)
      )
    )
    .all();
}

/** Raised when a custom field value fails type validation — the API maps
 *  this to a 400 and importers record it as the row's failure reason. */
export class FieldValueError extends Error {}

function validateFieldValue(
  definition: { name: string; type: FieldType; options: string[] | null },
  value: string
) {
  switch (definition.type) {
    case "number":
      if (value.trim() === "" || !Number.isFinite(Number(value))) {
        throw new FieldValueError(
          `Field "${definition.name}" expects a number, got "${value}"`
        );
      }
      break;
    case "boolean":
      if (value !== "true" && value !== "false") {
        throw new FieldValueError(
          `Field "${definition.name}" expects "true" or "false", got "${value}"`
        );
      }
      break;
    case "date":
      if (Number.isNaN(Date.parse(value))) {
        throw new FieldValueError(
          `Field "${definition.name}" expects a date, got "${value}"`
        );
      }
      break;
    case "select":
      if (definition.options && !definition.options.includes(value)) {
        throw new FieldValueError(
          `Field "${definition.name}" expects one of ${definition.options.join(", ")}, got "${value}"`
        );
      }
      break;
    default:
      break;
  }
}

/** Name-keyed custom field values for a set of entities — the shape
 *  callers (imports, API responses) actually work with. Definitions are
 *  scoped by entityType so a value stored under another entity type's
 *  field id is ignored. */
export function customFieldMaps(
  db: WorkspaceDb,
  organizationId: string,
  entityType: string,
  entityIds: string[]
): Map<string, Record<string, string>> {
  const result = new Map<string, Record<string, string>>();
  if (entityIds.length === 0) return result;
  const definitions = db
    .select()
    .from(workspaceFieldDefinitions)
    .where(
      and(
        eq(workspaceFieldDefinitions.organizationId, organizationId),
        eq(workspaceFieldDefinitions.entityType, entityType)
      )
    )
    .all();
  const nameById = new Map(definitions.map((d) => [d.id, d.name]));
  const values = db
    .select()
    .from(workspaceFieldValues)
    .where(
      and(
        eq(workspaceFieldValues.organizationId, organizationId),
        inArrayJson(workspaceFieldValues.entityId, entityIds)
      )
    )
    .all();
  for (const row of values) {
    const name = nameById.get(row.fieldId);
    if (!name || row.value === null) continue;
    const map = result.get(row.entityId) ?? {};
    map[name] = row.value;
    result.set(row.entityId, map);
  }
  return result;
}

export function customFieldMap(
  db: WorkspaceDb,
  organizationId: string,
  entityType: string,
  entityId: string
): Record<string, string> {
  return (
    customFieldMaps(db, organizationId, entityType, [entityId]).get(entityId) ??
    {}
  );
}

/** Upsert custom field values addressed by field name. Missing
 *  definitions are auto-created as text fields so importers can write
 *  `customFields` without a two-pass definition setup; a name that
 *  already exists keeps its declared type and the value is validated
 *  against it. `null` clears the value. */
export function setFieldValuesByName(
  db: WorkspaceDb,
  organizationId: string,
  entityType: string,
  entityId: string,
  fields: Record<string, string | null>
) {
  const definitions = listFieldDefinitions(db, organizationId, entityType);
  const byName = new Map(definitions.map((d) => [d.name, d]));
  for (const [rawName, value] of Object.entries(fields)) {
    const name = rawName.trim();
    if (!name) {
      throw new FieldValueError("Custom field name must not be empty");
    }
    let definition = byName.get(name);
    if (!definition) {
      definition = createFieldDefinition(db, {
        organizationId,
        entityType,
        name,
        type: "text",
      });
      byName.set(name, definition);
    }
    if (value !== null) validateFieldValue(definition, value);
    setFieldValue(db, organizationId, definition.id, entityId, value);
  }
}

/** Pre-flight check for batch writers: reject values that violate an
 *  existing definition's type *before* the row's record is created, so a
 *  failed import row leaves nothing behind. Missing definitions are
 *  always valid — they will be auto-created as text fields on write. */
export function assertFieldValuesValid(
  db: WorkspaceDb,
  organizationId: string,
  entityType: string,
  fields: Record<string, string | null>
) {
  const definitions = listFieldDefinitions(db, organizationId, entityType);
  const byName = new Map(definitions.map((d) => [d.name, d]));
  for (const [rawName, value] of Object.entries(fields)) {
    if (value === null) continue;
    const definition = byName.get(rawName.trim());
    if (definition) validateFieldValue(definition, value);
  }
}

// ---- entity attachments ----
// R2-backed file rows scoped to (entityType, entityId). The DO owns the R2
// object lifecycle; these functions only manage the metadata rows.

export interface EntityAttachmentInput {
  entityType: string;
  entityId: string;
  fileName: string;
  contentType: string;
  size: number;
  r2Key: string;
  id?: string;
  createdById?: string | null;
}

export function createEntityAttachment(
  db: WorkspaceDb,
  organizationId: string,
  input: EntityAttachmentInput
) {
  return db
    .insert(workspaceEntityAttachments)
    .values({
      id: input.id ?? crypto.randomUUID(),
      organizationId,
      entityType: input.entityType,
      entityId: input.entityId,
      fileName: input.fileName,
      contentType: input.contentType,
      size: input.size,
      r2Key: input.r2Key,
      createdById: input.createdById ?? null,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export function listEntityAttachments(
  db: WorkspaceDb,
  organizationId: string,
  entityType: string,
  entityId: string
) {
  return db
    .select()
    .from(workspaceEntityAttachments)
    .where(
      and(
        eq(workspaceEntityAttachments.organizationId, organizationId),
        eq(workspaceEntityAttachments.entityType, entityType),
        eq(workspaceEntityAttachments.entityId, entityId)
      )
    )
    .all();
}

export function getEntityAttachment(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceEntityAttachments)
    .where(
      and(
        eq(workspaceEntityAttachments.organizationId, organizationId),
        eq(workspaceEntityAttachments.id, id)
      )
    )
    .get();
}

export function deleteEntityAttachment(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .delete(workspaceEntityAttachments)
    .where(
      and(
        eq(workspaceEntityAttachments.organizationId, organizationId),
        eq(workspaceEntityAttachments.id, id)
      )
    )
    .returning()
    .get();
}

// ---- external links ----

// Outcome of the best-effort URL probe the API runs when a link is
// written (PILE-429). `unchecked` means no probe ran — non-http(s)
// schemes or rows created before v82.
export interface ExternalLinkVerification {
  status: "verified" | "failed" | "unreachable" | "unchecked";
  verifiedAt: string | null;
  resolvedUrl: string | null;
  resolvedTitle: string | null;
  httpStatus: number | null;
}

export interface ExternalLinkInput {
  entityType: string;
  entityId: string;
  url: string;
  label?: string | null;
  verification?: ExternalLinkVerification;
}

export function listExternalLinks(
  db: WorkspaceDb,
  organizationId: string,
  args: {
    entityType?: string;
    entityId?: string;
    // Restricted issues the caller isn't granted — links carry their
    // entity ids, so hide them rather than leaking existence.
    excludeIssueCondition?: SQL;
  } = {}
) {
  const conditions = [eq(externalLinks.organizationId, organizationId)];
  if (args.entityType !== undefined)
    conditions.push(eq(externalLinks.entityType, args.entityType));
  if (args.entityId !== undefined)
    conditions.push(eq(externalLinks.entityId, args.entityId));
  if (args.excludeIssueCondition) {
    const hiddenFilter = or(
      ne(externalLinks.entityType, "issue"),
      args.excludeIssueCondition
    );
    if (hiddenFilter) {
      conditions.push(hiddenFilter);
    }
  }
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
    issueId: input.entityType === "issue" ? input.entityId : "",
    entityType: input.entityType,
    entityId: input.entityId,
    url: input.url,
    label: input.label ?? null,
    verificationStatus: input.verification?.status ?? "unchecked",
    verifiedAt: input.verification?.verifiedAt ?? null,
    resolvedUrl: input.verification?.resolvedUrl ?? null,
    resolvedTitle: input.verification?.resolvedTitle ?? null,
    httpStatus: input.verification?.httpStatus ?? null,
    createdAt: ts,
  });
  return getExternalLink(db, organizationId, id);
}

export async function updateExternalLink(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  input: {
    url?: string;
    label?: string | null;
    verification?: ExternalLinkVerification;
  }
) {
  const existing = await getExternalLink(db, organizationId, id);
  if (!existing) return undefined;
  await db
    .update(externalLinks)
    .set({
      url: input.url ?? existing.url,
      label: input.label === undefined ? existing.label : input.label,
      verificationStatus:
        input.verification?.status ?? existing.verificationStatus,
      verifiedAt:
        input.verification === undefined
          ? existing.verifiedAt
          : input.verification.verifiedAt,
      resolvedUrl:
        input.verification === undefined
          ? existing.resolvedUrl
          : input.verification.resolvedUrl,
      resolvedTitle:
        input.verification === undefined
          ? existing.resolvedTitle
          : input.verification.resolvedTitle,
      httpStatus:
        input.verification === undefined
          ? existing.httpStatus
          : input.verification.httpStatus,
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
  input: {
    name: string;
    color?: string | null;
    position?: number;
    key?: string;
    type?: "active" | "terminal";
  }
) {
  return db
    .insert(workspaceCustomerStatuses)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      name: input.name,
      // PILE-438 — the key is minted once at create (from name unless an
      // explicit key is supplied) and is never re-derived on rename; that
      // immutability is what keeps stage templates/configs bound.
      key: input.key ?? stageKey(input.name),
      type: input.type ?? "active",
      color: input.color ?? null,
      position: input.position ?? 0,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

/** PILE-438 — persist a key on rows that predate the column. Called from
 *  DO initialize after migrations so renames stop orphaning stage
 *  bindings. */
const TERMINAL_STATUS_KEYS = new Set(["passed", "lost", "dead"]);

export async function backfillCustomerStatusKeys(
  db: WorkspaceDb,
  organizationId: string
): Promise<number> {
  const missing = db
    .select()
    .from(workspaceCustomerStatuses)
    .where(
      and(
        eq(workspaceCustomerStatuses.organizationId, organizationId),
        isNull(workspaceCustomerStatuses.key)
      )
    )
    .all();
  for (const row of missing) {
    const key = stageKey(row.name);
    await db
      .update(workspaceCustomerStatuses)
      .set({
        key,
        // Rows that predate the column never got terminal marked — fix the
        // known dead-end names while we're here.
        type: TERMINAL_STATUS_KEYS.has(key) ? "terminal" : "active",
      })
      .where(eq(workspaceCustomerStatuses.id, row.id));
  }
  return missing.length;
}

/** PILE-438 follow-up — rows that got `key` backfilled but stayed "active"
 *  on a terminal name. Idempotent; safe to call every boot. */
export async function markTerminalStatuses(
  db: WorkspaceDb,
  organizationId: string
): Promise<number> {
  const rows = db
    .select()
    .from(workspaceCustomerStatuses)
    .where(eq(workspaceCustomerStatuses.organizationId, organizationId))
    .all();
  let fixed = 0;
  for (const row of rows) {
    const key = row.key ?? stageKey(row.name);
    if (TERMINAL_STATUS_KEYS.has(key) && row.type !== "terminal") {
      await db
        .update(workspaceCustomerStatuses)
        .set({ type: "terminal" })
        .where(eq(workspaceCustomerStatuses.id, row.id));
      fixed++;
    }
  }
  return fixed;
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
  input: {
    name?: string;
    color?: string | null;
    position?: number;
    type?: "active" | "terminal";
  }
) {
  return db
    .update(workspaceCustomerStatuses)
    .set({
      name: input.name,
      color: input.color,
      position: input.position,
      type: input.type,
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

// ---- customer email intake (PILE-325) ----

// Consumer mailboxes can't identify a business, so they never drive domain
// matching or the created customer's url — the sender's display name / local
// part names the record instead.
const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "mail.com",
  "gmx.com",
  "gmx.net",
  "zoho.com",
  "yandex.com",
  "fastmail.com",
  "hey.com",
]);

export function emailAddressDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain.length > 0 ? domain : null;
}

export function customerUrlHost(url: string): string | null {
  const trimmed = url.trim().toLowerCase();
  if (!trimmed) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const host = new URL(withScheme).hostname;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

// Sender domain ↔ customer URL host. Subdomains match in both directions
// (mail.acme.com ↔ acme.com) but the dot boundary keeps lookalikes out
// (evil-acme.com, acme.com.evil.org never equal acme.com).
function emailDomainsMatch(senderDomain: string, customerHost: string) {
  return (
    senderDomain === customerHost ||
    senderDomain.endsWith(`.${customerHost}`) ||
    customerHost.endsWith(`.${senderDomain}`)
  );
}

export interface ResolveCustomerForEmailInput {
  email: string;
  name?: string | null;
}

export function resolveCustomerForEmail(
  db: WorkspaceDb,
  organizationId: string,
  input: ResolveCustomerForEmailInput
) {
  const email = input.email.trim().toLowerCase();
  const domain = emailAddressDomain(email);
  const businessDomain =
    domain !== null && !FREEMAIL_DOMAINS.has(domain) ? domain : null;
  const customers = listCustomers(db, organizationId);

  if (businessDomain) {
    const matches = customers.filter((customer) => {
      const host = customer.url ? customerUrlHost(customer.url) : null;
      return (
        host !== null &&
        !FREEMAIL_DOMAINS.has(host) &&
        emailDomainsMatch(businessDomain, host)
      );
    });
    // Deterministic pick when several customers share a domain — oldest
    // record wins so repeated mail can't scatter across duplicates.
    matches.sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    );
    const match = matches[0];
    if (match) return { customer: match, created: false };
  }

  // Freemail senders carry no business domain — key the record to the exact
  // address so repeat mail from the same mailbox lands on the same customer
  // instead of minting a duplicate per message.
  const senderKey = `email:${email}`;
  const bySenderKey = customers.find(
    (customer) => customer.externalId === senderKey
  );
  if (bySenderKey) return { customer: bySenderKey, created: false };

  const customer = createCustomer(db, {
    organizationId,
    name: businessDomain || input.name?.trim() || email.split("@")[0] || email,
    url: businessDomain ? `https://${businessDomain}` : null,
    externalId: senderKey,
  });
  return { customer, created: true };
}

export interface CustomerIntakeAttachment {
  key: string | null;
  filename: string;
  contentType: string;
  size: number;
}

export interface CustomerIntakeItemInput {
  customerId: string;
  source?: string;
  inboxId?: string | null;
  fromAddress: string;
  fromName?: string | null;
  toAddress: string;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  externalId: string;
  messageId?: string | null;
  attachments?: CustomerIntakeAttachment[];
  receivedAt?: string;
}

export function fileCustomerIntakeItem(
  db: WorkspaceDb,
  organizationId: string,
  input: CustomerIntakeItemInput
) {
  const now = new Date().toISOString();
  const inserted = db
    .insert(workspaceCustomerIntakeItems)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      customerId: input.customerId,
      source: input.source ?? "email",
      inboxId: input.inboxId ?? null,
      fromAddress: input.fromAddress,
      fromName: input.fromName ?? null,
      toAddress: input.toAddress,
      subject: input.subject ?? null,
      text: input.text ?? null,
      html: input.html ?? null,
      externalId: input.externalId,
      messageId: input.messageId ?? null,
      attachments:
        input.attachments === undefined
          ? null
          : JSON.stringify(input.attachments),
      receivedAt: input.receivedAt ?? now,
      createdAt: now,
    })
    .onConflictDoNothing({
      target: [
        workspaceCustomerIntakeItems.organizationId,
        workspaceCustomerIntakeItems.externalId,
      ],
    })
    .returning()
    .get();
  if (inserted) return { item: inserted, isNew: true };
  const existing = db
    .select()
    .from(workspaceCustomerIntakeItems)
    .where(
      and(
        eq(workspaceCustomerIntakeItems.organizationId, organizationId),
        eq(workspaceCustomerIntakeItems.externalId, input.externalId)
      )
    )
    .get();
  return { item: existing ?? null, isNew: false };
}

export function listCustomerIntakeItems(
  db: WorkspaceDb,
  organizationId: string,
  customerId: string
) {
  return db
    .select()
    .from(workspaceCustomerIntakeItems)
    .where(
      and(
        eq(workspaceCustomerIntakeItems.organizationId, organizationId),
        eq(workspaceCustomerIntakeItems.customerId, customerId)
      )
    )
    .orderBy(desc(workspaceCustomerIntakeItems.receivedAt))
    .all();
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
    restricted?: boolean;
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
      restricted: input.restricted ?? false,
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
    restricted?: boolean;
  }
) {
  const updates: Record<string, unknown> = {};
  for (const key of [
    "name",
    "description",
    "icon",
    "publicSharing",
    "restricted",
  ] as const) {
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

function shareAsIssueShare(row: {
  token: string;
  organizationId: string;
  entityId: string;
  createdById: string;
  createdAt: string;
  expiresAt: string | null;
}) {
  return {
    token: row.token,
    organizationId: row.organizationId,
    issueId: row.entityId,
    createdById: row.createdById,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function shareAsDocumentShare(row: {
  token: string;
  organizationId: string;
  entityId: string;
  includeChildren: boolean;
  createdById: string;
  createdAt: string;
  expiresAt: string | null;
}) {
  return {
    token: row.token,
    organizationId: row.organizationId,
    documentId: row.entityId,
    includeChildren: row.includeChildren,
    createdById: row.createdById,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

export function createIssueShare(
  db: WorkspaceDb,
  organizationId: string,
  input: {
    issueId: string;
    createdById: string;
    expiresAt?: string | null;
  }
) {
  const row = db
    .insert(workspaceShares)
    .values({
      token: crypto.randomUUID().replace(/-/g, ""),
      organizationId,
      entityType: "issue",
      entityId: input.issueId,
      createdById: input.createdById,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt ?? null,
    })
    .returning()
    .get();
  return row ? shareAsIssueShare(row) : undefined;
}

export function getIssueShare(
  db: WorkspaceDb,
  organizationId: string,
  issueId: string
) {
  const row = db
    .select()
    .from(workspaceShares)
    .where(
      and(
        eq(workspaceShares.entityType, "issue"),
        eq(workspaceShares.entityId, issueId),
        eq(workspaceShares.organizationId, organizationId)
      )
    )
    .get();
  return row ? shareAsIssueShare(row) : undefined;
}

export function getIssueShareByToken(db: WorkspaceDb, token: string) {
  const row = db
    .select()
    .from(workspaceShares)
    .where(eq(workspaceShares.token, token))
    .get();
  return row ? shareAsIssueShare(row) : undefined;
}

export function deleteIssueShare(
  db: WorkspaceDb,
  organizationId: string,
  token: string
) {
  return db
    .delete(workspaceShares)
    .where(
      and(
        eq(workspaceShares.token, token),
        eq(workspaceShares.organizationId, organizationId)
      )
    )
    .run();
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
  const row = db
    .insert(workspaceShares)
    .values({
      token: crypto.randomUUID().replace(/-/g, ""),
      organizationId,
      entityType: "document",
      entityId: input.documentId,
      includeChildren: input.includeChildren ?? false,
      createdById: input.createdById,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt ?? null,
    })
    .returning()
    .get();
  return row ? shareAsDocumentShare(row) : undefined;
}

export function getDocumentShare(
  db: WorkspaceDb,
  organizationId: string,
  documentId: string
) {
  const row = db
    .select()
    .from(workspaceShares)
    .where(
      and(
        eq(workspaceShares.entityType, "document"),
        eq(workspaceShares.entityId, documentId),
        eq(workspaceShares.organizationId, organizationId)
      )
    )
    .get();
  return row ? shareAsDocumentShare(row) : undefined;
}

export function getDocumentShareByToken(db: WorkspaceDb, token: string) {
  const row = db
    .select()
    .from(workspaceShares)
    .where(eq(workspaceShares.token, token))
    .get();
  return row ? shareAsDocumentShare(row) : undefined;
}

export function deleteDocumentShare(
  db: WorkspaceDb,
  organizationId: string,
  token: string
) {
  return (
    db
      .delete(workspaceShares)
      .where(
        and(
          eq(workspaceShares.token, token),
          eq(workspaceShares.organizationId, organizationId)
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
    .from(workspaceSubscriptions)
    .where(
      and(
        eq(workspaceSubscriptions.entityType, "document"),
        eq(workspaceSubscriptions.entityId, documentId),
        eq(workspaceSubscriptions.userId, userId)
      )
    )
    .get();
  if (existing) return existing;
  return db
    .insert(workspaceSubscriptions)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      entityType: "document",
      entityId: documentId,
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
      .delete(workspaceSubscriptions)
      .where(
        and(
          eq(workspaceSubscriptions.entityType, "document"),
          eq(workspaceSubscriptions.entityId, documentId),
          eq(workspaceSubscriptions.userId, userId)
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
    .select({ userId: workspaceSubscriptions.userId })
    .from(workspaceSubscriptions)
    .where(
      and(
        eq(workspaceSubscriptions.entityType, "document"),
        eq(workspaceSubscriptions.entityId, documentId)
      )
    )
    .all()
    .map((row) => row.userId);
}

// ---- document permissions & links ----

export function listDocumentPermissions(db: WorkspaceDb, documentId: string) {
  return db
    .select()
    .from(workspaceDocumentPermissions)
    .where(eq(workspaceDocumentPermissions.documentId, documentId))
    .all();
}

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

// ---- space permissions ----
// A space grant opens every doc in the space that has NO explicit
// document_permissions rows. A doc with any grant is a closed ACL the
// space grant cannot widen (Cursor pair design, PILE-447).

export function listSpacePermissions(db: WorkspaceDb, spaceId: string) {
  return db
    .select()
    .from(workspaceSpacePermissions)
    .where(eq(workspaceSpacePermissions.spaceId, spaceId))
    .all();
}

export function setSpacePermission(
  db: WorkspaceDb,
  organizationId: string,
  spaceId: string,
  actorId: string,
  actorType: string,
  level: "view" | "edit"
) {
  const existing = db
    .select()
    .from(workspaceSpacePermissions)
    .where(
      and(
        eq(workspaceSpacePermissions.spaceId, spaceId),
        eq(workspaceSpacePermissions.actorId, actorId)
      )
    )
    .get();
  if (existing) {
    db.update(workspaceSpacePermissions)
      .set({ level })
      .where(eq(workspaceSpacePermissions.id, existing.id))
      .run();
    return { ...existing, level };
  }
  return db
    .insert(workspaceSpacePermissions)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      spaceId,
      actorId,
      actorType,
      level,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export function revokeSpacePermission(
  db: WorkspaceDb,
  spaceId: string,
  actorId: string
) {
  return (
    db
      .delete(workspaceSpacePermissions)
      .where(
        and(
          eq(workspaceSpacePermissions.spaceId, spaceId),
          eq(workspaceSpacePermissions.actorId, actorId)
        )
      )
      .returning()
      .all().length > 0
  );
}

// Space ids the actor (or their teams) holds any grant on — the list-path
// helper so listDocumentsVisibleTo pays one query, not one per doc.
export function grantedSpaceIds(
  db: WorkspaceDb,
  organizationId: string,
  actorIds: string[]
) {
  if (actorIds.length === 0) return new Set<string>();
  // filter by actor — the where above selects org; match actors in JS for
  // the team-ids expansion (small grant sets, same as documents).
  const granted = new Set<string>();
  for (const row of db
    .select()
    .from(workspaceSpacePermissions)
    .where(eq(workspaceSpacePermissions.organizationId, organizationId))
    .all()) {
    if (actorIds.includes(row.actorId)) granted.add(row.spaceId);
  }
  return granted;
}

// Returns the effective level for an actor, or null when the doc is
// restricted and the actor is unlisted. Team grants (Better Auth
// organization teams) cover every member of the team.
export function documentAccessLevel(
  db: WorkspaceDb,
  documentId: string,
  actorId: string,
  teamIds: string[] = [],
  defaultDenied = false
): "view" | "edit" | null {
  const grants = listDocumentPermissions(db, documentId);
  // Members: no grants = open doc. Guests: no grants = invisible doc —
  // they see only what a permission row explicitly gives them.
  // PILE-409: docs inside a restricted space deny-by-default for everyone —
  // only an explicit grant (or admin bypass at the API layer) opens them.
  const doc = db
    .select({ spaceId: workspaceDocuments.spaceId })
    .from(workspaceDocuments)
    .where(eq(workspaceDocuments.id, documentId))
    .get();
  const inRestrictedSpace =
    doc?.spaceId != null &&
    db
      .select({ id: workspaceDocumentSpaces.id })
      .from(workspaceDocumentSpaces)
      .where(
        and(
          eq(workspaceDocumentSpaces.id, doc.spaceId),
          eq(workspaceDocumentSpaces.restricted, true)
        )
      )
      .get() !== undefined;
  if (inRestrictedSpace && grants.length === 0) {
    // Gap doc — no doc-level ACL. Fall to the space grant; the doc ACL
    // would have won had it existed (closed-ACL precedence).
    let spaceLevel: "view" | "edit" | null = null;
    for (const grant of listSpacePermissions(db, doc!.spaceId!)) {
      const covered =
        grant.actorId === actorId ||
        (grant.actorType === "team" && teamIds.includes(grant.actorId));
      if (covered && (spaceLevel === null || grant.level === "edit")) {
        spaceLevel = grant.level;
      }
    }
    return spaceLevel;
  }
  if (grants.length === 0) return defaultDenied ? null : "edit";
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

// ---- issue permissions ----
// Same grant model as documents: no rows = open to the workspace; any row
// restricts the issue to the listed actors (+ workspace admins, enforced by
// callers). Grants carry no level — access is binary.

export function setIssuePermission(
  db: WorkspaceDb,
  organizationId: string,
  issueId: string,
  actorId: string,
  actorType: string
) {
  const existing = db
    .select()
    .from(workspaceIssuePermissions)
    .where(
      and(
        eq(workspaceIssuePermissions.issueId, issueId),
        eq(workspaceIssuePermissions.actorId, actorId)
      )
    )
    .get();
  if (existing) {
    db.update(workspaceIssuePermissions)
      .set({ actorType })
      .where(eq(workspaceIssuePermissions.id, existing.id))
      .run();
    return { ...existing, actorType };
  }
  return db
    .insert(workspaceIssuePermissions)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      issueId,
      actorId,
      actorType,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export function revokeIssuePermission(
  db: WorkspaceDb,
  issueId: string,
  actorId: string
) {
  return (
    db
      .delete(workspaceIssuePermissions)
      .where(
        and(
          eq(workspaceIssuePermissions.issueId, issueId),
          eq(workspaceIssuePermissions.actorId, actorId)
        )
      )
      .returning()
      .all().length > 0
  );
}

export function listIssuePermissions(db: WorkspaceDb, issueId: string) {
  return db
    .select()
    .from(workspaceIssuePermissions)
    .where(eq(workspaceIssuePermissions.issueId, issueId))
    .all();
}

// True when the issue has no grants (open) or the actor is covered by one.
// Team grants (Better Auth organization teams) cover every member.
export function hasIssueAccess(
  db: WorkspaceDb,
  issueId: string,
  actorId: string,
  teamIds: string[] = [],
  defaultDenied = false
): boolean {
  const grants = listIssuePermissions(db, issueId);
  // Default-deny actors (no workspace:read) see only what a grant row
  // gives them — unrestricted issues stay invisible.
  if (grants.length === 0) return !defaultDenied;
  return grants.some(
    (grant) =>
      grant.actorId === actorId ||
      (grant.actorType === "team" && teamIds.includes(grant.actorId))
  );
}

// Ids of every restricted issue the actor cannot see — restricted issues
// minus the ones their grants cover. List/search/analytics queries exclude
// this set.
// SQL-side exclusion for issue visibility — the JS list variant
// (hiddenIssueIds) is fine for small grant sets, but `grantedOnly`
// enumerates every issue id and overflows SQLite's variable cap in the
// notInArray predicate. The subquery keeps the predicate inside SQL.
export function hiddenIssueCondition(
  db: WorkspaceDb,
  col: SQLWrapper,
  actorId: string,
  teamIds: string[] = [],
  grantedOnly = false
): SQL | undefined {
  const grantForViewer = or(
    eq(workspaceIssuePermissions.actorId, actorId),
    teamIds.length > 0
      ? and(
          eq(workspaceIssuePermissions.actorType, "team"),
          inArrayJson(workspaceIssuePermissions.actorId, teamIds)
        )
      : undefined
  );
  if (grantedOnly) {
    // Visible = granted to the viewer — keep the grant-matching ids.
    return sql`${col} IN (SELECT ${workspaceIssuePermissions.issueId} FROM ${workspaceIssuePermissions} WHERE ${grantForViewer})`;
  }
  // Visible = unrestricted OR granted — hide ids that carry a grant
  // row at all but none for this viewer.
  return sql`(${col} NOT IN (SELECT ${workspaceIssuePermissions.issueId} FROM ${workspaceIssuePermissions}) OR ${col} IN (SELECT ${workspaceIssuePermissions.issueId} FROM ${workspaceIssuePermissions} WHERE ${grantForViewer}))`;
}

export function hiddenIssueIds(
  db: WorkspaceDb,
  actorId: string,
  teamIds: string[] = [],
  grantedOnly = false
): string[] {
  const grants = db
    .select({
      issueId: workspaceIssuePermissions.issueId,
      actorId: workspaceIssuePermissions.actorId,
      actorType: workspaceIssuePermissions.actorType,
    })
    .from(workspaceIssuePermissions)
    .all();
  const visible = new Set(
    grants
      .filter(
        (grant) =>
          grant.actorId === actorId ||
          (grant.actorType === "team" && teamIds.includes(grant.actorId))
      )
      .map((grant) => grant.issueId)
  );
  if (grantedOnly) {
    return db
      .select({ id: workspaceIssues.id })
      .from(workspaceIssues)
      .all()
      .map((row) => row.id)
      .filter((issueId) => !visible.has(issueId));
  }
  return [...new Set(grants.map((grant) => grant.issueId))].filter(
    (issueId) => !visible.has(issueId)
  );
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
  // DO SQLite caps bound variables per statement at ~100 — 6 params per row
  // means >16 rows throws inside the caller's transaction and 500s doc
  // creates carrying many issue/doc references.
  const ts = new Date().toISOString();
  for (let i = 0; i < links.length; i += 16) {
    db.insert(workspaceDocumentLinks)
      .values(
        links.slice(i, i + 16).map((link) => ({
          id: crypto.randomUUID(),
          organizationId,
          documentId,
          targetType: link.targetType,
          targetId: link.targetId,
          createdAt: ts,
        }))
      )
      .run();
  }
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
    .where(inArrayJson(workspaceIssues.id, ids))
    .run();
  return ids.length;
}

export function getCustomerByDomain(
  db: WorkspaceDb,
  organizationId: string,
  domain: string
) {
  return db
    .select()
    .from(workspaceCustomers)
    .where(
      and(
        eq(workspaceCustomers.organizationId, organizationId),
        eq(workspaceCustomers.domain, domain)
      )
    )
    .get();
}

// ---- triage auto-delegate rules (PILE-427) ----
//
// Ordered match rules evaluated against inbound records; the first matching
// rule applies its action (delegate an agent, set a status) and the outcome
// is recorded in triage_rule_evaluations. conditions/action are opaque JSON
// here — the zod contract lives in src/global/triage-rules.ts.

export type TriageRule = typeof workspaceTriageRules.$inferSelect;
export type TriageRuleEvaluation =
  typeof workspaceTriageRuleEvaluations.$inferSelect;

export interface TriageRuleInput {
  organizationId: string;
  name: string;
  recordType: string;
  isActive?: boolean;
  sortOrder?: number;
  conditions: string;
  action: string;
  createdBy?: string | null;
}

export interface TriageRulePatch {
  name?: string;
  recordType?: string;
  isActive?: boolean;
  sortOrder?: number;
  conditions?: string;
  action?: string;
}

export function createTriageRule(db: WorkspaceDb, input: TriageRuleInput) {
  const now = new Date().toISOString();
  return db
    .insert(workspaceTriageRules)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      name: input.name,
      recordType: input.recordType,
      isActive: input.isActive ?? true,
      sortOrder: input.sortOrder ?? 0,
      conditions: input.conditions,
      action: input.action,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

export function getTriageRule(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return db
    .select()
    .from(workspaceTriageRules)
    .where(
      and(
        eq(workspaceTriageRules.organizationId, organizationId),
        eq(workspaceTriageRules.id, id)
      )
    )
    .get();
}

export function listTriageRules(
  db: WorkspaceDb,
  organizationId: string,
  filter: { recordType?: string; activeOnly?: boolean } = {}
) {
  const conditions = [eq(workspaceTriageRules.organizationId, organizationId)];
  if (filter.recordType !== undefined) {
    conditions.push(eq(workspaceTriageRules.recordType, filter.recordType));
  }
  if (filter.activeOnly) {
    conditions.push(eq(workspaceTriageRules.isActive, true));
  }
  return db
    .select()
    .from(workspaceTriageRules)
    .where(and(...conditions))
    .orderBy(
      asc(workspaceTriageRules.sortOrder),
      asc(workspaceTriageRules.createdAt)
    )
    .all();
}

export function updateTriageRule(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  patch: TriageRulePatch
) {
  const set: Partial<typeof workspaceTriageRules.$inferInsert> = {
    updatedAt: new Date().toISOString(),
  };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.recordType !== undefined) set.recordType = patch.recordType;
  if (patch.isActive !== undefined) set.isActive = patch.isActive;
  if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
  if (patch.conditions !== undefined) set.conditions = patch.conditions;
  if (patch.action !== undefined) set.action = patch.action;
  return db
    .update(workspaceTriageRules)
    .set(set)
    .where(
      and(
        eq(workspaceTriageRules.organizationId, organizationId),
        eq(workspaceTriageRules.id, id)
      )
    )
    .returning()
    .get();
}

export function deleteTriageRule(
  db: WorkspaceDb,
  organizationId: string,
  id: string
) {
  return (
    db
      .delete(workspaceTriageRules)
      .where(
        and(
          eq(workspaceTriageRules.organizationId, organizationId),
          eq(workspaceTriageRules.id, id)
        )
      )
      .returning()
      .all().length > 0
  );
}

export interface TriageEvaluationInput {
  organizationId: string;
  recordType: string;
  recordId: string;
  ruleId?: string | null;
  ruleName?: string | null;
  outcome: string;
  detail?: string | null;
}

export function recordTriageEvaluation(
  db: WorkspaceDb,
  input: TriageEvaluationInput
) {
  return db
    .insert(workspaceTriageRuleEvaluations)
    .values({
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      recordType: input.recordType,
      recordId: input.recordId,
      ruleId: input.ruleId ?? null,
      ruleName: input.ruleName ?? null,
      outcome: input.outcome,
      detail: input.detail ?? null,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export function listTriageEvaluations(
  db: WorkspaceDb,
  organizationId: string,
  filter: {
    recordType?: string;
    recordId?: string;
    ruleId?: string;
    limit?: number;
  } = {}
) {
  const conditions = [
    eq(workspaceTriageRuleEvaluations.organizationId, organizationId),
  ];
  if (filter.recordType !== undefined) {
    conditions.push(
      eq(workspaceTriageRuleEvaluations.recordType, filter.recordType)
    );
  }
  if (filter.recordId !== undefined) {
    conditions.push(
      eq(workspaceTriageRuleEvaluations.recordId, filter.recordId)
    );
  }
  if (filter.ruleId !== undefined) {
    conditions.push(eq(workspaceTriageRuleEvaluations.ruleId, filter.ruleId));
  }
  return db
    .select()
    .from(workspaceTriageRuleEvaluations)
    .where(and(...conditions))
    .orderBy(desc(workspaceTriageRuleEvaluations.createdAt))
    .limit(Math.min(Math.max(filter.limit ?? 50, 1), 200))
    .all();
}

// ── Merchant sources (signal-based intake) ──────────────────────────────────

export interface MerchantSourceInput {
  name: string;
  kind: string;
  config?: Record<string, unknown> | null;
  cursorField?: string | null;
  signal?: string;
  cadence?: string;
}

export function upsertMerchantSource(
  db: WorkspaceDb,
  organizationId: string,
  input: MerchantSourceInput
) {
  const existing = db
    .select()
    .from(workspaceMerchantSources)
    .where(
      and(
        eq(workspaceMerchantSources.organizationId, organizationId),
        eq(workspaceMerchantSources.name, input.name)
      )
    )
    .all()[0];
  if (existing) return existing;
  return db
    .insert(workspaceMerchantSources)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      name: input.name,
      kind: input.kind,
      config: JSON.stringify(input.config ?? {}),
      cursorField: input.cursorField ?? null,
      signal: input.signal ?? "registration",
      cadence: input.cadence ?? "daily",
      createdAt: new Date().toISOString(),
    })
    .returning()
    .all()[0];
}

export function listMerchantSources(
  db: WorkspaceDb,
  organizationId: string,
  args: { enabledOnly?: boolean; kind?: string } = {}
) {
  const conds = [eq(workspaceMerchantSources.organizationId, organizationId)];
  if (args.enabledOnly) conds.push(eq(workspaceMerchantSources.enabled, 1));
  if (args.kind) conds.push(eq(workspaceMerchantSources.kind, args.kind));
  return db
    .select()
    .from(workspaceMerchantSources)
    .where(and(...conds))
    .all();
}

export function updateMerchantSource(
  db: WorkspaceDb,
  organizationId: string,
  id: string,
  patch: {
    cursorValue?: string | null;
    lastRunAt?: string;
    runCount?: number;
    enabled?: number;
    config?: Record<string, unknown>;
  }
) {
  const updates: Record<string, unknown> = {};
  if (patch.cursorValue !== undefined) updates.cursorValue = patch.cursorValue;
  if (patch.lastRunAt !== undefined) updates.lastRunAt = patch.lastRunAt;
  if (patch.runCount !== undefined) updates.runCount = patch.runCount;
  if (patch.enabled !== undefined) updates.enabled = patch.enabled;
  if (patch.config !== undefined) updates.config = JSON.stringify(patch.config);
  return db
    .update(workspaceMerchantSources)
    .set(updates)
    .where(
      and(
        eq(workspaceMerchantSources.id, id),
        eq(workspaceMerchantSources.organizationId, organizationId)
      )
    )
    .returning()
    .all()[0];
}
