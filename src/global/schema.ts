import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces" as string, {
  id: text("id" as string).primaryKey(),
  name: text("name" as string).notNull(),
  slug: text("slug" as string)
    .notNull()
    .unique(),
  key: text("key" as string).unique(),
  ownerId: text("owner_id" as string).notNull(),
  createdAt: text("created_at" as string)
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at" as string)
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const workspaceMemberships = sqliteTable(
  "workspace_memberships" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
    userId: text("user_id" as string).notNull(),
    role: text("role" as string, {
      enum: ["owner", "admin", "member"],
    }).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  }
);

export const repoBranches = sqliteTable(
  "repo_branches" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
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
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
    repo: text("repo" as string).notNull(),
    issueNumber: integer("issue_number" as string).notNull(),
    issueId: text("issue_id" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("repo_issues_repo_number_idx" as string).on(
      table.repo,
      table.issueNumber
    ),
    index("repo_issues_workspace_idx" as string).on(table.workspaceId),
  ]
);

export const githubInstallations = sqliteTable(
  "github_installations" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
    installationId: text("installation_id" as string).notNull(),
    repo: text("repo" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("github_installations_repo_idx" as string).on(table.repo),
    index("github_installations_workspace_idx" as string).on(table.workspaceId),
  ]
);

export const projects = sqliteTable(
  "projects" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
    name: text("name" as string).notNull(),
    description: text("description" as string),
    status: text("status" as string)
      .notNull()
      .default("active"),
    startDate: text("start_date" as string),
    endDate: text("end_date" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("projects_workspace_idx" as string).on(table.workspaceId)]
);

export const cycles = sqliteTable(
  "cycles" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
    projectId: text("project_id" as string).references(() => projects.id),
    name: text("name" as string).notNull(),
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
    index("cycles_workspace_idx" as string).on(table.workspaceId),
    index("cycles_project_idx" as string).on(table.projectId),
  ]
);

export const labels = sqliteTable(
  "labels" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
    name: text("name" as string).notNull(),
    color: text("color" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("labels_workspace_idx" as string).on(table.workspaceId)]
);

export const states = sqliteTable(
  "states" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
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
    index("states_workspace_idx" as string).on(table.workspaceId),
    index("states_linear_idx" as string).on(table.workspaceId, table.linearId),
  ]
);

export const linearUsers = sqliteTable(
  "linear_users" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
    linearId: text("linear_id" as string).notNull(),
    name: text("name" as string),
    email: text("email" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("linear_users_workspace_idx" as string).on(table.workspaceId),
    index("linear_users_linear_idx" as string).on(
      table.workspaceId,
      table.linearId
    ),
    index("linear_users_email_idx" as string).on(table.email),
  ]
);

export const comments = sqliteTable(
  "comments" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
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
    index("comments_issue_idx" as string).on(table.workspaceId, table.issueId),
    index("comments_author_idx" as string).on(
      table.workspaceId,
      table.authorId
    ),
    index("comments_external_idx" as string).on(
      table.workspaceId,
      table.externalSource,
      table.externalId
    ),
  ]
);

export const issueRelations = sqliteTable(
  "issue_relations" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
    fromIssueId: text("from_issue_id" as string).notNull(),
    toIssueId: text("to_issue_id" as string).notNull(),
    type: text("type" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("issue_relations_from_idx" as string).on(
      table.workspaceId,
      table.fromIssueId
    ),
    index("issue_relations_to_idx" as string).on(
      table.workspaceId,
      table.toIssueId
    ),
  ]
);

export const attachments = sqliteTable(
  "attachments" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
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
      table.workspaceId,
      table.issueId
    ),
    index("attachments_linear_idx" as string).on(
      table.workspaceId,
      table.linearId
    ),
  ]
);

export const issueHistory = sqliteTable(
  "issue_history" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
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
      table.workspaceId,
      table.issueId
    ),
    index("issue_history_created_idx" as string).on(
      table.workspaceId,
      table.createdAt
    ),
  ]
);

