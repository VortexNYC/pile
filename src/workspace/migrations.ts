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

const v11 = `ALTER TABLE agent_sessions ADD COLUMN provider_session_id TEXT`;

const v12 = `CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  title TEXT NOT NULL,
  icon TEXT,
  content TEXT NOT NULL DEFAULT '[]',
  project_id TEXT,
  issue_id TEXT,
  initiative_id TEXT,
  parent_document_id TEXT,
  created_by_id TEXT NOT NULL,
  updated_by_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  trashed_at TEXT
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS documents_organization_idx ON documents (organization_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS documents_project_idx ON documents (organization_id, project_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS documents_issue_idx ON documents (organization_id, issue_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS documents_parent_idx ON documents (organization_id, parent_document_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS document_content_history (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  content TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_history_document_idx ON document_content_history (document_id, created_at)`;

const v13 = `CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  actor_id TEXT,
  actor_type TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  changes TEXT,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_organization_idx ON audit_log (organization_id, created_at)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log (organization_id, entity_type, entity_id)`;

const v14 = `CREATE TABLE IF NOT EXISTS notification_preferences (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  in_app INTEGER NOT NULL DEFAULT 1,
  webhook INTEGER NOT NULL DEFAULT 1,
  email INTEGER NOT NULL DEFAULT 0,
  muted_types TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id)
)`;

const v15 = `CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  logo_url TEXT,
  external_id TEXT,
  tier_id TEXT,
  status_id TEXT,
  owner_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customers_organization_idx ON customers (organization_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS customer_tiers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_tiers_organization_idx ON customer_tiers (organization_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS customer_statuses (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_statuses_organization_idx ON customer_statuses (organization_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS customer_needs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  issue_id TEXT,
  project_id TEXT,
  priority TEXT,
  note TEXT,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_needs_customer_idx ON customer_needs (organization_id, customer_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_needs_issue_idx ON customer_needs (organization_id, issue_id)`;

const v16 = `CREATE TABLE IF NOT EXISTS release_pipelines (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  stages TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS release_pipelines_organization_idx ON release_pipelines (organization_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT,
  project_id TEXT,
  pipeline_id TEXT,
  stage TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  target_date TEXT,
  created_by_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS releases_organization_idx ON releases (organization_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS releases_project_idx ON releases (organization_id, project_id)`;

const v17 = `CREATE TABLE IF NOT EXISTS document_spaces (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  public_sharing INTEGER NOT NULL DEFAULT 1,
  created_by_id TEXT NOT NULL,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_spaces_organization_idx ON document_spaces (organization_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS document_shares (
  token TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  include_children INTEGER NOT NULL DEFAULT 0,
  created_by_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_shares_document_idx ON document_shares (organization_id, document_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS document_watchers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS document_watchers_doc_user_idx ON document_watchers (document_id, user_id)
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN space_id TEXT
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0
--> statement-breakpoint
-- Rebuild comments so issue_id is nullable (doc comments) and add
-- document_id + resolve columns.
CREATE TABLE comments_new (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  issue_id TEXT,
  document_id TEXT,
  author_id TEXT,
  body TEXT NOT NULL,
  external_id TEXT,
  external_source TEXT,
  external_author TEXT,
  resolved_at TEXT,
  resolved_by_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
INSERT INTO comments_new (id, organization_id, issue_id, document_id, author_id, body, external_id, external_source, external_author, created_at, updated_at)
  SELECT id, organization_id, issue_id, NULL, author_id, body, external_id, external_source, external_author, created_at, updated_at FROM comments
--> statement-breakpoint
DROP TABLE comments
--> statement-breakpoint
ALTER TABLE comments_new RENAME TO comments
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS comments_issue_idx ON comments (organization_id, issue_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS comments_document_idx ON comments (organization_id, document_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS comments_external_idx ON comments (organization_id, external_source, external_id)`;

const v18 = `ALTER TABLE documents ADD COLUMN content_format TEXT NOT NULL DEFAULT 'blocks'
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN slug TEXT
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS documents_space_slug_idx ON documents (space_id, slug)`;

