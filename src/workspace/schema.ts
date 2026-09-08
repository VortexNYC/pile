import {
  index,
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
