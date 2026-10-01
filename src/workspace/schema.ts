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
    externalRef: text("external_ref" as string),
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
    prCheckState: text("pr_check_state" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("idx_issues_status" as string).on(table.status, table.createdAt),
    uniqueIndex("idx_issues_repo_branch" as string).on(
      table.repo,
      table.branch
    ),
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
    uniqueIndex("idx_issues_external_ref" as string).on(
      table.organizationId,
      table.externalRef
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
    issueId: text("issue_id" as string),
    documentId: text("document_id" as string),
    authorId: text("author_id" as string),
    body: text("body" as string).notNull(),
    internal: integer("internal" as string, { mode: "boolean" })
      .notNull()
      .default(false),
    externalId: text("external_id" as string),
    externalSource: text("external_source" as string),
    externalAuthor: text("external_author" as string),
    resolvedAt: text("resolved_at" as string),
    resolvedById: text("resolved_by_id" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("comments_issue_idx" as string).on(
      table.organizationId,
      table.issueId
    ),
    index("comments_document_idx" as string).on(
      table.organizationId,
      table.documentId
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

// Documents: Linear-style block documents. `content` is a BlockNote document
// (JSON array of blocks) — the de-facto open-source block schema (TipTap/
// ProseMirror underneath), renderable by BlockNote/shadcn editors and
// convertible to markdown.
export const workspaceDocuments = sqliteTable(
  "documents" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    title: text("title" as string).notNull(),
    icon: text("icon" as string),
    // "blocks" = BlockNote JSON; "markdown" = raw markdown (agent-native).
    contentFormat: text("content_format" as string, {
      enum: ["blocks", "markdown"],
    })
      .notNull()
      .default("blocks"),
    // BlockNote JSON or markdown, per contentFormat.
    content: text("content" as string)
      .notNull()
      .default("[]"),
    // Optional stable slug for public docs-site URLs.
    slug: text("slug" as string),
    projectId: text("project_id" as string),
    issueId: text("issue_id" as string),
    initiativeId: text("initiative_id" as string),
    parentDocumentId: text("parent_document_id" as string),
    spaceId: text("space_id" as string),
    isTemplate: integer("is_template" as string, { mode: "boolean" })
      .notNull()
      .default(false),
    createdById: text("created_by_id" as string).notNull(),
    updatedById: text("updated_by_id" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
    trashedAt: text("trashed_at" as string),
  },
  (table) => [
    index("documents_organization_idx" as string).on(table.organizationId),
    index("documents_project_idx" as string).on(
      table.organizationId,
      table.projectId
    ),
    index("documents_issue_idx" as string).on(
      table.organizationId,
      table.issueId
    ),
    index("documents_parent_idx" as string).on(
      table.organizationId,
      table.parentDocumentId
    ),
  ]
);

// Document spaces: Confluence/Docmost-style top-level containers.
export const workspaceDocumentSpaces = sqliteTable(
  "document_spaces" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    name: text("name" as string).notNull(),
    description: text("description" as string),
    icon: text("icon" as string),
    publicSharing: integer("public_sharing" as string, { mode: "boolean" })
      .notNull()
      .default(true),
    createdById: text("created_by_id" as string).notNull(),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("document_spaces_organization_idx" as string).on(
      table.organizationId
    ),
  ]
);

// Public share links for documents (GitBook/Docmost "publish").
export const workspaceDocumentShares = sqliteTable(
  "document_shares" as string,
  {
    token: text("token" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    documentId: text("document_id" as string).notNull(),
    includeChildren: integer("include_children" as string, {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    createdById: text("created_by_id" as string).notNull(),
    createdAt: text("created_at" as string).notNull(),
    expiresAt: text("expires_at" as string),
  },
  (table) => [
    index("document_shares_document_idx" as string).on(
      table.organizationId,
      table.documentId
    ),
  ]
);

// Watch a document → included in notification fanout on doc changes.
export const workspaceDocumentWatchers = sqliteTable(
  "document_watchers" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    documentId: text("document_id" as string).notNull(),
    userId: text("user_id" as string).notNull(),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("document_watchers_doc_user_idx" as string).on(
      table.documentId,
      table.userId
    ),
  ]
);

// Per-document access grants. When a doc has no rows it is open to the
// workspace; any row restricts it to listed actors (+ workspace admins).
export const workspaceDocumentPermissions = sqliteTable(
  "document_permissions" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    documentId: text("document_id" as string).notNull(),
    actorId: text("actor_id" as string).notNull(),
    actorType: text("actor_type" as string)
      .notNull()
      .default("user"),
    level: text("level" as string, { enum: ["view", "edit"] })
      .notNull()
      .default("view"),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("document_permissions_doc_actor_idx" as string).on(
      table.documentId,
      table.actorId
    ),
  ]
);

// Links extracted from document content (issue identifiers, [[doc]] refs).
export const workspaceDocumentLinks = sqliteTable(
  "document_links" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    documentId: text("document_id" as string).notNull(),
    targetType: text("target_type" as string).notNull(),
    targetId: text("target_id" as string).notNull(),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("document_links_document_idx" as string).on(
      table.organizationId,
      table.documentId
    ),
    index("document_links_target_idx" as string).on(
      table.organizationId,
      table.targetType,
      table.targetId
    ),
  ]
);

export const workspaceDocumentHistory = sqliteTable(
  "document_content_history" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    documentId: text("document_id" as string).notNull(),
    content: text("content" as string).notNull(),
    contentFormat: text("content_format" as string, {
      enum: ["blocks", "markdown"],
    })
      .notNull()
      .default("blocks"),
    actorId: text("actor_id" as string).notNull(),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("document_history_document_idx" as string).on(
      table.documentId,
      table.createdAt
    ),
  ]
);

// Per-user notification delivery preferences (Linear
// notificationDeliveryPreferences).
export const workspaceNotificationPreferences = sqliteTable(
  "notification_preferences" as string,
  {
    organizationId: text("organization_id" as string).notNull(),
    userId: text("user_id" as string).notNull(),
    inApp: integer("in_app" as string, { mode: "boolean" })
      .notNull()
      .default(true),
    webhook: integer("webhook" as string, { mode: "boolean" })
      .notNull()
      .default(true),
    email: integer("email" as string, { mode: "boolean" })
      .notNull()
      .default(false),
    // Comma-separated event types the user wants suppressed entirely.
    mutedTypes: text("muted_types" as string),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })]
);

