import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const repoBranches = sqliteTable(
  "repo_branches" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    repo: text("repo" as string).notNull(),
    branch: text("branch" as string).notNull(),
    issueId: text("issue_id" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("repo_branches_repo_branch_idx" as string).on(
      table.repo,
      table.branch
    ),
  ]
);

export const repoIssues = sqliteTable(
  "repo_issues" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    source: text("source" as string, { enum: ["github", "gitlab"] })
      .notNull()
      .default("github"),
    repo: text("repo" as string).notNull(),
    issueNumber: integer("issue_number" as string).notNull(),
    issueId: text("issue_id" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("repo_issues_source_repo_number_idx" as string).on(
      table.source,
      table.repo,
      table.issueNumber
    ),
    index("repo_issues_organization_idx" as string).on(table.organizationId),
  ]
);

export const intercomConversations = sqliteTable(
  "intercom_conversations" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    conversationId: text("conversation_id" as string).notNull(),
    issueId: text("issue_id" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("intercom_conversations_external_idx" as string).on(
      table.organizationId,
      table.conversationId
    ),
    index("intercom_conversations_issue_idx" as string).on(table.issueId),
  ]
);

export const importJobs = sqliteTable(
  "import_jobs" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    source: text("source" as string).notNull(),
    status: text("status" as string, {
      enum: [
        "pending",
        "pending_approval",
        "running",
        "completed",
        "failed",
        "paused",
      ],
    })
      .notNull()
      .default("pending"),
    options: text("options" as string),
    counts: text("counts" as string),
    cursor: text("cursor" as string),
    error: text("error" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at" as string),
  },
  (table) => [
    index("import_jobs_organization_idx" as string).on(
      table.organizationId,
      table.createdAt
    ),
  ]
);

export const importApprovals = sqliteTable(
  "import_approvals" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    jobId: text("job_id" as string)
      .notNull()
      .references(() => importJobs.id),
    status: text("status" as string, {
      enum: ["pending", "approved", "rejected"],
    })
      .notNull()
      .default("pending"),
    requestedBy: text("requested_by" as string).notNull(),
    approvedBy: text("approved_by" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("import_approvals_job_idx" as string).on(table.jobId),
    index("import_approvals_organization_idx" as string).on(
      table.organizationId
    ),
  ]
);

export const importMappings = sqliteTable(
  "import_mappings" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    jobId: text("job_id" as string)
      .notNull()
      .references(() => importJobs.id),
    source: text("source" as string).notNull(),
    type: text("type" as string, {
      enum: [
        "issue",
        "document",
        "state",
        "label",
        "project",
        "cycle",
        "user",
        "team",
        "template",
        "ticket",
      ],
    }).notNull(),
    externalId: text("external_id" as string).notNull(),
    vortexId: text("vortex_id" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("import_mappings_job_external_idx" as string).on(
      table.jobId,
      table.externalId
    ),
    index("import_mappings_organization_idx" as string).on(
      table.organizationId
    ),
  ]
);

export const importParentLinks = sqliteTable(
  "import_parent_links" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    jobId: text("job_id" as string)
      .notNull()
      .references(() => importJobs.id),
    childId: text("child_id" as string).notNull(),
    parentExternalId: text("parent_external_id" as string).notNull(),
    resolvedAt: text("resolved_at" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("import_parent_links_job_idx" as string).on(table.jobId),
    index("import_parent_links_child_idx" as string).on(table.childId),
    index("import_parent_links_parent_external_idx" as string).on(
      table.jobId,
      table.parentExternalId
    ),
  ]
);

export const githubInstallations = sqliteTable(
  "github_installations" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    installationId: text("installation_id" as string).notNull(),
    repo: text("repo" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("github_installations_repo_idx" as string).on(table.repo),
    index("github_installations_organization_idx" as string).on(
      table.organizationId
    ),
  ]
);

export const gitlabInstallations = sqliteTable(
  "gitlab_installations" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    projectId: text("project_id" as string).notNull(),
    projectPath: text("project_path" as string).notNull(),
    token: text("token" as string).notNull(),
    webhookSecret: text("webhook_secret" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("gitlab_installations_project_path_idx" as string).on(
      table.organizationId,
      table.projectPath
    ),
    index("gitlab_installations_organization_idx" as string).on(
      table.organizationId
    ),
  ]
);

export const issueApprovals = sqliteTable(
  "issue_approvals" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    issueId: text("issue_id" as string).notNull(),
    requestedById: text("requested_by_id" as string).notNull(),
    approverId: text("approver_id" as string).notNull(),
    status: text("status" as string, {
      enum: ["pending", "approved", "rejected"],
    })
      .notNull()
      .default("pending"),
    comment: text("comment" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    resolvedAt: text("resolved_at" as string),
  },
  (table) => [
    index("issue_approvals_issue_idx" as string).on(table.issueId),
    index("issue_approvals_organization_idx" as string).on(
      table.organizationId
    ),
  ]
);

