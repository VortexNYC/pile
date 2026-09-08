import { migrate } from "drizzle-orm/durable-sqlite/migrator";

const v1 = `CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  assignee_id TEXT,
  project_id TEXT,
  cycle_id TEXT,
  label_ids TEXT,
  number INTEGER,
  identifier TEXT,
  repo TEXT,
  branch TEXT,
  pr_url TEXT,
  pr_state TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_issues_workspace_status ON issues (status, created_at DESC)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_issues_repo_branch ON issues (repo, branch)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_issues_created_at_id ON issues (created_at DESC, id DESC)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_issues_priority ON issues (priority, created_at DESC)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_identifier ON issues (workspace_id, identifier)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_team_number ON issues (workspace_id, team_id, number)`;

const v2 = `CREATE TABLE __new_issues (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  assignee_id TEXT,
  project_id TEXT,
  cycle_id TEXT,
  label_ids TEXT,
  number INTEGER,
  identifier TEXT,
  repo TEXT,
  branch TEXT,
  pr_url TEXT,
  pr_state TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
INSERT INTO __new_issues("id", "organization_id", "team_id", "title", "description", "status", "priority", "assignee_id", "project_id", "cycle_id", "label_ids", "number", "identifier", "repo", "branch", "pr_url", "pr_state", "created_at", "updated_at") SELECT "id", "workspace_id", "team_id", "title", "description", "status", "priority", "assignee_id", "project_id", "cycle_id", "label_ids", "number", "identifier", "repo", "branch", "pr_url", "pr_state", "created_at", "updated_at" FROM issues
--> statement-breakpoint
DROP TABLE issues
--> statement-breakpoint
ALTER TABLE __new_issues RENAME TO issues
--> statement-breakpoint
CREATE INDEX idx_issues_status ON issues (status, created_at DESC)
--> statement-breakpoint
CREATE INDEX idx_issues_repo_branch ON issues (repo, branch)
--> statement-breakpoint
CREATE INDEX idx_issues_created_at_id ON issues (created_at DESC, id DESC)
--> statement-breakpoint
CREATE INDEX idx_issues_priority ON issues (priority, created_at DESC)
--> statement-breakpoint
CREATE UNIQUE INDEX idx_issues_identifier ON issues (organization_id, identifier)
--> statement-breakpoint
CREATE UNIQUE INDEX idx_issues_team_number ON issues (organization_id, team_id, number)`;

const v3 = `ALTER TABLE issues ADD COLUMN resolution TEXT`;

const v4 = `ALTER TABLE issues ADD COLUMN parent_id TEXT`;

const v5 = `ALTER TABLE issues ADD COLUMN sub_issue_sort_order REAL`;

const v6 = `ALTER TABLE issues ADD COLUMN estimate INTEGER
--> statement-breakpoint
ALTER TABLE issues ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 0
--> statement-breakpoint
ALTER TABLE issues ADD COLUMN snoozed_until TEXT
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_issues_triage ON issues (organization_id, status, snoozed_until)`;

const v7 = `CREATE TABLE IF NOT EXISTS issue_history (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  linear_id TEXT,
  field TEXT NOT NULL,
  from_value TEXT,
  to_value TEXT,
  actor_id TEXT,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS issue_history_issue_idx ON issue_history (organization_id, issue_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS issue_history_created_idx ON issue_history (organization_id, created_at)`;

const v8 = `CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  author_id TEXT,
  body TEXT NOT NULL,
  external_id TEXT,
  external_source TEXT,
  external_author TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS comments_issue_idx ON comments (organization_id, issue_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS comments_external_idx ON comments (organization_id, external_source, external_id)`;


const v9 = `CREATE TABLE IF NOT EXISTS issue_subscribers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  linear_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS issue_subscribers_issue_idx ON issue_subscribers (organization_id, issue_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS issue_relations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  from_issue_id TEXT NOT NULL,
  to_issue_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS issue_relations_from_idx ON issue_relations (organization_id, from_issue_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS issue_relations_to_idx ON issue_relations (organization_id, to_issue_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS issue_approvals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  requested_by_id TEXT NOT NULL,
  approver_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  comment TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS issue_approvals_issue_idx ON issue_approvals (issue_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS reactions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS reactions_target_idx ON reactions (organization_id, target_type, target_id)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS reactions_unique_idx ON reactions (organization_id, target_type, target_id, actor_id, emoji)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  linear_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  subtitle TEXT,
  r2_key TEXT,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS attachments_issue_idx ON attachments (organization_id, issue_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  recipient_type TEXT NOT NULL DEFAULT 'user',
  issue_id TEXT NOT NULL,
  type TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  snoozed_until TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications (organization_id, recipient_id, recipient_type, read)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notifications_issue_idx ON notifications (organization_id, issue_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS saved_views (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  shared INTEGER NOT NULL DEFAULT 0,
  filter TEXT NOT NULL,
  search TEXT,
  sort TEXT,
  columns TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS saved_views_organization_idx ON saved_views (organization_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS saved_views_owner_idx ON saved_views (organization_id, owner_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS view_favorites (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  view_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS view_favorites_view_user_idx ON view_favorites (view_id, user_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS user_workspace_preferences (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  default_view_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id)
)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS linear_users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  linear_id TEXT NOT NULL,
  name TEXT,
  email TEXT,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS linear_users_organization_idx ON linear_users (organization_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS linear_users_linear_idx ON linear_users (organization_id, linear_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  result TEXT,
  url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_sessions_organization_idx ON agent_sessions (organization_id, created_at, id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_sessions_issue_idx ON agent_sessions (issue_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_activities (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  actor_id TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_activities_session_idx ON agent_activities (session_id, created_at)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '*',
  secret TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhook_subscriptions_organization_idx ON webhook_subscriptions (organization_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS outbound_webhook_deliveries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  status_code INTEGER,
  error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS outbound_webhook_deliveries_organization_idx ON outbound_webhook_deliveries (organization_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS outbound_webhook_deliveries_subscription_idx ON outbound_webhook_deliveries (subscription_id)`;



const v10 = `CREATE TABLE IF NOT EXISTS agent_provider_configs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  token TEXT,
  provider_org_id TEXT,
  outpost TEXT,
  outpost_id TEXT,
  outpost_token TEXT,
  compute_api_key TEXT,
  compute_api_url TEXT,
  compute_snapshot TEXT,
  compute_volume_id TEXT,
  config TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS agent_provider_configs_org_agent_idx ON agent_provider_configs (organization_id, agent_id)`;

export const workspaceMigrations = {
  journal: {
    entries: [
      { idx: 0, when: 0, tag: "v1", breakpoints: false },
      { idx: 1, when: 1, tag: "v2", breakpoints: true },
      { idx: 2, when: 2, tag: "v3", breakpoints: false },
      { idx: 3, when: 3, tag: "v4", breakpoints: false },
      { idx: 4, when: 4, tag: "v5", breakpoints: false },
      { idx: 5, when: 5, tag: "v6", breakpoints: true },
      { idx: 6, when: 6, tag: "v7", breakpoints: true },
      { idx: 7, when: 7, tag: "v8", breakpoints: true },
      { idx: 8, when: 8, tag: "v9", breakpoints: true },
      { idx: 9, when: 9, tag: "v10", breakpoints: true },
    ],
  },
  migrations: {
    m0000: v1,
    m0001: v2,
    m0002: v3,
    m0003: v4,
    m0004: v5,
    m0005: v6,
    m0006: v7,
    m0007: v8,
    m0008: v9,
    m0009: v10,
  },
} satisfies Parameters<typeof migrate>[1];