// Audit log: who did what to which entity, workspace-scoped (Linear's
// auditEntries equivalent).
export const workspaceAuditLog = sqliteTable(
  "audit_log" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    actorId: text("actor_id" as string),
    actorType: text("actor_type" as string),
    action: text("action" as string).notNull(),
    entityType: text("entity_type" as string).notNull(),
    entityId: text("entity_id" as string).notNull(),
    // JSON: { field: { from, to } } for updates, or the created payload.
    changes: text("changes" as string),
    // Request context for API-layer emitters; null for internal writes.
    ip: text("ip" as string),
    country: text("country" as string),
    userAgent: text("user_agent" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("audit_log_organization_idx" as string).on(
      table.organizationId,
      table.createdAt
    ),
    index("audit_log_entity_idx" as string).on(
      table.organizationId,
      table.entityType,
      table.entityId
    ),
  ]
);

// Customers: Linear's customer model — organizations you build for, their
// tier/status, and needs linked to issues/projects.
export const workspaceCustomers = sqliteTable(
  "customers" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    name: text("name" as string).notNull(),
    url: text("url" as string),
    logoUrl: text("logo_url" as string),
    externalId: text("external_id" as string),
    tierId: text("tier_id" as string),
    statusId: text("status_id" as string),
    ownerId: text("owner_id" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("customers_organization_idx" as string).on(table.organizationId),
  ]
);

export const workspaceCustomerTiers = sqliteTable(
  "customer_tiers" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    name: text("name" as string).notNull(),
    color: text("color" as string),
    position: integer("position" as string)
      .notNull()
      .default(0),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("customer_tiers_organization_idx" as string).on(table.organizationId),
  ]
);

export const workspaceCustomerStatuses = sqliteTable(
  "customer_statuses" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    name: text("name" as string).notNull(),
    color: text("color" as string),
    position: integer("position" as string)
      .notNull()
      .default(0),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("customer_statuses_organization_idx" as string).on(
      table.organizationId
    ),
  ]
);

export const workspaceCustomerNeeds = sqliteTable(
  "customer_needs" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    customerId: text("customer_id" as string).notNull(),
    issueId: text("issue_id" as string),
    projectId: text("project_id" as string),
    priority: text("priority" as string),
    note: text("note" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("customer_needs_customer_idx" as string).on(
      table.organizationId,
      table.customerId
    ),
    index("customer_needs_issue_idx" as string).on(
      table.organizationId,
      table.issueId
    ),
  ]
);