export const projects = sqliteTable(
  "projects" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    name: text("name" as string).notNull(),
    description: text("description" as string),
    status: text("status" as string)
      .notNull()
      .default("active"),
    health: text("health" as string, {
      enum: ["on_track", "at_risk", "off_track", "paused"] as const,
    })
      .notNull()
      .default("on_track"),
    leadId: text("lead_id" as string).references(() => user.id),
    archivedAt: text("archived_at" as string),
    startDate: text("start_date" as string),
    endDate: text("end_date" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("projects_organization_idx" as string).on(table.organizationId),
    index("projects_lead_idx" as string).on(table.leadId),
  ]
);

export const projectMembers = sqliteTable(
  "project_members" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    projectId: text("project_id" as string)
      .notNull()
      .references(() => projects.id),
    userId: text("user_id" as string)
      .notNull()
      .references(() => user.id),
    role: text("role" as string, {
      enum: ["lead", "member"] as const,
    })
      .notNull()
      .default("member"),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("project_members_project_idx" as string).on(table.projectId),
    index("project_members_user_idx" as string).on(table.userId),
    index("project_members_organization_idx" as string).on(
      table.organizationId
    ),
    uniqueIndex("project_members_project_user_unique" as string).on(
      table.projectId,
      table.userId
    ),
  ]
);

export const cycles = sqliteTable(
  "cycles" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    projectId: text("project_id" as string).references(() => projects.id),
    name: text("name" as string).notNull(),
    number: integer("number" as string),
    status: text("status" as string, {
      enum: ["upcoming", "active", "completed"] as const,
    })
      .notNull()
      .default("upcoming"),
    autoRollover: integer("auto_rollover" as string, { mode: "boolean" })
      .notNull()
      .default(true),
    archivedAt: text("archived_at" as string),
    startDate: text("start_date" as string),
    endDate: text("end_date" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("cycles_organization_idx" as string).on(table.organizationId),
    index("cycles_project_idx" as string).on(table.projectId),
  ]
);

export const labels = sqliteTable(
  "labels" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    name: text("name" as string).notNull(),
    color: text("color" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("labels_organization_idx" as string).on(table.organizationId),
  ]
);

export const roadmaps = sqliteTable(
  "roadmaps" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    name: text("name" as string).notNull(),
    description: text("description" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("roadmaps_organization_idx" as string).on(table.organizationId),
    index("roadmaps_org_name_idx" as string).on(
      table.organizationId,
      table.name
    ),
  ]
);

export const initiatives = sqliteTable(
  "initiatives" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    roadmapId: text("roadmap_id" as string).references(() => roadmaps.id),
    name: text("name" as string).notNull(),
    description: text("description" as string),
    status: text("status" as string)
      .notNull()
      .default("active"),
    startDate: text("start_date" as string),
    targetDate: text("target_date" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("initiatives_organization_idx" as string).on(table.organizationId),
    index("initiatives_roadmap_idx" as string).on(table.roadmapId),
  ]
);

export const releases = sqliteTable(
  "releases" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    projectId: text("project_id" as string).references(() => projects.id),
    teamId: text("team_id" as string).references(() => team.id),
    name: text("name" as string).notNull(),
    version: text("version" as string),
    status: text("status" as string, {
      enum: ["upcoming", "in_progress", "released", "archived"] as const,
    })
      .notNull()
      .default("upcoming"),
    notes: text("notes" as string),
    plannedAt: text("planned_at" as string),
    releasedAt: text("released_at" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("releases_organization_idx" as string).on(table.organizationId),
    index("releases_project_idx" as string).on(table.projectId),
    index("releases_team_idx" as string).on(table.teamId),
  ]
);

export const states = sqliteTable(
  "states" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    linearId: text("linear_id" as string).notNull(),
    name: text("name" as string).notNull(),
    type: text("type" as string).notNull(),
    color: text("color" as string),
    position: text("position" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("states_organization_idx" as string).on(table.organizationId),
    index("states_linear_idx" as string).on(
      table.organizationId,
      table.linearId
    ),
  ]
);

export const linearUsers = sqliteTable(
  "linear_users" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    linearId: text("linear_id" as string).notNull(),
    name: text("name" as string),
    email: text("email" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("linear_users_organization_idx" as string).on(table.organizationId),
    index("linear_users_linear_idx" as string).on(
      table.organizationId,
      table.linearId
    ),
    index("linear_users_email_idx" as string).on(table.email),
  ]
);