const v19 = `CREATE TABLE IF NOT EXISTS document_permissions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'user',
  level TEXT NOT NULL DEFAULT 'view',
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS document_permissions_doc_actor_idx ON document_permissions (document_id, actor_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS document_links (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_links_document_idx ON document_links (organization_id, document_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_links_target_idx ON document_links (organization_id, target_type, target_id)`;

const v20 = `ALTER TABLE document_content_history ADD COLUMN content_format TEXT NOT NULL DEFAULT 'blocks'`;

const v21 = `CREATE TABLE IF NOT EXISTS issue_external_links (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  url TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS issue_external_links_issue_idx ON issue_external_links (organization_id, issue_id)`;

const v22 = `CREATE TABLE IF NOT EXISTS time_schedules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  time_data TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS time_schedules_organization_idx ON time_schedules (organization_id)`;

const v23 = `CREATE TABLE IF NOT EXISTS git_automation_states (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  state_id TEXT NOT NULL,
  pr_state TEXT NOT NULL,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS git_automation_states_organization_idx ON git_automation_states (organization_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS git_automation_states_state_idx ON git_automation_states (organization_id, state_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS git_automation_target_branches (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  pattern TEXT,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS git_automation_target_branches_organization_idx ON git_automation_target_branches (organization_id)`;

const v25 = `ALTER TABLE issues ADD COLUMN pr_check_state TEXT`;

const v26 = `ALTER TABLE comments ADD COLUMN internal INTEGER NOT NULL DEFAULT 0`;

const v27 = `DROP INDEX IF EXISTS idx_issues_repo_branch
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_repo_branch ON issues (repo, branch) WHERE branch IS NOT NULL`;

const v24 = `ALTER TABLE issue_external_links RENAME TO external_links
--> statement-breakpoint
ALTER TABLE external_links ADD COLUMN entity_type TEXT
--> statement-breakpoint
ALTER TABLE external_links ADD COLUMN entity_id TEXT
--> statement-breakpoint
UPDATE external_links SET entity_type = 'issue', entity_id = issue_id
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS external_links_organization_idx ON external_links (organization_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS external_links_entity_idx ON external_links (organization_id, entity_type, entity_id)`;

const v28 = `CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  scope TEXT NOT NULL,
  repo TEXT,
  issue_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mcp_servers_organization_idx ON mcp_servers (organization_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mcp_servers_scope_idx ON mcp_servers (organization_id, scope)`;

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
      { idx: 10, when: 10, tag: "v11", breakpoints: true },
      { idx: 11, when: 11, tag: "v12", breakpoints: true },
      { idx: 12, when: 12, tag: "v13", breakpoints: true },
      { idx: 13, when: 13, tag: "v14", breakpoints: true },
      { idx: 14, when: 14, tag: "v15", breakpoints: true },
      { idx: 15, when: 15, tag: "v16", breakpoints: true },
      { idx: 16, when: 16, tag: "v17", breakpoints: true },
      { idx: 17, when: 17, tag: "v18", breakpoints: true },
      { idx: 18, when: 18, tag: "v19", breakpoints: true },
      { idx: 19, when: 19, tag: "v20", breakpoints: true },
      { idx: 20, when: 20, tag: "v21", breakpoints: true },
      { idx: 21, when: 21, tag: "v22", breakpoints: true },
      { idx: 22, when: 22, tag: "v23", breakpoints: true },
      { idx: 23, when: 23, tag: "v24", breakpoints: true },
      { idx: 24, when: 24, tag: "v25", breakpoints: false },
      { idx: 25, when: 25, tag: "v26", breakpoints: false },
      { idx: 26, when: 26, tag: "v27", breakpoints: true },
      { idx: 27, when: 27, tag: "v28", breakpoints: true },
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
    m0010: v11,
    m0011: v12,
    m0012: v13,
    m0013: v14,
    m0014: v15,
    m0015: v16,
    m0016: v17,
    m0017: v18,
    m0018: v19,
    m0019: v20,
    m0020: v21,
    m0021: v22,
    m0022: v23,
    m0023: v24,
    m0024: v25,
    m0025: v26,
    m0026: v27,
    m0027: v28,
  },
} satisfies Parameters<typeof migrate>[1];
