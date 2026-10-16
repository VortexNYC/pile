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
        "skipped",
      ] as const,
    }),
    // PILE-412 — the stage-gate's skip justification; also free text for
    // other resolutions (side paths like Passed/Declined record a reason).
    resolutionReason: text("resolution_reason" as string),
    assigneeId: text("assignee_id" as string),
    // PILE-417 — Linear's delegate model: assigneeId is the accountable
    // human; delegateId is the agent acting on their behalf.
    delegateId: text("delegate_id" as string),
    // PILE-430 — atomic claim/lease: claimedBy is the holder,
    // claimedLeaseExpiresAt the lease deadline (ISO), claimEpoch the
    // fencing token bumped on every claim-state write. Claims go through
    // claimIssue/releaseClaim only — never the PATCH path.
    claimedBy: text("claimed_by" as string),
    claimedLeaseExpiresAt: text("claimed_lease_expires_at" as string),
    claimEpoch: integer("claim_epoch" as string)
      .notNull()
      .default(0),
    // PILE-411 — stage-template sub-steps: an issue materialized from a
    // stage_templates row carries its step_key (the (parent, step_key) pair
    // is the re-entry idempotency key), whether the step is required for the
    // stage to complete, and the owning agent's name. ownerAgent stays off
    // delegateId — owner names are pipeline roles (Scout, Profiler), not
    // necessarily registered agent providers.
    stepKey: text("step_key" as string),
    required: integer("required" as string, { mode: "boolean" })
      .notNull()
      .default(false),
    ownerAgent: text("owner_agent" as string),
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
    // PILE-428 — review-gated record: agent-produced writes (comments,
    // field changes, outbound messages) land in draft_outputs pending a
    // human publish instead of taking effect immediately.
    sensitive: integer("sensitive" as string, { mode: "boolean" })
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
    index("idx_issues_delegate" as string).on(table.delegateId),
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
    entityType: text("entity_type" as string),
    entityId: text("entity_id" as string),
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
    index("comments_entity_idx" as string).on(
      table.organizationId,
      table.entityType,
      table.entityId
    ),
    index("comments_external_idx" as string).on(
      table.organizationId,
      table.externalSource,
      table.externalId
    ),
  ]
);