export const issueSubscribers = sqliteTable(
  "issue_subscribers" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
    issueId: text("issue_id" as string).notNull(),
    linearUserId: text("linear_user_id" as string).notNull(),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("issue_subscribers_issue_idx" as string).on(
      table.workspaceId,
      table.issueId
    ),
    index("issue_subscribers_user_idx" as string).on(
      table.workspaceId,
      table.linearUserId
    ),
  ]
);

export const templates = sqliteTable(
  "templates" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
    linearId: text("linear_id" as string).notNull(),
    name: text("name" as string).notNull(),
    templateData: text("template_data" as string),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("templates_workspace_idx" as string).on(table.workspaceId),
    index("templates_linear_idx" as string).on(
      table.workspaceId,
      table.linearId
    ),
  ]
);

export const webhookSubscriptions = sqliteTable(
  "webhook_subscriptions" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
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
    index("webhook_subscriptions_workspace_idx" as string).on(
      table.workspaceId
    ),
  ]
);

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries" as string,
  {
    deliveryId: text("delivery_id" as string).primaryKey(),
    source: text("source" as string).notNull(),
    event: text("event" as string).notNull(),
    workspaceId: text("workspace_id" as string).references(() => workspaces.id),
    processedAt: text("processed_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("webhook_deliveries_workspace_idx" as string).on(table.workspaceId),
  ]
);

export const outboundWebhookDeliveries = sqliteTable(
  "outbound_webhook_deliveries" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
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
    index("outbound_webhook_deliveries_workspace_idx" as string).on(
      table.workspaceId
    ),
    index("outbound_webhook_deliveries_subscription_idx" as string).on(
      table.subscriptionId
    ),
  ]
);

export const notifications = sqliteTable(
  "notifications" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
    recipientId: text("recipient_id" as string).notNull(),
    recipientType: text("recipient_type" as string)
      .notNull()
      .default("user"),
    issueId: text("issue_id" as string).notNull(),
    type: text("type" as string).notNull(),
    read: integer("read" as string, { mode: "boolean" })
      .notNull()
      .default(false),
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
      table.workspaceId,
      table.recipientId,
      table.recipientType,
      table.read
    ),
    index("notifications_issue_idx" as string).on(
      table.workspaceId,
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
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
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
      table.workspaceId,
      table.githubLogin
    ),
    uniqueIndex("github_users_workspace_user_idx" as string).on(
      table.workspaceId,
      table.userId
    ),
  ]
);

export const savedViews = sqliteTable(
  "saved_views" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
    ownerId: text("owner_id" as string).notNull(),
    name: text("name" as string).notNull(),
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
    index("saved_views_workspace_idx" as string).on(table.workspaceId),
    index("saved_views_owner_idx" as string).on(
      table.workspaceId,
      table.ownerId
    ),
  ]
);

export const teams = sqliteTable(
  "teams" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
    key: text("key" as string).notNull(),
    name: text("name" as string).notNull(),
    ownerId: text("owner_id" as string).notNull(),
    isDefault: integer("is_default" as string, { mode: "boolean" })
      .notNull()
      .default(false),
    isPublic: integer("is_public" as string, { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("teams_workspace_idx" as string).on(table.workspaceId),
    uniqueIndex("teams_workspace_key_idx" as string).on(
      table.workspaceId,
      table.key
    ),
  ]
);

export const teamMemberships = sqliteTable(
  "team_memberships" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
    teamId: text("team_id" as string)
      .notNull()
      .references(() => teams.id),
    memberId: text("member_id" as string).notNull(),
    memberType: text("member_type" as string, {
      enum: ["user", "agent"],
    }).notNull(),
    role: text("role" as string, { enum: ["member", "guest"] })
      .notNull()
      .default("member"),
    createdAt: text("created_at" as string)
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("team_memberships_workspace_idx" as string).on(table.workspaceId),
    uniqueIndex("team_memberships_member_idx" as string).on(
      table.teamId,
      table.memberId,
      table.memberType
    ),
  ]
);

export const agentSessions = sqliteTable(
  "agent_sessions" as string,
  {
    id: text("id" as string).primaryKey(),
    workspaceId: text("workspace_id" as string)
      .notNull()
      .references(() => workspaces.id),
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
    index("agent_sessions_workspace_idx" as string).on(
      table.workspaceId,
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
