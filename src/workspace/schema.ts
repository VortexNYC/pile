import {
  index,
  primaryKey,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const workspaceIssues = sqliteTable(
  "issues" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    teamId: text("team_id" as string).notNull(),
    title: text("title" as string).notNull(),
    description: text("description" as string),
    status: text("status" as string, {
      enum: [
        "triage",
        "backlog",
        "todo",
        "in_progress",
        "done",
        "canceled",
      ] as const,
    }).notNull(),
    priority: text("priority" as string, {
      enum: ["low", "medium", "high", "urgent"] as const,
    }).notNull(),
    resolution: text("resolution" as string, {
      enum: [
        "duplicate",
        "not_planned",
        "intended_behavior",
        "not_reproducible",
        "obsolete",
        "resolved",
      ] as const,
    }),
    assigneeId: text("assignee_id" as string),
    projectId: text("project_id" as string),
    cycleId: text("cycle_id" as string),
    labelIds: text("label_ids" as string),
    number: integer("number" as string),
    identifier: text("identifier" as string),
    parentId: text("parent_id" as string),
    subIssueSortOrder: real("sub_issue_sort_order" as string),
    estimate: integer("estimate" as string),
    isDraft: integer("is_draft" as string, { mode: "boolean" })
      .notNull()
      .default(false),
    snoozedUntil: text("snoozed_until" as string),
    repo: text("repo" as string),
    branch: text("branch" as string),
    prUrl: text("pr_url" as string),
    prState: text("pr_state" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("idx_issues_status" as string).on(table.status, table.createdAt),
    index("idx_issues_repo_branch" as string).on(table.repo, table.branch),
    index("idx_issues_created_at_id" as string).on(table.createdAt, table.id),
    index("idx_issues_priority" as string).on(table.priority, table.createdAt),
    index("idx_issues_parent" as string).on(
      table.organizationId,
      table.parentId,
      table.subIssueSortOrder
    ),
    uniqueIndex("idx_issues_identifier" as string).on(
      table.organizationId,
      table.identifier
    ),
    uniqueIndex("idx_issues_team_number" as string).on(
      table.organizationId,
      table.teamId,
      table.number
    ),
    index("idx_issues_triage" as string).on(
      table.organizationId,
      table.status,
      table.snoozedUntil
    ),
  ]
);

export const workspaceIssueHistory = sqliteTable(
  "issue_history" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    issueId: text("issue_id" as string).notNull(),
    linearId: text("linear_id" as string),
    field: text("field" as string).notNull(),
    fromValue: text("from_value" as string),
    toValue: text("to_value" as string),
    actorId: text("actor_id" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("issue_history_issue_idx" as string).on(
      table.organizationId,
      table.issueId
    ),
    index("issue_history_created_idx" as string).on(
      table.organizationId,
      table.createdAt
    ),
  ]
);

export const workspaceComments = sqliteTable(
  "comments" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    issueId: text("issue_id" as string).notNull(),
    authorId: text("author_id" as string),
    body: text("body" as string).notNull(),
    externalId: text("external_id" as string),
    externalSource: text("external_source" as string),
    externalAuthor: text("external_author" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("comments_issue_idx" as string).on(
      table.organizationId,
      table.issueId
    ),
    index("comments_external_idx" as string).on(
      table.organizationId,
      table.externalSource,
      table.externalId
    ),
  ]
);

export const workspaceIssueSubscribers = sqliteTable(
  "issue_subscribers" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    issueId: text("issue_id" as string).notNull(),
    linearUserId: text("linear_user_id" as string).notNull(),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("issue_subscribers_issue_idx" as string).on(
      table.organizationId,
      table.issueId
    ),
  ]
);

export const workspaceIssueRelations = sqliteTable(
  "issue_relations" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    fromIssueId: text("from_issue_id" as string).notNull(),
    toIssueId: text("to_issue_id" as string).notNull(),
    type: text("type" as string).notNull(),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("issue_relations_from_idx" as string).on(
      table.organizationId,
      table.fromIssueId
    ),
    index("issue_relations_to_idx" as string).on(
      table.organizationId,
      table.toIssueId
    ),
  ]
);

export const workspaceIssueApprovals = sqliteTable(
  "issue_approvals" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    issueId: text("issue_id" as string).notNull(),
    requestedById: text("requested_by_id" as string).notNull(),
    approverId: text("approver_id" as string).notNull(),
    status: text("status" as string, {
      enum: ["pending", "approved", "rejected"],
    })
      .notNull()
      .default("pending"),
    comment: text("comment" as string),
    createdAt: text("created_at" as string).notNull(),
    resolvedAt: text("resolved_at" as string),
  },
  (table) => [index("issue_approvals_issue_idx" as string).on(table.issueId)]
);

export const workspaceReactions = sqliteTable(
  "reactions" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    targetType: text("target_type" as string).notNull(),
    targetId: text("target_id" as string).notNull(),
    actorId: text("actor_id" as string).notNull(),
    emoji: text("emoji" as string).notNull(),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("reactions_target_idx" as string).on(
      table.organizationId,
      table.targetType,
      table.targetId
    ),
    uniqueIndex("reactions_unique_idx" as string).on(
      table.organizationId,
      table.targetType,
      table.targetId,
      table.actorId,
      table.emoji
    ),
  ]
);

export const workspaceAttachments = sqliteTable(
  "attachments" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    issueId: text("issue_id" as string).notNull(),
    linearId: text("linear_id" as string).notNull(),
    url: text("url" as string).notNull(),
    title: text("title" as string),
    subtitle: text("subtitle" as string),
    r2Key: text("r2_key" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("attachments_issue_idx" as string).on(
      table.organizationId,
      table.issueId
    ),
  ]
);