// Releases: Linear's release pipelines (named ordered stage lists) and
// releases (versioned targets attached to projects).
export const workspaceReleasePipelines = sqliteTable(
  "release_pipelines" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    name: text("name" as string).notNull(),
    // JSON array of stage names, e.g. ["alpha","beta","ga"].
    stages: text("stages" as string)
      .notNull()
      .default("[]"),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("release_pipelines_organization_idx" as string).on(
      table.organizationId
    ),
  ]
);

export const workspaceReleases = sqliteTable(
  "releases" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    name: text("name" as string).notNull(),
    version: text("version" as string),
    projectId: text("project_id" as string),
    pipelineId: text("pipeline_id" as string),
    stage: text("stage" as string),
    status: text("status" as string)
      .notNull()
      .default("planned"),
    targetDate: text("target_date" as string),
    createdById: text("created_by_id" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("releases_organization_idx" as string).on(table.organizationId),
    index("releases_project_idx" as string).on(
      table.organizationId,
      table.projectId
    ),
  ]
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
    prUrl: text("pr_url" as string),
    prState: text("pr_state" as string),
    branch: text("branch" as string),
    startedAt: text("started_at" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
    lastProgressAt: text("last_progress_at" as string),
    lastStateHash: text("last_state_hash" as string),
    retryOf: text("retry_of" as string),
    retryCount: integer("retry_count" as string)
      .notNull()
      .default(0),
    infraFailure: integer("infra_failure" as string)
      .notNull()
      .default(0),
    // Sequenced dispatch: when set the session sits in `waiting` until the
    // blocker session reaches a terminal state (PILE-214 collision queue).
    queuedAfter: text("queued_after" as string),
    // Agent-spawned lanes: which session created this one + how deep the
    // spawn chain is, so the children route can enforce MAX_SPAWN_DEPTH.
    parentSessionId: text("parent_session_id" as string),
    spawnDepth: integer("spawn_depth" as string)
      .notNull()
      .default(0),
    // Lane-scoped preview DB (PILE-212): JSON handle describing the
    // provisioned branch/role so teardown can run on terminal state.
    laneDbRef: text("lane_db_ref" as string),
    // "preflight" marks a planner-critique lane (VTX-209): repo-less session
    // on the target provider whose only job is to flag missing/ambiguous
    // ticket context before tokens get spent implementing the wrong thing.
    purpose: text("purpose" as string),
    // First transition into a terminal status — the kept-sandbox reaper
    // anchors its resume window here; updatedAt churns on every write.
    endedAt: text("ended_at" as string),
    // Cross-repo lane (PILE-294): JSON [{repo, access}] of sibling repos
    // cloned under ~/xrepo — persisted so queue promotion, retries, and the
    // lane token-refresh route see the same set as the original dispatch.
    secondaryRepos: text("secondary_repos" as string),
    // PILE-293 — dispatch-time run budget (minutes) and model tier.
    maxDurationMinutes: integer("max_duration_minutes" as string),
    effort: text("effort" as string, {
      enum: ["low", "medium", "high", "max"],
    }),
    // PILE-289 — run name for logs/`pile fleet`, and the dispatch-time
    // JSON Schema (draft-07) the lane's final output is validated against.
    // structuredResult holds the validated JSON; resultSchemaErrors the
    // JSON array of validation failures. At most one of the two is set.
    label: text("label" as string),
    resultSchema: text("result_schema" as string),
    structuredResult: text("structured_result" as string),
    resultSchemaErrors: text("result_schema_errors" as string),
  },
  (table) => [
    index("agent_sessions_organization_idx" as string).on(
      table.organizationId,
      table.createdAt,
      table.id
    ),
    index("agent_sessions_issue_idx" as string).on(table.issueId),
    index("agent_sessions_provider_session_idx" as string).on(
      table.organizationId,
      table.providerSessionId
    ),
  ]
);

export const workspaceAgentActivities = sqliteTable(
  "agent_activities" as string,
  {
    id: text("id" as string).primaryKey(),
    sessionId: text("session_id" as string).notNull(),
    actorId: text("actor_id" as string),
    type: text("type" as string, {
      enum: [
        "thought",
        "response",
        "error",
        "elicitation",
        "action",
        "status",
        "artifact",
      ],
    }).notNull(),
    message: text("message" as string).notNull(),
    payload: text("payload" as string),
    parentId: text("parent_id" as string),
    startedAt: text("started_at" as string),
    endedAt: text("ended_at" as string),
    durationMs: integer("duration_ms" as string, { mode: "number" }),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("agent_activities_session_idx" as string).on(
      table.sessionId,
      table.createdAt
    ),
  ]
);