// PILE-428 — agent output held for human review on sensitive records.
// `kind` is the write the agent attempted ("comment" | "field_change" |
// "message"); `payload` is the JSON the publish step replays (comment →
// {body, externalAuthor, externalSource, externalId, internal, authorId,
// mentions}; field_change → {fields: IssuePatch}). Discarded rows stay
// pending-review history — nothing deletes them.
export const workspaceDraftOutputs = sqliteTable(
  "draft_outputs" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    entityType: text("entity_type" as string).notNull(),
    entityId: text("entity_id" as string).notNull(),
    // The issue the review hangs on — same as entityId for issue drafts;
    // carries context (notifications, permissions) for other entities.
    issueId: text("issue_id" as string),
    kind: text("kind" as string, {
      enum: ["comment", "field_change", "message"],
    }).notNull(),
    payload: text("payload" as string).notNull(),
    status: text("status" as string, {
      enum: ["pending", "published", "discarded"],
    })
      .notNull()
      .default("pending"),
    createdById: text("created_by_id" as string),
    sessionId: text("session_id" as string),
    reviewedById: text("reviewed_by_id" as string),
    reviewedAt: text("reviewed_at" as string),
    reviewNote: text("review_note" as string),
    publishedCommentId: text("published_comment_id" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("draft_outputs_entity_idx" as string).on(
      table.organizationId,
      table.entityType,
      table.entityId
    ),
    index("draft_outputs_status_idx" as string).on(
      table.organizationId,
      table.status,
      table.createdAt
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

// Per-issue access grants. When an issue has no rows it is open to the
// workspace; any row restricts it to listed actors (+ workspace admins).
export const workspaceIssuePermissions = sqliteTable(
  "issue_permissions" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    issueId: text("issue_id" as string).notNull(),
    actorId: text("actor_id" as string).notNull(),
    actorType: text("actor_type" as string)
      .notNull()
      .default("user"),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("issue_permissions_issue_actor_idx" as string).on(
      table.issueId,
      table.actorId
    ),
  ]
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
    hiddenSurfaces: text("hidden_surfaces" as string),
    favorites: text("favorites" as string),
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
      enum: ["blocks", "markdown", "canvas"],
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
    // PILE-409: restricted spaces make contained docs deny-by-default —
    // readable only via an explicit document_permissions grant (admins
    // bypass at the API layer).
    restricted: integer("restricted" as string, { mode: "boolean" })
      .notNull()
      .default(false),
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
      enum: ["blocks", "markdown", "canvas"],
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
    // Whether `email` is an explicit choice or the unset default. Rows
    // predating this column are marked explicit so the directed-email
    // default never surprises a member who already has prefs.
    emailExplicit: integer("email_explicit" as string, {
      mode: "boolean",
    })
      .notNull()
      .default(true),
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
    bookingUrl: text("booking_url" as string),
    notes: text("notes" as string),
    domain: text("domain" as string),
    externalId: text("external_id" as string),
    tierId: text("tier_id" as string),
    statusId: text("status_id" as string),
    ownerId: text("owner_id" as string),
    nextStepText: text("next_step_text" as string),
    nextStepDueAt: text("next_step_due_at" as string),
    needsHuman: integer("needs_human" as string, { mode: "boolean" }),
    needsHumanReason: text("needs_human_reason" as string),
    priorityScore: real("priority_score" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("customers_organization_idx" as string).on(table.organizationId),
    index("customers_external_id_idx" as string).on(
      table.organizationId,
      table.externalId
    ),
    index("customers_next_step_due_idx" as string).on(
      table.organizationId,
      table.nextStepDueAt
    ),
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

// Entity attachments: R2-backed file uploads scoped to an arbitrary workspace
// entity (entityType + entityId). First consumer is customers (statements,
// photos, onboarding docs); issues/documents can reuse the same plumbing.
export const workspaceEntityAttachments = sqliteTable(
  "entity_attachments" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    entityType: text("entity_type" as string).notNull(),
    entityId: text("entity_id" as string).notNull(),
    fileName: text("file_name" as string).notNull(),
    contentType: text("content_type" as string).notNull(),
    size: integer("size" as string).notNull(),
    r2Key: text("r2_key" as string).notNull(),
    createdById: text("created_by_id" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("entity_attachments_entity_idx" as string).on(
      table.organizationId,
      table.entityType,
      table.entityId
    ),
  ]
);

// Customer intake: inbound mail filed on a customer record (PILE-325).
// Each row is one received email; attachments live in R2 and are referenced
// by key inside the JSON `attachments` column.
export const workspaceCustomerIntakeItems = sqliteTable(
  "customer_intake_items" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    customerId: text("customer_id" as string).notNull(),
    source: text("source" as string)
      .notNull()
      .default("email"),
    inboxId: text("inbox_id" as string),
    fromAddress: text("from_address" as string).notNull(),
    fromName: text("from_name" as string),
    toAddress: text("to_address" as string).notNull(),
    subject: text("subject" as string),
    text: text("text" as string),
    html: text("html" as string),
    // Stable dedup key: the RFC Message-ID, or a hash of the raw MIME when the
    // sender omitted the header. Unique per org so retries can't double-file.
    externalId: text("external_id" as string).notNull(),
    messageId: text("message_id" as string),
    attachments: text("attachments" as string),
    receivedAt: text("received_at" as string).notNull(),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("customer_intake_items_external_idx" as string).on(
      table.organizationId,
      table.externalId
    ),
    index("customer_intake_items_customer_idx" as string).on(
      table.organizationId,
      table.customerId
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
        // PILE-420 — silent lane marker between `running` and the
        // inactivity cancel; non-terminal.
        "stale",
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
    // Sequenced dispatch: while the session sits in `waiting`, this is the
    // blocker session whose terminal state releases it (PILE-214 collision
    // queue). The edge is kept after promotion so an infra-retry can
    // re-anchor to it (PILE-260).
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
    sandboxBackupRef: text("sandbox_backup_ref" as string),
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
    // Incremental review (PILE-286): head sha of the most recent recorded
    // review + a rolling JSON snapshot of verdicts (see agents/review-context).
    lastReviewedSha: text("last_reviewed_sha" as string),
    reviewSummary: text("review_summary" as string),
    // PILE-419 — open elicitation: the id of the unanswered `elicitation`
    // activity that parked this session in `waiting` (suspend: no runtime
    // held while a human thinks). NULL means the session isn't suspended
    // on a question — distinct from queue-parked `waiting` (queuedAfter).
    // awaitingEscalatedAt dedupes the sweep's escalation notification.
    awaitingActivityId: text("awaiting_activity_id" as string),
    awaitingEscalatedAt: text("awaiting_escalated_at" as string),
    // PILE-420 — operator pause hold: dispatch parked this `waiting` lane
    // because its agent type is paused (agent_pauses row). Resume drains
    // holds in createdAt order; the flag clears on promotion or any
    // non-waiting transition.
    paused: integer("paused" as string)
      .notNull()
      .default(0),
    // PILE-423 — the guidance packs this lane was dispatched with, as JSON
    // [{id, name, scope, scopeKey, version}] in injection order (least
    // specific first). Versions resolve against guidance_pack_versions.
    guidance: text("guidance" as string),
    // Pipeline sub-step this lane works (Salesforce-style stage step —
    // drives step-scoped guidance resolution). Persisted so promotion and
    // retries resolve the same scope.
    stepKey: text("step_key" as string),
    // PILE-426 — the agent's published plan checklist: JSON
    // [{content, status}] (pending | inProgress | completed | canceled).
    // Each write replaces the whole array; null = no plan published.
    plan: text("plan" as string),
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
    index("agent_sessions_awaiting_idx" as string).on(
      table.organizationId,
      table.awaitingActivityId
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
        "prompt",
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

// PILE-420 — global pause per agent type. While a row exists for
// (organization_id, agent_id), new dispatches of that agent park as
// `waiting` + `paused`; deleting the row resumes — held lanes drain in
// createdAt order. The row records who paused and why (audit surface).
export const workspaceAgentPauses = sqliteTable(
  "agent_pauses" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    agentId: text("agent_id" as string).notNull(),
    reason: text("reason" as string),
    createdBy: text("created_by" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("agent_pauses_org_agent_idx" as string).on(
      table.organizationId,
      table.agentId
    ),
  ]
);

// PILE-425 — per-agent-type spend/token caps (generalizes VOR-712). One row
// per (org, agentId); agentId "*" is the workspace default applied to agent
// types without their own row. All limits are nullable — an unset field is
// uncapped. Costs are integer USD micros. `lastCapAlertAt` dedupes the
// once-per-day CoS alert a breached cap fires.
export const workspaceAgentSpendCaps = sqliteTable(
  "agent_spend_caps" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    // "*" = workspace default row.
    agentId: text("agent_id" as string).notNull(),
    maxRunsPerDay: integer("max_runs_per_day" as string),
    maxRunsPerMonth: integer("max_runs_per_month" as string),
    maxTokensPerDay: integer("max_tokens_per_day" as string),
    maxTokensPerMonth: integer("max_tokens_per_month" as string),
    maxCostMicrosPerDay: integer("max_cost_micros_per_day" as string),
    maxCostMicrosPerMonth: integer("max_cost_micros_per_month" as string),
    maxTokensPerRun: integer("max_tokens_per_run" as string),
    maxCostMicrosPerRun: integer("max_cost_micros_per_run" as string),
    lastCapAlertAt: text("last_cap_alert_at" as string),
    createdBy: text("created_by" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("agent_spend_caps_org_agent_idx" as string).on(
      table.organizationId,
      table.agentId
    ),
  ]
);

// PILE-425 — one receipt per run: the usage a lane reported (via /report or
// a provider poll result) plus the cost computed from the rate map when the
// provider didn't report spend. Written mid-run on usage reports and
// finalized on the session's terminal transition. `dealId` resolves at
// write time (entity_links deal edge, else the issue's parent ticket) so
// receipts aggregate per agent, step, and deal without joins.
export const workspaceAgentRunReceipts = sqliteTable(
  "agent_run_receipts" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    sessionId: text("session_id" as string).notNull(),
    issueId: text("issue_id" as string).notNull(),
    agentId: text("agent_id" as string).notNull(),
    stepKey: text("step_key" as string),
    dealId: text("deal_id" as string),
    // Session status at last receipt write — "running" for mid-run usage
    // reports, terminal status once the run ends.
    status: text("status" as string)
      .notNull()
      .default("running"),
    model: text("model" as string),
    effort: text("effort" as string),
    inputTokens: integer("input_tokens" as string),
    outputTokens: integer("output_tokens" as string),
    totalTokens: integer("total_tokens" as string),
    toolCalls: integer("tool_calls" as string),
    // LLM cost, USD micros — provider-reported (`costSource` "reported")
    // or computed from the rate map ("rate_map").
    costMicros: integer("cost_micros" as string),
    // Non-LLM spend the lane reports (paid APIs, browsing credits, …).
    externalSpendMicros: integer("external_spend_micros" as string),
    costSource: text("cost_source" as string),
    // 1 when the sweep stopped the run for breaching a per-run cap;
    // `stopReason` carries the human-readable breach ("shows why").
    capExceeded: integer("cap_exceeded" as string)
      .notNull()
      .default(0),
    stopReason: text("stop_reason" as string),
    startedAt: text("started_at" as string),
    endedAt: text("ended_at" as string),
    durationMs: integer("duration_ms" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("agent_run_receipts_session_idx" as string).on(table.sessionId),
    index("agent_run_receipts_org_agent_idx" as string).on(
      table.organizationId,
      table.agentId,
      table.createdAt
    ),
    index("agent_run_receipts_org_step_idx" as string).on(
      table.organizationId,
      table.stepKey
    ),
    index("agent_run_receipts_issue_idx" as string).on(table.issueId),
    index("agent_run_receipts_deal_idx" as string).on(
      table.organizationId,
      table.dealId
    ),
  ]
);

// PILE-423 — guidance packs (Linear's "Guidance"): markdown instruction
// blocks injected into the dispatch prompt envelope. `scope` picks the level
// — workspace applies to every lane, team matches the issue's teamId, status
// matches the issue's workflow status, step matches the session's stepKey
// (scope_key NULL for workspace). `links` is a JSON array of
// {label?, url} references rendered with the body. `version` bumps on every
// update; guidance_pack_versions keeps each revision so a session's recorded
// refs resolve to the exact text it was dispatched with.
export const workspaceGuidancePacks = sqliteTable(
  "guidance_packs" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    name: text("name" as string).notNull(),
    scope: text("scope" as string, {
      enum: ["workspace", "team", "status", "step"],
    }).notNull(),
    scopeKey: text("scope_key" as string),
    body: text("body" as string).notNull(),
    links: text("links" as string),
    version: integer("version" as string)
      .notNull()
      .default(1),
    createdBy: text("created_by" as string),
    updatedBy: text("updated_by" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("guidance_packs_scope_idx" as string).on(
      table.organizationId,
      table.scope,
      table.scopeKey
    ),
  ]
);

export const workspaceGuidancePackVersions = sqliteTable(
  "guidance_pack_versions" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    packId: text("pack_id" as string).notNull(),
    version: integer("version" as string).notNull(),
    name: text("name" as string).notNull(),
    body: text("body" as string).notNull(),
    links: text("links" as string),
    actorId: text("actor_id" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("guidance_pack_versions_pack_idx" as string).on(
      table.packId,
      table.version
    ),
  ]
);

// PILE-411 — stage templates (Salesforce Flow Orchestration style): one row
// per sub-step definition for a (entityType, status) stage. Entering the
// status materializes one sub-issue per applicable definition.
// `status`/`stepKey` are normalized slug keys (stageKey() in the data
// layer). `entityType` is the transitioning record: "issue" matches
// issue.status, "deal" matches deal.stage, "customer" matches the customer
// status name. `condition` is an optional JSON rule ({field, equals?})
// evaluated against the record's fields + custom field values. `teamId`
// restricts firing to issues of one team (null = all).
export const workspaceStageTemplates = sqliteTable(
  "stage_templates" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    entityType: text("entity_type" as string, {
      enum: ["issue", "deal", "customer"],
    })
      .notNull()
      .default("issue"),
    status: text("status" as string).notNull(),
    stepKey: text("step_key" as string).notNull(),
    title: text("title" as string).notNull(),
    required: integer("required" as string, { mode: "boolean" })
      .notNull()
      .default(true),
    ownerAgent: text("owner_agent" as string),
    condition: text("condition" as string),
    position: integer("position" as string)
      .notNull()
      .default(0),
    teamId: text("team_id" as string),
    createdBy: text("created_by" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("stage_templates_status_step_idx" as string).on(
      table.organizationId,
      table.entityType,
      table.status,
      table.stepKey
    ),
    index("stage_templates_lookup_idx" as string).on(
      table.organizationId,
      table.entityType,
      table.status
    ),
  ]
);

// PILE-401/405/413 — the pipeline runtime's durable event outbox. The DO
// records domain events at mutation points (a record enters a stage, a
// sub-step becomes actionable, the last required sub-step closes); the
// worker layer drains them into agent dispatches and stage policy. This
// decouples DO writes from provider calls and makes every trigger durable —
// an undrained event survives the request that produced it (the 5-minute
// sweep is the backstop).
export const workspaceDomainEvents = sqliteTable(
  "domain_events" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    type: text("type" as string, {
      enum: [
        "record.stage_entered",
        "substep.actionable",
        "substeps.all_required_done",
      ],
    }).notNull(),
    payload: text("payload" as string).notNull(),
    dedupeKey: text("dedupe_key" as string),
    status: text("status" as string, {
      enum: ["pending", "delivered", "failed"],
    })
      .notNull()
      .default("pending"),
    error: text("error" as string),
    attempts: integer("attempts" as string)
      .notNull()
      .default(0),
    createdAt: text("created_at" as string).notNull(),
    deliveredAt: text("delivered_at" as string),
  },
  (table) => [
    index("domain_events_pending_idx" as string).on(
      table.organizationId,
      table.status,
      table.createdAt
    ),
    index("domain_events_dedupe_idx" as string).on(
      table.organizationId,
      table.type,
      table.dedupeKey
    ),
  ]
);

// PILE-401/413 — per-stage config: which pod agent a stage belongs to (the
// VOR-701 agent-per-stage model), the instructions/job-spec override, and
// the advance policy applied when the stage's required sub-steps all close
// — `auto` moves the record to the next stage (which materializes the next
// checklist), `ready_flag` marks needsHuman so a person reviews the move,
// `none` leaves advancement manual.
export const workspaceStageConfigs = sqliteTable(
  "stage_configs" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    entityType: text("entity_type" as string, {
      enum: ["issue", "deal", "customer"],
    })
      .notNull()
      .default("issue"),
    status: text("status" as string).notNull(),
    ownerAgent: text("owner_agent" as string),
    instructions: text("instructions" as string),
    advancePolicy: text("advance_policy" as string, {
      enum: ["none", "auto", "ready_flag"],
    })
      .notNull()
      .default("none"),
    enabled: integer("enabled" as string)
      .notNull()
      .default(1),
    createdBy: text("created_by" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("stage_configs_stage_idx" as string).on(
      table.organizationId,
      table.entityType,
      table.status
    ),
  ]
);

// PILE-405 — the agent registry: a slug like "sales-scout" maps to a
// provider + job spec + tool scope. `owner_agent` on stage templates and
// sub-steps resolves through this table; engineering is one registered
// type, not the implicit whole.
export const workspaceAgentTypes = sqliteTable(
  "agent_types" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    slug: text("slug" as string).notNull(),
    name: text("name" as string).notNull(),
    providerAgentId: text("provider_agent_id" as string).notNull(),
    jobSpec: text("job_spec" as string),
    toolScope: text("tool_scope" as string),
    permissionsTier: text("permissions_tier" as string),
    enabled: integer("enabled" as string)
      .notNull()
      .default(1),
    createdBy: text("created_by" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("agent_types_slug_idx" as string).on(
      table.organizationId,
      table.slug
    ),
  ]
);

// PILE-422 — inbound external events complete stage sub-steps (the Stripe
// Connect requirements model: a server-side provider event, not an agent
// claim, clears the step). A mapping binds (source, eventType) to a
// stepKey; `entityType` + `matchPath` resolve the payload to a record —
// deal/customer external_id or issue external_ref. `secret` is the
// HMAC-SHA256 credential each delivery's signature is verified against.
export const workspaceExternalEventMappings = sqliteTable(
  "external_event_mappings" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    source: text("source" as string).notNull(),
    eventType: text("event_type" as string).notNull(),
    entityType: text("entity_type" as string, {
      enum: ["issue", "deal", "customer"],
    }).notNull(),
    matchPath: text("match_path" as string).notNull(),
    stepKey: text("step_key" as string).notNull(),
    secret: text("secret" as string).notNull(),
    enabled: integer("enabled" as string, { mode: "boolean" })
      .notNull()
      .default(true),
    createdBy: text("created_by" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("external_event_mappings_event_idx" as string).on(
      table.organizationId,
      table.source,
      table.eventType
    ),
    index("external_event_mappings_source_idx" as string).on(
      table.organizationId,
      table.source
    ),
  ]
);

// PILE-422 — dedupe ledger and event log for inbound external events. One
// row per delivery keyed by (organization_id, source, dedupe_key); dedupe
// key is the provider event id when the source sends one, else a SHA-256
// of the raw body so id-less replays still collapse. `status` records the
// outcome (applied / already_done / no_step / no_record / unmapped /
// invalid_payload / invalid_signature); `payload` is the evidence.
export const workspaceExternalEventDeliveries = sqliteTable(
  "external_event_deliveries" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    source: text("source" as string).notNull(),
    eventType: text("event_type" as string),
    eventId: text("event_id" as string),
    dedupeKey: text("dedupe_key" as string).notNull(),
    status: text("status" as string).notNull(),
    entityType: text("entity_type" as string),
    entityId: text("entity_id" as string),
    completedIssueIds: text("completed_issue_ids" as string),
    payload: text("payload" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("external_event_deliveries_dedupe_idx" as string).on(
      table.organizationId,
      table.source,
      table.dedupeKey
    ),
    index("external_event_deliveries_org_idx" as string).on(
      table.organizationId,
      table.createdAt
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
    // Best-effort probe recorded when the URL is written —
    // verified | failed | unreachable | unchecked (PILE-429).
    verificationStatus: text("verification_status" as string, {
      enum: ["verified", "failed", "unreachable", "unchecked"],
    })
      .notNull()
      .default("unchecked"),
    verifiedAt: text("verified_at" as string),
    resolvedUrl: text("resolved_url" as string),
    resolvedTitle: text("resolved_title" as string),
    httpStatus: integer("http_status" as string),
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

// Deals: the CRM pipeline — deals belong to customers and link to
// contacts (support customers), with stage + amount + expected close.
export const workspaceDeals = sqliteTable(
  "deals" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    customerId: text("customer_id" as string).notNull(),
    name: text("name" as string).notNull(),
    externalId: text("external_id" as string),
    stage: text("stage" as string).notNull(),
    amountCents: integer("amount_cents" as string),
    currency: text("currency" as string),
    expectedCloseAt: text("expected_close_at" as string),
    description: text("description" as string),
    closedAt: text("closed_at" as string),
    archivedAt: text("archived_at" as string),
    nextStepText: text("next_step_text" as string),
    nextStepDueAt: text("next_step_due_at" as string),
    needsHuman: integer("needs_human" as string, { mode: "boolean" }),
    needsHumanReason: text("needs_human_reason" as string),
    priorityScore: real("priority_score" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("deals_organization_idx" as string).on(table.organizationId),
    index("deals_customer_idx" as string).on(table.customerId),
    index("deals_external_id_idx" as string).on(
      table.organizationId,
      table.externalId
    ),
    index("deals_next_step_due_idx" as string).on(
      table.organizationId,
      table.nextStepDueAt
    ),
  ]
);

// Custom fields: field definitions scoped to entity types + their values
// per entity — the "make it yours" layer on issues, customers, deals.
export const workspaceFieldDefinitions = sqliteTable(
  "field_definitions" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    entityType: text("entity_type" as string).notNull(),
    name: text("name" as string).notNull(),
    type: text("type" as string).notNull(),
    options: text("options" as string),
    position: integer("position" as string)
      .notNull()
      .default(0),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("field_definitions_org_entity_idx" as string).on(
      table.organizationId,
      table.entityType
    ),
    uniqueIndex("field_definitions_name_idx" as string).on(
      table.organizationId,
      table.entityType,
      table.name
    ),
  ]
);

export const workspaceFieldValues = sqliteTable(
  "field_values" as string,
  {
    fieldId: text("field_id" as string).notNull(),
    entityId: text("entity_id" as string).notNull(),
    organizationId: text("organization_id" as string).notNull(),
    value: text("value" as string),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.fieldId, table.entityId] }),
    index("field_values_entity_idx" as string).on(
      table.organizationId,
      table.entityId
    ),
  ]
);

// Import receipts: every bulk customer write lands a durable receipt —
// source/corridor, per-row outcomes (created/existing/failed + why) — so a
// re-run is auditable and agents can read batch history later (PILE-403).
export const workspaceImportReceipts = sqliteTable(
  "import_receipts" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    source: text("source" as string),
    corridor: text("corridor" as string),
    rowCount: integer("row_count" as string).notNull(),
    createdCount: integer("created_count" as string).notNull(),
    existingCount: integer("existing_count" as string).notNull(),
    failedCount: integer("failed_count" as string).notNull(),
    // JSON array of per-row receipts: {index, externalId, outcome,
    // customerId?, dealId?, error?}.
    rows: text("rows" as string).notNull(),
    createdById: text("created_by_id" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("import_receipts_org_idx" as string).on(
      table.organizationId,
      table.createdAt
    ),
  ]
);

export const workspaceEntityLinks = sqliteTable(
  "entity_links" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    fromType: text("from_type" as string).notNull(),
    fromId: text("from_id" as string).notNull(),
    toType: text("to_type" as string).notNull(),
    toId: text("to_id" as string).notNull(),
    kind: text("kind" as string)
      .notNull()
      .default("relates"),
    label: text("label" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("entity_links_from_idx" as string).on(
      table.organizationId,
      table.fromType,
      table.fromId
    ),
    index("entity_links_to_idx" as string).on(
      table.organizationId,
      table.toType,
      table.toId
    ),
    uniqueIndex("entity_links_unique_idx" as string).on(
      table.organizationId,
      table.fromType,
      table.fromId,
      table.toType,
      table.toId,
      table.kind
    ),
  ]
);

// One subscriptions model — who watches what. Replaces
// issue_subscribers + document_watchers.
export const workspaceSubscriptions = sqliteTable(
  "subscriptions" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    entityType: text("entity_type" as string).notNull(),
    entityId: text("entity_id" as string).notNull(),
    userId: text("user_id" as string).notNull(),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    uniqueIndex("subscriptions_entity_user_idx" as string).on(
      table.entityType,
      table.entityId,
      table.userId
    ),
    index("subscriptions_entity_idx" as string).on(
      table.organizationId,
      table.entityType,
      table.entityId
    ),
    index("subscriptions_user_idx" as string).on(table.userId),
  ]
);

// One shares model — public links on any entity. Replaces
// issue_shares + document_shares.
export const workspaceShares = sqliteTable(
  "shares" as string,
  {
    token: text("token" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    entityType: text("entity_type" as string).notNull(),
    entityId: text("entity_id" as string).notNull(),
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
    index("shares_entity_idx" as string).on(
      table.organizationId,
      table.entityType,
      table.entityId
    ),
  ]
);

// Triage auto-delegate rules (PILE-427 — Linear triage rules: inbound
// records match ordered conditions, first match wins, and the matched rule
// delegates/sets status on the record's working issue). `conditions` and
// `action` are JSON validated by the zod schemas in
// src/global/triage-rules.ts; recordType scopes which inbound record a
// rule evaluates (lead, intake_item, customer, deal, issue,
// support_ticket).
export const workspaceTriageRules = sqliteTable(
  "triage_rules" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    name: text("name" as string).notNull(),
    recordType: text("record_type" as string).notNull(),
    isActive: integer("is_active" as string, { mode: "boolean" })
      .notNull()
      .default(true),
    sortOrder: integer("sort_order" as string)
      .notNull()
      .default(0),
    conditions: text("conditions" as string).notNull(),
    action: text("action" as string).notNull(),
    createdBy: text("created_by" as string),
    createdAt: text("created_at" as string).notNull(),
    updatedAt: text("updated_at" as string).notNull(),
  },
  (table) => [
    index("triage_rules_org_type_idx" as string).on(
      table.organizationId,
      table.recordType,
      table.isActive,
      table.sortOrder
    ),
  ]
);

// The evaluation log — one row per inbound record evaluated against the
// active rules (when at least one exists): which rule matched (null on
// no_match), the outcome, and a JSON detail of what the action applied.
export const workspaceTriageRuleEvaluations = sqliteTable(
  "triage_rule_evaluations" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string).notNull(),
    recordType: text("record_type" as string).notNull(),
    recordId: text("record_id" as string).notNull(),
    ruleId: text("rule_id" as string),
    ruleName: text("rule_name" as string),
    outcome: text("outcome" as string).notNull(),
    detail: text("detail" as string),
    createdAt: text("created_at" as string).notNull(),
  },
  (table) => [
    index("triage_rule_evaluations_record_idx" as string).on(
      table.organizationId,
      table.recordType,
      table.recordId
    ),
    index("triage_rule_evaluations_org_idx" as string).on(
      table.organizationId,
      table.createdAt
    ),
  ]
);
