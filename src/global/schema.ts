import { relations, sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces" as string, {
  id: text("id" as string).primaryKey(),
  name: text("name" as string).notNull(),
  slug: text("slug" as string)
    .notNull()
    .unique(),
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

export const workspaceTokens = sqliteTable("workspace_tokens" as string, {
  id: text("id" as string).primaryKey(),
  workspaceId: text("workspace_id" as string)
    .notNull()
    .references(() => workspaces.id),
  name: text("name" as string).notNull(),
  tokenHash: text("token_hash" as string)
    .notNull()
    .unique(),
  permissions: text("permissions" as string)
    .notNull()
    .default("read,write"),
  createdAt: text("created_at" as string)
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

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
    authorId: text("author_id" as string).notNull(),
    body: text("body" as string).notNull(),
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
