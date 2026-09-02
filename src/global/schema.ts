import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql, relations } from "drizzle-orm";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ownerId: text("owner_id").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const workspaceMemberships = sqliteTable("workspace_memberships", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id),
  userId: text("user_id").notNull(),
  role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const workspaceTokens = sqliteTable("workspace_tokens", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  permissions: text("permissions").notNull().default("read,write"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const repoBranches = sqliteTable(
  "repo_branches",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    repo: text("repo").notNull(),
    branch: text("branch").notNull(),
    issueId: text("issue_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("repo_branches_repo_branch_idx").on(table.repo, table.branch)]
);

export const repoIssues = sqliteTable(
  "repo_issues",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    repo: text("repo").notNull(),
    issueNumber: integer("issue_number").notNull(),
    issueId: text("issue_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("repo_issues_repo_number_idx").on(table.repo, table.issueNumber),
    index("repo_issues_workspace_idx").on(table.workspaceId),
  ]
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").notNull().default("active"),
    startDate: text("start_date"),
    endDate: text("end_date"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("projects_workspace_idx").on(table.workspaceId)]
);

export const cycles = sqliteTable(
  "cycles",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    projectId: text("project_id").references(() => projects.id),
    name: text("name").notNull(),
    startDate: text("start_date"),
    endDate: text("end_date"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("cycles_workspace_idx").on(table.workspaceId),
    index("cycles_project_idx").on(table.projectId),
  ]
);

export const labels = sqliteTable(
  "labels",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    name: text("name").notNull(),
    color: text("color"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("labels_workspace_idx").on(table.workspaceId)]
);

export const linearUsers = sqliteTable(
  "linear_users",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    linearId: text("linear_id").notNull(),
    name: text("name"),
    email: text("email"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("linear_users_workspace_idx").on(table.workspaceId),
    index("linear_users_linear_idx").on(table.workspaceId, table.linearId),
    index("linear_users_email_idx").on(table.email),
  ]
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    issueId: text("issue_id").notNull(),
    authorId: text("author_id").notNull(),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("comments_issue_idx").on(table.workspaceId, table.issueId),
    index("comments_author_idx").on(table.workspaceId, table.authorId),
  ]
);

export const issueRelations = sqliteTable(
  "issue_relations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    fromIssueId: text("from_issue_id").notNull(),
    toIssueId: text("to_issue_id").notNull(),
    type: text("type").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("issue_relations_from_idx").on(table.workspaceId, table.fromIssueId),
    index("issue_relations_to_idx").on(table.workspaceId, table.toIssueId),
  ]
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    issueId: text("issue_id").notNull(),
    linearId: text("linear_id").notNull(),
    url: text("url").notNull(),
    title: text("title"),
    subtitle: text("subtitle"),
    r2Key: text("r2_key"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("attachments_issue_idx").on(table.workspaceId, table.issueId),
    index("attachments_linear_idx").on(table.workspaceId, table.linearId),
  ]
);

export const webhookSubscriptions = sqliteTable(
  "webhook_subscriptions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    url: text("url").notNull(),
    events: text("events").notNull().default("*"),
    secret: text("secret").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("webhook_subscriptions_workspace_idx").on(table.workspaceId)]
);

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    deliveryId: text("delivery_id").primaryKey(),
    source: text("source").notNull(),
    event: text("event").notNull(),
    workspaceId: text("workspace_id").references(() => workspaces.id),
    processedAt: text("processed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("webhook_deliveries_workspace_idx").on(table.workspaceId)]
);

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date()),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date()),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)]
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("account_userId_idx").on(table.userId),
    index("account_provider_idx").on(table.providerId, table.accountId),
  ]
);

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
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