export const workspaceNotifications = sqliteTable(
  "notifications" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    recipientId: text("recipient_id" as string).notNull(),
    recipientType: text("recipient_type" as string)
      .notNull()
      .default("user"),
    issueId: text("issue_id" as string).notNull(),
    type: text("type" as string).notNull(),
    read: integer("read" as string, { mode: "boolean" })
      .notNull()
      .default(false),
    snoozedUntil: text("snoozed_until" as string),
    metadata: text("metadata" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("notifications_recipient_idx" as string).on(
      table.organizationId,
      table.recipientId,
      table.recipientType,
      table.read
    ),
    index("notifications_issue_idx" as string).on(
      table.organizationId,
      table.issueId
    ),
  ]
);

export const workspaceSavedViews = sqliteTable(
  "saved_views" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    ownerId: text("owner_id" as string).notNull(),
    name: text("name" as string).notNull(),
    shared: integer("shared" as string, { mode: "boolean" })
      .notNull()
      .default(false),
    filter: text("filter" as string).notNull(),
    search: text("search" as string),
    sort: text("sort" as string),
    columns: text("columns" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("saved_views_organization_idx" as string).on(table.organizationId),
    index("saved_views_owner_idx" as string).on(
      table.organizationId,
      table.ownerId
    ),
  ]
);

export const workspaceViewFavorites = sqliteTable(
  "view_favorites" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    viewId: text("view_id" as string).notNull(),
    userId: text("user_id" as string).notNull(),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("view_favorites_view_user_idx" as string).on(
      table.viewId,
      table.userId
    ),
  ]
);

export const workspaceUserPreferences = sqliteTable(
  "user_workspace_preferences" as string,
  {
    organizationId: text("organization_id" as string).notNull(),
    userId: text("user_id" as string).notNull(),
    defaultViewId: text("default_view_id" as string),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })]
);

export const workspaceLinearUsers = sqliteTable(
  "linear_users" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    linearId: text("linear_id" as string).notNull(),
    name: text("name" as string),
    email: text("email" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("linear_users_organization_idx" as string).on(table.organizationId),
    index("linear_users_linear_idx" as string).on(
      table.organizationId,
      table.linearId
    ),
  ]
);

export const workspaceAgentSessions = sqliteTable(
  "agent_sessions" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    issueId: text("issue_id" as string).notNull(),
    agentId: text("agent_id" as string).notNull(),
    provider: text("provider" as string).notNull(),
    actorId: text("actor_id" as string).notNull(),
    actorType: text("actor_type" as string, {
      enum: ["user", "agent"],
    }).notNull(),
    status: text("status" as string, {
      enum: [
        "created",
        "running",
        "waiting",
        "completed",
        "failed",
        "canceled",
      ],
    })
      .notNull()
      .default("created"),
    result: text("result" as string),
    url: text("url" as string),
    providerSessionId: text("provider_session_id" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("agent_sessions_organization_idx" as string).on(
      table.organizationId,
      table.createdAt,
      table.id
    ),
    index("agent_sessions_issue_idx" as string).on(table.issueId),
  ]
);

export const workspaceAgentActivities = sqliteTable(
  "agent_activities" as string,
  {
    id: text("id" as string).primaryKey(),
    sessionId: text("session_id" as string).notNull(),
    actorId: text("actor_id" as string),
    type: text("type" as string, {
      enum: ["thought", "response", "error", "elicitation", "action", "status"],
    }).notNull(),
    message: text("message" as string).notNull(),
    payload: text("payload" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("agent_activities_session_idx" as string).on(
      table.sessionId,
      table.createdAt
    ),
  ]
);

export const workspaceWebhookSubscriptions = sqliteTable(
  "webhook_subscriptions" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    url: text("url" as string).notNull(),
    events: text("events" as string)
      .notNull()
      .default("*"),
    secret: text("secret" as string)
      .notNull()
      .default(""),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("webhook_subscriptions_organization_idx" as string).on(
      table.organizationId
    ),
  ]
);

export const workspaceOutboundWebhookDeliveries = sqliteTable(
  "outbound_webhook_deliveries" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    subscriptionId: text("subscription_id" as string).notNull(),
    event: text("event" as string).notNull(),
    payload: text("payload" as string).notNull(),
    url: text("url" as string).notNull(),
    status: text("status" as string)
      .notNull()
      .default("pending"),
    statusCode: integer("status_code" as string, { mode: "number" }),
    error: text("error" as string),
    attemptCount: integer("attempt_count" as string, { mode: "number" })
      .notNull()
      .default(1),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("outbound_webhook_deliveries_organization_idx" as string).on(
      table.organizationId
    ),
    index("outbound_webhook_deliveries_subscription_idx" as string).on(
      table.subscriptionId
    ),
  ]
);

export const workspaceAgentProviderConfigs = sqliteTable(
  "agent_provider_configs" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    agentId: text("agent_id" as string).notNull(),
    token: text("token" as string),
    providerOrgId: text("provider_org_id" as string),
    outpost: text("outpost" as string),
    outpostId: text("outpost_id" as string),
    outpostToken: text("outpost_token" as string),
    computeApiKey: text("compute_api_key" as string),
    computeApiUrl: text("compute_api_url" as string),
    computeSnapshot: text("compute_snapshot" as string),
    computeVolumeId: text("compute_volume_id" as string),
    config: text("config" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("agent_provider_configs_org_agent_idx" as string).on(
      table.organizationId,
      table.agentId
    ),
  ]
);