export const comments = sqliteTable(
  "comments" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    issueId: text("issue_id" as string).notNull(),
    authorId: text("author_id" as string),
    body: text("body" as string).notNull(),
    externalId: text("external_id" as string),
    externalSource: text("external_source" as string),
    externalAuthor: text("external_author" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("comments_issue_idx" as string).on(
      table.organizationId,
      table.issueId
    ),
    index("comments_author_idx" as string).on(
      table.organizationId,
      table.authorId
    ),
    index("comments_external_idx" as string).on(
      table.organizationId,
      table.externalSource,
      table.externalId
    ),
  ]
);

export const reactions = sqliteTable(
  "reactions" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    targetType: text("target_type" as string).notNull(),
    targetId: text("target_id" as string).notNull(),
    actorId: text("actor_id" as string).notNull(),
    emoji: text("emoji" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
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

export const issueRelations = sqliteTable(
  "issue_relations" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    fromIssueId: text("from_issue_id" as string).notNull(),
    toIssueId: text("to_issue_id" as string).notNull(),
    type: text("type" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
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

export const attachments = sqliteTable(
  "attachments" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    issueId: text("issue_id" as string).notNull(),
    linearId: text("linear_id" as string).notNull(),
    url: text("url" as string).notNull(),
    title: text("title" as string),
    subtitle: text("subtitle" as string),
    r2Key: text("r2_key" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("attachments_issue_idx" as string).on(
      table.organizationId,
      table.issueId
    ),
    index("attachments_linear_idx" as string).on(
      table.organizationId,
      table.linearId
    ),
  ]
);

export const emojis = sqliteTable(
  "emojis" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name" as string).notNull(),
    shortcut: text("shortcut" as string).notNull(),
    url: text("url" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("emojis_organizationId_idx" as string).on(table.organizationId),
    index("emojis_shortcut_idx" as string).on(
      table.organizationId,
      table.shortcut
    ),
  ]
);

export const issueHistory = sqliteTable(
  "issue_history" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    issueId: text("issue_id" as string).notNull(),
    linearId: text("linear_id" as string),
    field: text("field" as string).notNull(),
    fromValue: text("from_value" as string),
    toValue: text("to_value" as string),
    actorId: text("actor_id" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
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

export const issueSubscribers = sqliteTable(
  "issue_subscribers" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    issueId: text("issue_id" as string).notNull(),
    linearUserId: text("linear_user_id" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("issue_subscribers_issue_idx" as string).on(
      table.organizationId,
      table.issueId
    ),
    index("issue_subscribers_user_idx" as string).on(
      table.organizationId,
      table.linearUserId
    ),
  ]
);

export const templates = sqliteTable(
  "templates" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    linearId: text("linear_id" as string).notNull(),
    name: text("name" as string).notNull(),
    templateData: text("template_data" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("templates_organization_idx" as string).on(table.organizationId),
    index("templates_linear_idx" as string).on(
      table.organizationId,
      table.linearId
    ),
  ]
);

export const webhookSubscriptions = sqliteTable(
  "webhook_subscriptions" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    url: text("url" as string).notNull(),
    events: text("events" as string)
      .notNull()
      .default("*"),
    secret: text("secret" as string)
      .notNull()
      .default(""),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("webhook_subscriptions_organization_idx" as string).on(
      table.organizationId
    ),
  ]
);

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries" as string,
  {
    deliveryId: text("delivery_id" as string).primaryKey(),
    source: text("source" as string).notNull(),
    event: text("event" as string).notNull(),
    organizationId: text("organization_id" as string).references(
      () => organization.id
    ),
    processedAt: text("processed_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("webhook_deliveries_organization_idx" as string).on(
      table.organizationId
    ),
  ]
);

export const outboundWebhookDeliveries = sqliteTable(
  "outbound_webhook_deliveries" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    subscriptionId: text("subscription_id" as string)
      .notNull()
      .references(() => webhookSubscriptions.id),
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
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
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

export const pushTokens = sqliteTable(
  "push_tokens" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    userId: text("user_id" as string)
      .notNull()
      .references(() => user.id),
    name: text("name" as string),
    provider: text("provider" as string, {
      enum: ["fcm", "apns", "expo"] as const,
    })
      .notNull()
      .default("fcm"),
    token: text("token" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("push_tokens_organization_idx" as string).on(table.organizationId),
    index("push_tokens_user_idx" as string).on(table.userId),
  ]
);

export const pushDeliveries = sqliteTable(
  "push_deliveries" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    tokenId: text("token_id" as string)
      .notNull()
      .references(() => pushTokens.id),
    userId: text("user_id" as string)
      .notNull()
      .references(() => user.id),
    payload: text("payload" as string).notNull(),
    status: text("status" as string)
      .notNull()
      .default("pending"),
    error: text("error" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("push_deliveries_organization_idx" as string).on(
      table.organizationId
    ),
    index("push_deliveries_token_idx" as string).on(table.tokenId),
    index("push_deliveries_user_idx" as string).on(table.userId),
  ]
);

export const emailInboxes = sqliteTable(
  "email_inboxes" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    address: text("address" as string).notNull(),
    teamId: text("team_id" as string),
    projectId: text("project_id" as string).references(() => projects.id),
    enabled: integer("enabled" as string, { mode: "boolean" })
      .notNull()
      .default(true),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("email_inboxes_organization_idx" as string).on(table.organizationId),
    index("email_inboxes_address_idx" as string).on(table.address),
  ]
);

export const usageRecords = sqliteTable(
  "usage_records" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    period: text("period" as string).notNull(),
    resource: text("resource" as string).notNull(),
    action: text("action" as string).notNull(),
    count: integer("count" as string, { mode: "number" })
      .notNull()
      .default(0),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("usage_records_organization_idx" as string).on(table.organizationId),
    index("usage_records_period_idx" as string).on(table.period),
    uniqueIndex("usage_records_period_resource_action_unique" as string).on(
      table.organizationId,
      table.period,
      table.resource,
      table.action
    ),
  ]
);

export const notifications = sqliteTable(
  "notifications" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
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
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
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

export const user = sqliteTable("user" as string, {
  id: text("id" as string).primaryKey(),
  name: text("name" as string).notNull(),
  email: text("email" as string)
    .notNull()
    .unique(),
  emailVerified: integer("email_verified" as string, { mode: "boolean" })
    .notNull()
    .default(false),
  image: text("image" as string),
  metadata: text("metadata" as string),
  createdAt: integer("created_at" as string, { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  updatedAt: integer("updated_at" as string, { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date()),
});

export const session = sqliteTable(
  "session" as string,
  {
    id: text("id" as string).primaryKey(),
    expiresAt: integer("expires_at" as string, {
      mode: "timestamp_ms",
    }).notNull(),
    token: text("token" as string)
      .notNull()
      .unique(),
    createdAt: integer("created_at" as string, { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    updatedAt: integer("updated_at" as string, { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date()),
    ipAddress: text("ip_address" as string),
    userAgent: text("user_agent" as string),
    activeOrganizationId: text("active_organization_id" as string),
    activeTeamId: text("active_team_id" as string),
    userId: text("user_id" as string)
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx" as string).on(table.userId)]
);

export const account = sqliteTable(
  "account" as string,
  {
    id: text("id" as string).primaryKey(),
    accountId: text("account_id" as string).notNull(),
    providerId: text("provider_id" as string).notNull(),
    userId: text("user_id" as string)
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token" as string),
    refreshToken: text("refresh_token" as string),
    idToken: text("id_token" as string),
    accessTokenExpiresAt: integer("access_token_expires_at" as string, {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at" as string, {
      mode: "timestamp_ms",
    }),
    scope: text("scope" as string),
    password: text("password" as string),
    issuer: text("issuer" as string),
    createdAt: integer("created_at" as string, { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    updatedAt: integer("updated_at" as string, { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("account_userId_idx" as string).on(table.userId),
    index("account_provider_idx" as string).on(
      table.providerId,
      table.accountId
    ),
  ]
);

export const verification = sqliteTable("verification" as string, {
  id: text("id" as string).primaryKey(),
  identifier: text("identifier" as string).notNull(),
  value: text("value" as string).notNull(),
  expiresAt: integer("expires_at" as string, {
    mode: "timestamp_ms",
  }).notNull(),
  createdAt: integer("created_at" as string, { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  updatedAt: integer("updated_at" as string, { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date()),
});

export const organization = sqliteTable(
  "organization" as string,
  {
    id: text("id" as string).primaryKey(),
    name: text("name" as string).notNull(),
    slug: text("slug" as string)
      .notNull()
      .unique(),
    logo: text("logo" as string),
    metadata: text("metadata" as string),
    createdAt: integer("created_at" as string, { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    updatedAt: integer("updated_at" as string, { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date()),
  },
  (table) => [index("organization_slug_idx" as string).on(table.slug)]
);

export const member = sqliteTable(
  "member" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id" as string)
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role" as string)
      .notNull()
      .default("member"),
    createdAt: integer("created_at" as string, { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  },
  (table) => [
    index("member_organizationId_idx" as string).on(table.organizationId),
    index("member_userId_idx" as string).on(table.userId),
    index("member_org_user_idx" as string).on(
      table.organizationId,
      table.userId
    ),
  ]
);

export const team = sqliteTable(
  "team" as string,
  {
    id: text("id" as string).primaryKey(),
    name: text("name" as string).notNull(),
    memberCount: integer("member_count" as string, { mode: "number" })
      .notNull()
      .default(0),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    metadata: text("metadata" as string),
    createdAt: integer("created_at" as string, { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    updatedAt: integer("updated_at" as string, { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("team_organizationId_idx" as string).on(table.organizationId),
    index("team_org_name_idx" as string).on(table.organizationId, table.name),
  ]
);

// Better Auth dynamic access control — org-level custom roles.
export const organizationRole = sqliteTable(
  "organization_role" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    role: text("role" as string).notNull(),
    permission: text("permission" as string).notNull(), // JSON Record<string, string[]>
    createdAt: integer("created_at" as string, { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    updatedAt: integer("updated_at" as string, { mode: "timestamp_ms" }),
  },
  (table) => [
    index("organizationRole_organizationId_idx" as string).on(
      table.organizationId
    ),
    index("organizationRole_role_idx" as string).on(
      table.organizationId,
      table.role
    ),
  ]
);

export const teamMember = sqliteTable(
  "team_member" as string,
  {
    id: text("id" as string).primaryKey(),
    teamId: text("team_id" as string)
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    userId: text("user_id" as string)
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role" as string)
      .notNull()
      .default("member"),
    membershipKey: text("membership_key" as string).unique(),
    createdAt: integer("created_at" as string, { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  },
  (table) => [
    index("teamMember_teamId_idx" as string).on(table.teamId),
    index("teamMember_userId_idx" as string).on(table.userId),
    index("teamMember_team_user_idx" as string).on(table.teamId, table.userId),
  ]
);

export const invitation = sqliteTable(
  "invitation" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email" as string).notNull(),
    role: text("role" as string).notNull(),
    status: text("status" as string)
      .notNull()
      .default("pending"),
    teamId: text("team_id" as string).references(() => team.id, {
      onDelete: "cascade",
    }),
    expiresAt: integer("expires_at" as string, {
      mode: "timestamp_ms",
    }).notNull(),
    inviterId: text("inviter_id" as string)
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at" as string, { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  },
  (table) => [
    index("invitation_organizationId_idx" as string).on(table.organizationId),
  ]
);

export const apikey = sqliteTable(
  "apikey" as string,
  {
    id: text("id" as string).primaryKey(),
    configId: text("config_id" as string)
      .notNull()
      .default("default"),
    name: text("name" as string),
    prefix: text("prefix" as string),
    start: text("start" as string),
    key: text("key" as string)
      .notNull()
      .unique(),
    enabled: integer("enabled" as string, { mode: "boolean" })
      .notNull()
      .default(true),
    expiresAt: integer("expires_at" as string, { mode: "timestamp_ms" }),
    referenceId: text("reference_id" as string).notNull(),
    lastRefillAt: integer("last_refill_at" as string, { mode: "timestamp_ms" }),
    lastRequest: integer("last_request" as string, { mode: "timestamp_ms" }),
    metadata: text("metadata" as string),
    rateLimitMax: integer("rate_limit_max" as string),
    rateLimitTimeWindow: integer("rate_limit_time_window" as string),
    remaining: integer("remaining" as string),
    refillAmount: integer("refill_amount" as string),
    refillInterval: integer("refill_interval" as string),
    rateLimitEnabled: integer("rate_limit_enabled" as string, {
      mode: "boolean",
    })
      .notNull()
      .default(true),
    requestCount: integer("request_count" as string)
      .notNull()
      .default(0),
    permissions: text("permissions" as string),
    createdAt: integer("created_at" as string, { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    updatedAt: integer("updated_at" as string, { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("apikey_reference_idx" as string).on(table.referenceId),
    index("apikey_reference_config_idx" as string).on(
      table.referenceId,
      table.configId
    ),
  ]
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const githubUsers = sqliteTable(
  "github_users" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    userId: text("user_id" as string)
      .notNull()
      .references(() => user.id),
    githubLogin: text("github_login" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("github_users_workspace_login_idx" as string).on(
      table.organizationId,
      table.githubLogin
    ),
    uniqueIndex("github_users_workspace_user_idx" as string).on(
      table.organizationId,
      table.userId
    ),
  ]
);

export const gitlabUsers = sqliteTable(
  "gitlab_users" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    userId: text("user_id" as string)
      .notNull()
      .references(() => user.id),
    gitlabUsername: text("gitlab_username" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("gitlab_users_workspace_username_idx" as string).on(
      table.organizationId,
      table.gitlabUsername
    ),
    uniqueIndex("gitlab_users_workspace_user_idx" as string).on(
      table.organizationId,
      table.userId
    ),
  ]
);

export const notionInstallations = sqliteTable(
  "notion_installations" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    workspaceId: text("workspace_id" as string),
    token: text("token" as string).notNull(),
    verificationToken: text("verification_token" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("notion_installations_workspace_idx" as string).on(
      table.organizationId,
      table.workspaceId
    ),
    index("notion_installations_organization_idx" as string).on(
      table.organizationId
    ),
  ]
);

export const notionUsers = sqliteTable(
  "notion_users" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    userId: text("user_id" as string)
      .notNull()
      .references(() => user.id),
    notionUserId: text("notion_user_id" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("notion_users_workspace_user_idx" as string).on(
      table.organizationId,
      table.userId
    ),
    uniqueIndex("notion_users_workspace_notion_idx" as string).on(
      table.organizationId,
      table.notionUserId
    ),
  ]
);

export const notionPageMappings = sqliteTable(
  "notion_page_mappings" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    notionPageId: text("notion_page_id" as string).notNull(),
    documentId: text("document_id" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("notion_page_mappings_workspace_page_idx" as string).on(
      table.organizationId,
      table.notionPageId
    ),
    index("notion_page_mappings_document_idx" as string).on(
      table.organizationId,
      table.documentId
    ),
  ]
);

export const notionIssueMappings = sqliteTable(
  "notion_issue_mappings" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    notionPageId: text("notion_page_id" as string).notNull(),
    issueId: text("issue_id" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("notion_issue_mappings_workspace_page_idx" as string).on(
      table.organizationId,
      table.notionPageId
    ),
    index("notion_issue_mappings_issue_idx" as string).on(
      table.organizationId,
      table.issueId
    ),
  ]
);

export const savedViews = sqliteTable(
  "saved_views" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    ownerId: text("owner_id" as string).notNull(),
    name: text("name" as string).notNull(),
    shared: integer("shared" as string, { mode: "boolean" })
      .notNull()
      .default(false),
    filter: text("filter" as string).notNull(),
    search: text("search" as string),
    sort: text("sort" as string),
    columns: text("columns" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("saved_views_organization_idx" as string).on(table.organizationId),
    index("saved_views_owner_idx" as string).on(
      table.organizationId,
      table.ownerId
    ),
  ]
);

export const viewFavorites = sqliteTable(
  "view_favorites" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    viewId: text("view_id" as string)
      .notNull()
      .references(() => savedViews.id, { onDelete: "cascade" }),
    userId: text("user_id" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("view_favorites_view_user_idx" as string).on(
      table.viewId,
      table.userId
    ),
    index("view_favorites_user_idx" as string).on(
      table.organizationId,
      table.userId
    ),
  ]
);

export const userWorkspacePreferences = sqliteTable(
  "user_workspace_preferences" as string,
  {
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id" as string).notNull(),
    defaultViewId: text("default_view_id" as string).references(
      () => savedViews.id,
      { onDelete: "set null" }
    ),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.userId] })]
);

export const agentSessions = sqliteTable(
  "agent_sessions" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
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
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
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

export const agentActivities = sqliteTable(
  "agent_activities" as string,
  {
    id: text("id" as string).primaryKey(),
    sessionId: text("session_id" as string)
      .notNull()
      .references(() => agentSessions.id),
    actorId: text("actor_id" as string),
    type: text("type" as string, {
      enum: ["thought", "response", "error", "elicitation", "action", "status"],
    }).notNull(),
    message: text("message" as string).notNull(),
    payload: text("payload" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("agent_activities_session_idx" as string).on(
      table.sessionId,
      table.createdAt
    ),
  ]
);

export const slackInstallations = sqliteTable(
  "slack_installations" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    teamId: text("team_id" as string).notNull(),
    teamName: text("team_name" as string),
    enterpriseId: text("enterprise_id" as string),
    isEnterpriseInstall: integer("is_enterprise_install" as string, {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    defaultChannelId: text("default_channel_id" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("slack_installations_org_idx" as string).on(table.organizationId),
    uniqueIndex("slack_installations_team_idx" as string).on(table.teamId),
  ]
);

export const chatState = sqliteTable(
  "chat_state" as string,
  {
    key: text("key" as string).primaryKey(),
    value: text("value" as string).notNull(),
    expiresAt: integer("expires_at" as string),
  },
  (table) => [index("chat_state_expires_idx" as string).on(table.expiresAt)]
);

export const projectUpdates = sqliteTable(
  "project_updates" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    projectId: text("project_id" as string)
      .notNull()
      .references(() => projects.id),
    content: text("content" as string).notNull(),
    contentFormat: text("content_format" as string, {
      enum: ["text", "markdown", "blocks"] as const,
    })
      .notNull()
      .default("text"),
    health: text("health" as string, {
      enum: ["on_track", "at_risk", "off_track", "paused"] as const,
    })
      .notNull()
      .default("on_track"),
    createdById: text("created_by_id" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("project_updates_project_idx" as string).on(table.projectId),
    index("project_updates_org_idx" as string).on(table.organizationId),
  ]
);

export const projectMilestones = sqliteTable(
  "project_milestones" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    projectId: text("project_id" as string)
      .notNull()
      .references(() => projects.id),
    name: text("name" as string).notNull(),
    description: text("description" as string),
    targetDate: text("target_date" as string),
    completedAt: text("completed_at" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("project_milestones_project_idx" as string).on(table.projectId),
    index("project_milestones_org_idx" as string).on(table.organizationId),
  ]
);

export const projectUpdateReminders = sqliteTable(
  "project_update_reminders" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    projectId: text("project_id" as string)
      .notNull()
      .references(() => projects.id),
    cadence: text("cadence" as string, {
      enum: ["daily", "weekly", "biweekly", "monthly"] as const,
    })
      .notNull()
      .default("weekly"),
    nextDueAt: text("next_due_at" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("project_update_reminders_project_idx" as string).on(table.projectId),
    uniqueIndex("project_update_reminders_project_unique" as string).on(
      table.organizationId,
      table.projectId
    ),
  ]
);

export const supportCustomers = sqliteTable(
  "support_customers" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    userId: text("user_id" as string).references(() => user.id, {
      onDelete: "set null",
    }),
    externalId: text("external_id" as string),
    externalSource: text("external_source" as string)
      .notNull()
      .default("manual"),
    email: text("email" as string).notNull(),
    fullName: text("full_name" as string),
    phone: text("phone" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("support_customers_org_email_idx" as string).on(
      table.organizationId,
      table.email
    ),
    index("support_customers_org_external_idx" as string).on(
      table.organizationId,
      table.externalId,
      table.externalSource
    ),
  ]
);

export const supportCompanies = sqliteTable(
  "support_companies" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    externalId: text("external_id" as string),
    externalSource: text("external_source" as string)
      .notNull()
      .default("manual"),
    name: text("name" as string).notNull(),
    domain: text("domain" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("support_companies_org_name_idx" as string).on(
      table.organizationId,
      table.name
    ),
    index("support_companies_org_domain_idx" as string).on(
      table.organizationId,
      table.domain
    ),
  ]
);

export const supportCustomerIdentities = sqliteTable(
  "support_customer_identities" as string,
  {
    id: text("id" as string).primaryKey(),
    customerId: text("customer_id" as string)
      .notNull()
      .references(() => supportCustomers.id, { onDelete: "cascade" }),
    type: text("type" as string, {
      enum: [
        "email",
        "phone",
        "slack",
        "msteams",
        "discord",
        "whatsapp",
        "chat",
        "api",
        "social",
        "custom",
      ] as const,
    }).notNull(),
    subType: text("sub_type" as string),
    value: text("value" as string).notNull(),
    isPrimary: integer("is_primary" as string, { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("support_customer_identities_unique_idx" as string).on(
      table.customerId,
      table.type,
      table.value
    ),
  ]
);

export const supportCustomerCompanies = sqliteTable(
  "support_customer_companies" as string,
  {
    id: text("id" as string).primaryKey(),
    customerId: text("customer_id" as string)
      .notNull()
      .references(() => supportCustomers.id, { onDelete: "cascade" }),
    companyId: text("company_id" as string)
      .notNull()
      .references(() => supportCompanies.id, { onDelete: "cascade" }),
    isPrimary: integer("is_primary" as string, { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("support_customer_companies_unique_idx" as string).on(
      table.customerId,
      table.companyId
    ),
    index("support_customer_companies_company_idx" as string).on(
      table.companyId
    ),
  ]
);

export const supportTickets = sqliteTable(
  "support_tickets" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    customerId: text("customer_id" as string)
      .notNull()
      .references(() => supportCustomers.id, { onDelete: "cascade" }),
    number: integer("number" as string).notNull(),
    externalId: text("external_id" as string),
    externalSource: text("external_source" as string, {
      enum: [
        "intercom",
        "zendesk",
        "plain",
        "email",
        "slack",
        "msteams",
        "discord",
        "chat",
        "api",
        "manual",
      ] as const,
    })
      .notNull()
      .default("manual"),
    title: text("title" as string).notNull(),
    status: text("status" as string, {
      enum: ["todo", "done", "snoozed"] as const,
    })
      .notNull()
      .default("todo"),
    priority: text("priority" as string, {
      enum: ["low", "medium", "high", "urgent"] as const,
    })
      .notNull()
      .default("medium"),
    sourceChannel: text("source_channel" as string, {
      enum: [
        "email",
        "slack",
        "msteams",
        "discord",
        "chat",
        "capture",
        "api",
        "intercom",
        "zendesk",
        "plain",
      ] as const,
    }).notNull(),
    issueId: text("issue_id" as string),
    lastCustomerMessageAt: text("last_customer_message_at" as string),
    lastAgentMessageAt: text("last_agent_message_at" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("support_tickets_org_number_idx" as string).on(
      table.organizationId,
      table.number
    ),
    index("support_tickets_org_customer_idx" as string).on(
      table.organizationId,
      table.customerId
    ),
    index("support_tickets_org_status_idx" as string).on(
      table.organizationId,
      table.status
    ),
    index("support_tickets_org_priority_idx" as string).on(
      table.organizationId,
      table.priority
    ),
    uniqueIndex("support_tickets_org_external_idx" as string).on(
      table.organizationId,
      table.externalId,
      table.externalSource
    ),
  ]
);

export const supportTicketCounters = sqliteTable(
  "support_ticket_counters" as string,
  {
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    nextNumber: integer("next_number" as string)
      .notNull()
      .default(1),
  },
  (table) => [primaryKey({ columns: [table.organizationId] })]
);

export const supportTicketEvents = sqliteTable(
  "support_ticket_events" as string,
  {
    id: text("id" as string).primaryKey(),
    ticketId: text("ticket_id" as string)
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    type: text("type" as string, {
      enum: [
        "message",
        "note",
        "status_change",
        "priority_change",
        "assignment_change",
        "label_added",
        "label_removed",
        "customer_event",
        "thread_event",
        "survey_requested",
        "survey_received",
        "sla_change",
        "link_added",
        "link_changed",
        "link_removed",
        "discussion",
        "discussion_resolved",
        "external_reference_changed",
        "notification",
        "watchers_changed",
        "call",
        "voicemail",
        "custom_entry",
        "field_change",
      ] as const,
    }).notNull(),
    subType: text("sub_type" as string),
    actorType: text("actor_type" as string, {
      enum: ["customer", "user", "agent", "automation"] as const,
    }).notNull(),
    actorId: text("actor_id" as string),
    metadata: text("metadata" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("support_ticket_events_ticket_created_idx" as string).on(
      table.ticketId,
      table.createdAt
    ),
  ]
);

export const supportTicketAttachments = sqliteTable(
  "support_ticket_attachments" as string,
  {
    id: text("id" as string).primaryKey(),
    organizationId: text("organization_id" as string)
      .notNull()
      .references(() => organization.id),
    ticketId: text("ticket_id" as string)
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    eventId: text("event_id" as string)
      .notNull()
      .references(() => supportTicketEvents.id, { onDelete: "cascade" }),
    externalId: text("external_id" as string),
    url: text("url" as string),
    fileName: text("file_name" as string),
    contentType: text("content_type" as string),
    size: integer("size" as string),
    r2Key: text("r2_key" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("support_ticket_attachments_ticket_idx" as string).on(table.ticketId),
    index("support_ticket_attachments_event_idx" as string).on(table.eventId),
  ]
);

export const supportTicketMessages = sqliteTable(
  "support_ticket_messages" as string,
  {
    id: text("id" as string).primaryKey(),
    eventId: text("event_id" as string)
      .notNull()
      .references(() => supportTicketEvents.id, { onDelete: "cascade" }),
    direction: text("direction" as string, {
      enum: ["inbound", "outbound"] as const,
    }).notNull(),
    textContent: text("text_content" as string).notNull(),
    markdownContent: text("markdown_content" as string),
    channel: text("channel" as string, {
      enum: ["email", "slack", "msteams", "discord", "chat", "api"] as const,
    }).notNull(),
    customerId: text("customer_id" as string).references(
      () => supportCustomers.id,
      { onDelete: "set null" }
    ),
    userId: text("user_id" as string).references(() => user.id, {
      onDelete: "set null",
    }),
  }
);

export const supportTicketNotes = sqliteTable(
  "support_ticket_notes" as string,
  {
    id: text("id" as string).primaryKey(),
    eventId: text("event_id" as string)
      .notNull()
      .references(() => supportTicketEvents.id, { onDelete: "cascade" }),
    body: text("body" as string).notNull(),
  }
);

export const supportTicketAssignments = sqliteTable(
  "support_ticket_assignments" as string,
  {
    id: text("id" as string).primaryKey(),
    ticketId: text("ticket_id" as string)
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    userId: text("user_id" as string)
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    isPrimary: integer("is_primary" as string, { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    uniqueIndex("support_ticket_assignments_unique_idx" as string).on(
      table.ticketId,
      table.userId
    ),
    index("support_ticket_assignments_ticket_idx" as string).on(
      table.ticketId,
      table.isPrimary
    ),
  ]
);

export const supportTicketLabels = sqliteTable(
  "support_ticket_labels" as string,
  {
    id: text("id" as string).primaryKey(),
    ticketId: text("ticket_id" as string)
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
    labelId: text("label_id" as string)
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("support_ticket_labels_unique_idx" as string).on(
      table.ticketId,
      table.labelId
    ),
  ]
);