export const workspaceAgentSessionEvents = sqliteTable(
  "agent_session_events" as string,
  {
    id: integer("id" as string, { mode: "number" }).primaryKey({
      autoIncrement: true,
    }),
    sessionId: text("session_id" as string).notNull(),
    type: text("type" as string).notNull(),
    message: text("message" as string).notNull(),
    payload: text("payload" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("agent_session_events_session_idx" as string).on(
      table.sessionId,
      table.id
    ),
  ]
);

// PILE-211: declarative lane triggers. `triggerKind` is "cron" or "event";
// `triggerValue` is the 5-field cron expression or the event name
// (issue.assigned / issue.commented / pr.ci_failed). concurrencyKey defaults
// to the target issue id — the existing one-active-session-per-issue guard
// does the dedupe.
export const workspaceAgentAutomations = sqliteTable(
  "agent_automations" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    name: text("name" as string).notNull(),
    prompt: text("prompt" as string).notNull(),
    agentId: text("agent_id" as string).notNull(),
    teamId: text("team_id" as string),
    issueId: text("issue_id" as string),
    triggerKind: text("trigger_kind" as string, {
      enum: ["cron", "event"],
    }).notNull(),
    triggerValue: text("trigger_value" as string).notNull(),
    enabled: integer("enabled" as string)
      .notNull()
      .default(1),
    lastFiredAt: text("last_fired_at" as string),
    createdBy: text("created_by" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("agent_automations_org_idx" as string).on(table.organizationId),
    index("agent_automations_issue_idx" as string).on(table.issueId),
  ]
);

export const workspaceMcpServers = sqliteTable(
  "mcp_servers" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    name: text("name" as string).notNull(),
    url: text("url" as string).notNull(),
    scope: text("scope" as string, {
      enum: ["workspace", "repo", "issue"],
    }).notNull(),
    repo: text("repo" as string),
    issueId: text("issue_id" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("mcp_servers_organization_idx" as string).on(table.organizationId),
    index("mcp_servers_scope_idx" as string).on(
      table.organizationId,
      table.scope
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
    teamIds: text("team_ids" as string),
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

export const externalLinks = sqliteTable(
  "external_links" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    // Legacy NOT NULL column from the pre-v24 `issue_external_links` table —
    // SQLite can't relax it, so inserts keep it populated ("" for non-issue
    // entities). Reads all go through entity_type/entity_id.
    issueId: text("issue_id" as string)
      .notNull()
      .default(""),
    entityType: text("entity_type" as string).notNull(),
    entityId: text("entity_id" as string).notNull(),
    url: text("url" as string).notNull(),
    label: text("label" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("external_links_organization_idx" as string).on(table.organizationId),
    index("external_links_entity_idx" as string).on(
      table.organizationId,
      table.entityType,
      table.entityId
    ),
  ]
);

export const timeSchedules = sqliteTable(
  "time_schedules" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    name: text("name" as string).notNull(),
    timeData: text("time_data" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("time_schedules_organization_idx" as string).on(table.organizationId),
  ]
);

export const gitAutomationStates = sqliteTable(
  "git_automation_states" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    stateId: text("state_id" as string).notNull(),
    prState: text("pr_state" as string).notNull(),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("git_automation_states_organization_idx" as string).on(
      table.organizationId
    ),
    index("git_automation_states_state_idx" as string).on(
      table.organizationId,
      table.stateId
    ),
  ]
);

export const gitAutomationTargetBranches = sqliteTable(
  "git_automation_target_branches" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    name: text("name" as string).notNull(),
    pattern: text("pattern" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("git_automation_target_branches_organization_idx" as string).on(
      table.organizationId
    ),
  ]
);

export const workspaceGitIdentities = sqliteTable(
  "git_identities" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    repo: text("repo" as string).notNull(),
    name: text("name" as string).notNull(),
    email: text("email" as string).notNull(),
    githubUsername: text("github_username" as string),
    signingKeyRef: text("signing_key_ref" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("git_identities_org_repo_idx" as string).on(
      table.organizationId,
      table.repo
    ),
  ]
);

export const workspaceAgentEnvironmentFiles = sqliteTable(
  "agent_environment_files" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    path: text("path" as string).notNull(),
    content: text("content" as string).notNull(),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("agent_environment_files_path_idx" as string).on(
      table.organizationId,
      table.path
    ),
  ]
);
