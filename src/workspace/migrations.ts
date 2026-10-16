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

const v29 = `CREATE TABLE IF NOT EXISTS git_identities (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  github_username TEXT,
  signing_key_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS git_identities_org_repo_idx ON git_identities (organization_id, repo)`;

const v30 = `CREATE TABLE IF NOT EXISTS agent_session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_session_events_session_idx ON agent_session_events (session_id, id)`;

const v31 = `ALTER TABLE agent_provider_configs ADD COLUMN team_ids TEXT`;

const v32 = `ALTER TABLE agent_sessions ADD COLUMN pr_url TEXT`;

const v33 = `ALTER TABLE agent_sessions ADD COLUMN pr_state TEXT`;

const v34 = `ALTER TABLE agent_sessions ADD COLUMN branch TEXT`;

const v35 = `ALTER TABLE agent_sessions ADD COLUMN last_progress_at TEXT
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN last_state_hash TEXT
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_sessions_provider_session_idx ON agent_sessions (organization_id, provider_session_id)`;

const v36 = `CREATE TABLE IF NOT EXISTS agent_environment_files (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS agent_environment_files_path_idx ON agent_environment_files (organization_id, path)`;

const v37 = `ALTER TABLE agent_activities ADD COLUMN parent_id TEXT
--> statement-breakpoint
ALTER TABLE agent_activities ADD COLUMN started_at TEXT
--> statement-breakpoint
ALTER TABLE agent_activities ADD COLUMN ended_at TEXT
--> statement-breakpoint
ALTER TABLE agent_activities ADD COLUMN duration_ms INTEGER`;

const v38 = `ALTER TABLE issues ADD COLUMN external_ref TEXT
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_external_ref ON issues (organization_id, external_ref)`;

const v39 = `ALTER TABLE agent_sessions ADD COLUMN retry_of TEXT
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0`;

const v40 = `ALTER TABLE agent_sessions ADD COLUMN infra_failure INTEGER NOT NULL DEFAULT 0`;

const v41 = `ALTER TABLE audit_log ADD COLUMN ip TEXT
--> statement-breakpoint
ALTER TABLE audit_log ADD COLUMN country TEXT
--> statement-breakpoint
ALTER TABLE audit_log ADD COLUMN user_agent TEXT`;

const v42 = `ALTER TABLE agent_sessions ADD COLUMN started_at TEXT`;

const v43 = `ALTER TABLE agent_sessions ADD COLUMN queued_after TEXT
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN parent_session_id TEXT
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN spawn_depth INTEGER NOT NULL DEFAULT 0
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN lane_db_ref TEXT
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_automations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  team_id TEXT,
  issue_id TEXT,
  trigger_kind TEXT NOT NULL,
  trigger_value TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_fired_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_automations_org_idx ON agent_automations (organization_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_automations_issue_idx ON agent_automations (issue_id)`;

const v44 = `ALTER TABLE agent_sessions ADD COLUMN purpose TEXT`;

// VTX-216 — kept-sandbox reaper leaked because updatedAt is bumped by every
// write (prState, laneDb teardown, the reaper's own marker), so the 4h
// resume window never elapsed. ended_at anchors the window to the terminal
// transition, written once.
const v45 = `ALTER TABLE agent_sessions ADD COLUMN ended_at TEXT`;

// PILE-293 — per-dispatch run budget: maxDuration overrides the provider
// timeout for this lane; effort is the model tier it was dispatched at.
const v47 = `ALTER TABLE agent_sessions ADD COLUMN max_duration_minutes INTEGER
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN effort TEXT`;

// PILE-289 — session labels + structured lane results.
const v46 = `ALTER TABLE agent_sessions ADD COLUMN label TEXT
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN result_schema TEXT
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN structured_result TEXT
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN result_schema_errors TEXT`;

// PILE-294 — cross-repo lanes: sibling repos cloned under ~/xrepo.
const v49 = `ALTER TABLE agent_sessions ADD COLUMN secondary_repos TEXT`;

// PILE-306 — R2 directory backup of the lane worktree, captured at reap so
// a post-reap follow-up can restore instead of cold-cloning.
const v50 = `ALTER TABLE agent_sessions ADD COLUMN sandbox_backup_ref TEXT`;

// PILE-286 — incremental review: the head sha the lane's PR was last
// reviewed at, plus a rolling JSON snapshot of review verdicts, so a
// follow-up review only re-derives context for the range since that sha.
const v48 = `ALTER TABLE agent_sessions ADD COLUMN last_reviewed_sha TEXT
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN review_summary TEXT`;

// PILE-324 — R2-backed file attachments scoped to an arbitrary workspace
// entity (entity_type + entity_id). Customers are the first consumer.
const v51 = `CREATE TABLE IF NOT EXISTS entity_attachments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  created_by_id TEXT,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entity_attachments_entity_idx ON entity_attachments (organization_id, entity_type, entity_id)`;

// PILE-328 — per-issue visibility grants (document-permissions model): no
// rows = open to the workspace; any row restricts the issue to the listed
// actors (+ workspace admins).
const v52 = `CREATE TABLE IF NOT EXISTS issue_permissions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_type TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS issue_permissions_issue_actor_idx ON issue_permissions (issue_id, actor_id)`;
// PILE-325 — customer email intake: each inbound mail filed on the matched
// customer record. external_id is the Message-ID (or a hash of the raw MIME)
// so queue retries can't double-file.
const v53 = `CREATE TABLE customer_intake_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'email',
  inbox_id TEXT,
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_address TEXT NOT NULL,
  subject TEXT,
  text TEXT,
  html TEXT,
  external_id TEXT NOT NULL,
  message_id TEXT,
  attachments TEXT,
  received_at TEXT NOT NULL,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS customer_intake_items_external_idx ON customer_intake_items (organization_id, external_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_intake_items_customer_idx ON customer_intake_items (organization_id, customer_id)`;

// Tri-state for the email pref: existing rows are marked explicit (their
// current `email` value wins); rows written after this only set
// email_explicit when the caller actually passed `email`.
const v54 = `ALTER TABLE notification_preferences ADD COLUMN email_explicit INTEGER NOT NULL DEFAULT 1`;

const v55 = `ALTER TABLE user_workspace_preferences ADD COLUMN hidden_surfaces TEXT`;
const v57 = `ALTER TABLE user_workspace_preferences ADD COLUMN favorites TEXT`;
const v58 = `ALTER TABLE customers ADD COLUMN booking_url TEXT`;

const v60 = `CREATE TABLE IF NOT EXISTS field_definitions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  options TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS field_definitions_org_entity_idx ON field_definitions (organization_id, entity_type)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS field_definitions_name_idx ON field_definitions (organization_id, entity_type, name)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS field_values (
  field_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  value TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (field_id, entity_id)
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS field_values_entity_idx ON field_values (organization_id, entity_id)`;

const v70 = `CREATE INDEX IF NOT EXISTS user_workspace_preferences_org_user_idx ON user_workspace_preferences (organization_id, user_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_content_history_doc_idx ON document_content_history (organization_id, document_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_preferences_user_idx ON notification_preferences (organization_id, user_id)`;

// PILE-409: restricted spaces deny-by-default — docs inside need an
// explicit document_permissions grant. Backfill: spaces with public
// sharing off are the restricted ones (Leadership et al).
const v71 = `ALTER TABLE document_spaces ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0
--> statement-breakpoint
UPDATE document_spaces SET restricted = 1 WHERE public_sharing = 0`;

const v72 = `ALTER TABLE customers ADD COLUMN next_step_text TEXT
--> statement-breakpoint
ALTER TABLE customers ADD COLUMN next_step_due_at TEXT
--> statement-breakpoint
ALTER TABLE customers ADD COLUMN needs_human INTEGER
--> statement-breakpoint
ALTER TABLE customers ADD COLUMN needs_human_reason TEXT
--> statement-breakpoint
ALTER TABLE customers ADD COLUMN priority_score REAL
--> statement-breakpoint
ALTER TABLE deals ADD COLUMN external_id TEXT
--> statement-breakpoint
ALTER TABLE deals ADD COLUMN next_step_text TEXT
--> statement-breakpoint
ALTER TABLE deals ADD COLUMN next_step_due_at TEXT
--> statement-breakpoint
ALTER TABLE deals ADD COLUMN needs_human INTEGER
--> statement-breakpoint
ALTER TABLE deals ADD COLUMN needs_human_reason TEXT
--> statement-breakpoint
ALTER TABLE deals ADD COLUMN priority_score REAL
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customers_external_id_idx ON customers (organization_id, external_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customers_next_step_due_idx ON customers (organization_id, next_step_due_at)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS deals_external_id_idx ON deals (organization_id, external_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS deals_next_step_due_idx ON deals (organization_id, next_step_due_at)`;

// PILE-417 — delegate vs assignee (Linear's model): assigneeId stays the
// accountable human; delegateId is the agent acting on their behalf. The
// index backs the delegateId list filter and delegate:* views.
const v73 = `ALTER TABLE issues ADD COLUMN delegate_id TEXT
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_issues_delegate ON issues (delegate_id)`;

// PILE-430 — atomic claim/lease primitive: claimed_by holds the claimant
// (agent or actor id), claimed_lease_expires_at the lease deadline, and
// claim_epoch is the fencing token bumped on every claim-state write so a
// holder can detect it lost the issue. Expired leases are reclaimable.
const v74 = `ALTER TABLE issues ADD COLUMN claimed_by TEXT
--> statement-breakpoint
ALTER TABLE issues ADD COLUMN claimed_lease_expires_at TEXT
--> statement-breakpoint
ALTER TABLE issues ADD COLUMN claim_epoch INTEGER NOT NULL DEFAULT 0`;

// PILE-419 — elicitation suspend: awaiting_activity_id points at the open
// (unanswered) elicitation activity that parked the session in `waiting`;
// awaiting_escalated_at dedupes the sweep's escalation notification. Both
// clear when the answer lands or the session leaves `waiting`.
const v75 = `ALTER TABLE agent_sessions ADD COLUMN awaiting_activity_id TEXT
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN awaiting_escalated_at TEXT
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_sessions_awaiting_idx ON agent_sessions (organization_id, awaiting_activity_id)`;

// PILE-420 — agent-type pause: `agent_pauses` rows hold every new dispatch
// of that agent type (sessions park `waiting` + `paused`); the session
// `paused` flag marks holds so resume can drain them in order.
const v76 = `ALTER TABLE agent_sessions ADD COLUMN paused INTEGER NOT NULL DEFAULT 0
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_pauses (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS agent_pauses_org_agent_idx ON agent_pauses (organization_id, agent_id)`;

// PILE-423 — agent guidance packs (Linear's "Guidance"): markdown instruction
// packs scoped to the workspace, a team, a workflow status/stage, or a step
// key. Session context assembly injects the applicable packs least-specific
// first; `version` bumps on every edit and guidance_pack_versions snapshots
// each revision so the `guidance` refs recorded on a session row
// ({packId, version}) always resolve back to the exact text the lane saw.
// `step_key` on agent_sessions is the pipeline sub-step the lane works —
// persisted so queue promotion/retries resolve the same step scope.
const v77 = `CREATE TABLE IF NOT EXISTS guidance_packs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_key TEXT,
  body TEXT NOT NULL,
  links TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS guidance_packs_scope_idx ON guidance_packs (organization_id, scope, scope_key)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS guidance_pack_versions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  links TEXT,
  actor_id TEXT,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS guidance_pack_versions_pack_idx ON guidance_pack_versions (pack_id, version)
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN guidance TEXT
--> statement-breakpoint
ALTER TABLE agent_sessions ADD COLUMN step_key TEXT`;

// PILE-426 — the lane's published plan checklist (Linear AgentSession.plan):
// JSON [{content, status}] with status pending | inProgress | completed |
// canceled. Whole-array replace semantics; null means no plan published.
const v78 = `ALTER TABLE agent_sessions ADD COLUMN plan TEXT`;

// PILE-411 — stage templates (Salesforce Flow Orchestration style): a
// template row is one sub-step definition for a (entity_type, status) pair —
// when a record enters that status/stage the workspace materializes one
// sub-issue per applicable definition. `status`/`step_key` are normalized
// slug keys (see stageKey() in the data layer); `condition` is a JSON rule
// ({field, equals?}) evaluated against the transitioning record's own fields
// plus its custom field values — e.g. {"field":"hardware_needed"} skips the
// step unless the record carries a truthy hardware_needed. On issues,
// step_key/required/owner_agent mark a row as a materialized sub-step: the
// (parent, step_key) pair is the idempotency key so re-entering a stage never
// duplicates a step, and owner_agent is the named agent the step dispatches
// to (kept off delegate_id — owner names are roles, not registered agents).
const v79 = `CREATE TABLE IF NOT EXISTS stage_templates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'issue',
  status TEXT NOT NULL,
  step_key TEXT NOT NULL,
  title TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  owner_agent TEXT,
  condition TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  team_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS stage_templates_status_step_idx ON stage_templates (organization_id, entity_type, status, step_key)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stage_templates_lookup_idx ON stage_templates (organization_id, entity_type, status)
--> statement-breakpoint
ALTER TABLE issues ADD COLUMN step_key TEXT
--> statement-breakpoint
ALTER TABLE issues ADD COLUMN required INTEGER NOT NULL DEFAULT 0
--> statement-breakpoint
ALTER TABLE issues ADD COLUMN owner_agent TEXT`;

// PILE-422 — inbound external events complete stage sub-steps (Stripe
// Connect requirements-style: the provider's server-side event, not an
// agent claim, is what clears the step). external_event_mappings binds
// (source, event_type) to a step_key plus the matcher that resolves the
// record (entity_type + match_path → externalId/externalRef); `secret` is
// the HMAC-SHA256 credential the source's deliveries are verified against.
// external_event_deliveries is the dedupe ledger AND the event log: one row
// per inbound event keyed by (source, dedupe_key) — replays short-circuit
// on the unique index, and unmatched/invalid rows record why nothing moved.
const v80 = `CREATE TABLE IF NOT EXISTS external_event_mappings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  match_path TEXT NOT NULL,
  step_key TEXT NOT NULL,
  secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS external_event_mappings_event_idx ON external_event_mappings (organization_id, source, event_type)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS external_event_mappings_source_idx ON external_event_mappings (organization_id, source)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS external_event_deliveries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  source TEXT NOT NULL,
  event_type TEXT,
  event_id TEXT,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  completed_issue_ids TEXT,
  payload TEXT,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS external_event_deliveries_dedupe_idx ON external_event_deliveries (organization_id, source, dedupe_key)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS external_event_deliveries_org_idx ON external_event_deliveries (organization_id, created_at)`;

// PILE-425 — per-agent spend/token caps + per-run receipts.
const v81 = `CREATE TABLE IF NOT EXISTS agent_spend_caps (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  max_runs_per_day INTEGER,
  max_runs_per_month INTEGER,
  max_tokens_per_day INTEGER,
  max_tokens_per_month INTEGER,
  max_cost_micros_per_day INTEGER,
  max_cost_micros_per_month INTEGER,
  max_tokens_per_run INTEGER,
  max_cost_micros_per_run INTEGER,
  last_cap_alert_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS agent_spend_caps_org_agent_idx ON agent_spend_caps (organization_id, agent_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_run_receipts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  step_key TEXT,
  deal_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  model TEXT,
  effort TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  tool_calls INTEGER,
  cost_micros INTEGER,
  external_spend_micros INTEGER,
  cost_source TEXT,
  cap_exceeded INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS agent_run_receipts_session_idx ON agent_run_receipts (session_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_run_receipts_org_agent_idx ON agent_run_receipts (organization_id, agent_id, created_at)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_run_receipts_org_step_idx ON agent_run_receipts (organization_id, step_key)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_run_receipts_issue_idx ON agent_run_receipts (issue_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_run_receipts_deal_idx ON agent_run_receipts (organization_id, deal_id)`;

// PILE-427 — triage auto-delegate rules: ordered match rules evaluated on
// inbound records (leads, intake items, customers, deals, issues, support
// tickets) plus the evaluation log — one row per evaluation so the record
// shows which rule matched (or that none did).
const v82 = `CREATE TABLE IF NOT EXISTS triage_rules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  record_type TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  conditions TEXT NOT NULL,
  action TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS triage_rules_org_type_idx ON triage_rules (organization_id, record_type, is_active, sort_order)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS triage_rule_evaluations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  record_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  rule_id TEXT,
  rule_name TEXT,
  outcome TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS triage_rule_evaluations_record_idx ON triage_rule_evaluations (organization_id, record_type, record_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS triage_rule_evaluations_org_idx ON triage_rule_evaluations (organization_id, created_at)`;

// PILE-429 — link verification: the API probes external URLs on
// create/update and records the outcome so agents can check a link's
// reachability instead of trusting a syntactically valid URL.
const v83 = `ALTER TABLE external_links ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'unchecked'
--> statement-breakpoint
ALTER TABLE external_links ADD COLUMN verified_at TEXT
--> statement-breakpoint
ALTER TABLE external_links ADD COLUMN resolved_url TEXT
--> statement-breakpoint
ALTER TABLE external_links ADD COLUMN resolved_title TEXT
--> statement-breakpoint
ALTER TABLE external_links ADD COLUMN http_status INTEGER`;

// PILE-428 — draft-then-publish for agent output on sensitive records.
// `issues.sensitive` flags a record as review-gated; `draft_outputs` holds
// agent-produced writes (comments, field changes, outbound messages) in
// `pending` until a human publishes (applies the write) or discards (kept
// for inspection — never deleted). `issue_id` carries the review context
// even when the target entity is not itself an issue.
const v84 = `ALTER TABLE issues ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS draft_outputs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  issue_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by_id TEXT,
  session_id TEXT,
  reviewed_by_id TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  published_comment_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS draft_outputs_entity_idx ON draft_outputs (organization_id, entity_type, entity_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS draft_outputs_status_idx ON draft_outputs (organization_id, status, created_at)`;

// PILE-403 — bulk customer import receipts. Every batch write lands one
// row here (source/corridor + per-row outcomes as JSON in `rows`) so a
// re-run is auditable and agents can read import history later.
const v85 = `CREATE TABLE IF NOT EXISTS import_receipts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  source TEXT,
  corridor TEXT,
  row_count INTEGER NOT NULL,
  created_count INTEGER NOT NULL,
  existing_count INTEGER NOT NULL,
  failed_count INTEGER NOT NULL,
  rows TEXT NOT NULL,
  created_by_id TEXT,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS import_receipts_org_idx ON import_receipts (organization_id, created_at)`;

// PILE-412 — stage gate skip reasons. `resolution_reason` holds the "why"
// for a resolution; required when resolution is 'skipped' so a required
// sub-step can only end undone with a recorded justification.
const v86 = `ALTER TABLE issues ADD COLUMN resolution_reason TEXT`;

// PILE-401/405/413 — pipeline runtime: durable domain-event outbox the
// worker drains into dispatches, per-stage config (owner agent + advance
// policy), and the agent-type registry owner_agent slugs resolve through.
const v87 = `CREATE TABLE IF NOT EXISTS domain_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  dedupe_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  delivered_at TEXT
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS domain_events_pending_idx ON domain_events (organization_id, status, created_at)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS domain_events_dedupe_idx ON domain_events (organization_id, type, dedupe_key)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS stage_configs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'issue',
  status TEXT NOT NULL,
  owner_agent TEXT,
  instructions TEXT,
  advance_policy TEXT NOT NULL DEFAULT 'none',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS stage_configs_stage_idx ON stage_configs (organization_id, entity_type, status)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS agent_types (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  provider_agent_id TEXT NOT NULL,
  job_spec TEXT,
  tool_scope TEXT,
  permissions_tier TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS agent_types_slug_idx ON agent_types (organization_id, slug)`;

// PILE-418 — first-ack tracking: sessions that dispatch but never record a
// first activity get flagged in the API instead of hanging silently.
const v88 = `ALTER TABLE agent_sessions ADD COLUMN first_activity_at TEXT`;

// Flue profiles — the durable conversation key a lane's memory is pinned
// to ({merchantId}-{agentSlug}); resume finds the session by this key.
const v90 = `ALTER TABLE agent_sessions ADD COLUMN conversation_key TEXT
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_sessions_conversation_key_idx ON agent_sessions (organization_id, conversation_key)`;

// PILE-404 — draft-approval provenance + edit-diff snapshot.
// PILE-438 — immutable status key + active/terminal marker.
const v91 = `ALTER TABLE customer_statuses ADD COLUMN key TEXT
--> statement-breakpoint
ALTER TABLE customer_statuses ADD COLUMN type TEXT NOT NULL DEFAULT 'active'
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customer_statuses_key_idx ON customer_statuses (organization_id, key)`;

const v89 = `ALTER TABLE draft_outputs ADD COLUMN agent_slug TEXT
--> statement-breakpoint
ALTER TABLE draft_outputs ADD COLUMN prompt_version TEXT
--> statement-breakpoint
ALTER TABLE draft_outputs ADD COLUMN original_payload TEXT`;
const v69 = `CREATE TABLE comments_new (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  author_id TEXT,
  body TEXT NOT NULL,
  internal INTEGER NOT NULL DEFAULT 0,
  external_id TEXT,
  external_source TEXT,
  external_author TEXT,
  resolved_at TEXT,
  resolved_by_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
INSERT INTO comments_new SELECT
  id, organization_id,
  CASE WHEN issue_id IS NOT NULL THEN 'issue' ELSE 'document' END,
  COALESCE(issue_id, document_id),
  author_id, body, internal, external_id, external_source,
  external_author, resolved_at, resolved_by_id, created_at, updated_at
FROM comments
--> statement-breakpoint
DROP TABLE comments
--> statement-breakpoint
ALTER TABLE comments_new RENAME TO comments
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS comments_entity_idx ON comments (organization_id, entity_type, entity_id)`;

const v68 = `CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_entity_user_idx ON subscriptions (entity_type, entity_id, user_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS subscriptions_entity_idx ON subscriptions (organization_id, entity_type, entity_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS shares (
  token TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  include_children INTEGER NOT NULL DEFAULT 0,
  created_by_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS shares_entity_idx ON shares (organization_id, entity_type, entity_id)
--> statement-breakpoint
INSERT INTO subscriptions (id, organization_id, entity_type, entity_id, user_id, created_at)
  SELECT id, organization_id, 'issue', issue_id, linear_user_id, created_at FROM issue_subscribers
--> statement-breakpoint
INSERT INTO subscriptions (id, organization_id, entity_type, entity_id, user_id, created_at)
  SELECT id, organization_id, 'document', document_id, user_id, created_at FROM document_watchers
--> statement-breakpoint
INSERT INTO shares (token, organization_id, entity_type, entity_id, include_children, created_by_id, created_at, expires_at)
  SELECT token, organization_id, 'issue', issue_id, 0, created_by_id, created_at, expires_at FROM issue_shares
--> statement-breakpoint
INSERT INTO shares (token, organization_id, entity_type, entity_id, include_children, created_by_id, created_at, expires_at)
  SELECT token, organization_id, 'document', document_id, include_children, created_by_id, created_at, expires_at FROM document_shares
--> statement-breakpoint
DROP TABLE issue_subscribers
--> statement-breakpoint
DROP TABLE document_watchers
--> statement-breakpoint
DROP TABLE issue_shares
--> statement-breakpoint
DROP TABLE document_shares`;

const v67 = `ALTER TABLE entity_links ADD COLUMN label TEXT`;

const v66 = `INSERT INTO entity_links (id, organization_id, from_type, from_id, to_type, to_id, kind, created_at)
  SELECT id, organization_id, 'issue', from_issue_id, 'issue', to_issue_id, type, created_at
  FROM issue_relations
--> statement-breakpoint
DROP TABLE issue_relations`;

const v65 = `ALTER TABLE customers ADD COLUMN domain TEXT
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customers_domain_idx ON customers (organization_id, domain)`;

const v64 = `INSERT INTO entity_links (id, organization_id, from_type, from_id, to_type, to_id, kind, created_at)
  SELECT lower(hex(randomblob(16))), d.organization_id, 'deal', d.id, 'contact', dc.contact_id, 'contact', dc.created_at
  FROM deal_contacts dc JOIN deals d ON d.id = dc.deal_id
--> statement-breakpoint
INSERT INTO entity_links (id, organization_id, from_type, from_id, to_type, to_id, kind, created_at)
  SELECT lower(hex(randomblob(16))), d.organization_id, 'deal', d.id, 'issue', dil.issue_id, 'relates', dil.created_at
  FROM deal_issue_links dil JOIN deals d ON d.id = dil.deal_id
--> statement-breakpoint
DROP TABLE deal_contacts
--> statement-breakpoint
DROP TABLE deal_issue_links`;

const v63 = `CREATE TABLE IF NOT EXISTS entity_links (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  from_type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_type TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'relates',
  created_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entity_links_from_idx ON entity_links (organization_id, from_type, from_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS entity_links_to_idx ON entity_links (organization_id, to_type, to_id)
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS entity_links_unique_idx ON entity_links (organization_id, from_type, from_id, to_type, to_id, kind)`;

const v62 = `ALTER TABLE customers ADD COLUMN notes TEXT`;

const v61 = `ALTER TABLE deals ADD COLUMN description TEXT
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS deal_issue_links (
  deal_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (deal_id, issue_id)
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS deal_issue_links_issue_idx ON deal_issue_links (issue_id)`;

const v59 = `CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  name TEXT NOT NULL,
  stage TEXT NOT NULL,
  amount_cents INTEGER,
  currency TEXT,
  expected_close_at TEXT,
  closed_at TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS deals_organization_idx ON deals (organization_id)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS deals_customer_idx ON deals (customer_id)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS deal_contacts (
  deal_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (deal_id, contact_id)
)
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS deal_contacts_contact_idx ON deal_contacts (contact_id)`;

const v56 = `CREATE TABLE IF NOT EXISTS issue_shares (
  token TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS issue_shares_issue_idx ON issue_shares (organization_id, issue_id)`;

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
      { idx: 28, when: 28, tag: "v29", breakpoints: true },
      { idx: 29, when: 29, tag: "v30", breakpoints: true },
      { idx: 30, when: 30, tag: "v31", breakpoints: false },
      { idx: 31, when: 31, tag: "v32", breakpoints: false },
      { idx: 32, when: 32, tag: "v33", breakpoints: false },
      { idx: 33, when: 33, tag: "v34", breakpoints: false },
      { idx: 34, when: 34, tag: "v35", breakpoints: true },
      { idx: 35, when: 35, tag: "v36", breakpoints: true },
      { idx: 36, when: 36, tag: "v37", breakpoints: true },
      { idx: 37, when: 37, tag: "v38", breakpoints: true },
      { idx: 38, when: 38, tag: "v39", breakpoints: true },
      { idx: 39, when: 39, tag: "v40", breakpoints: true },
      { idx: 40, when: 40, tag: "v41", breakpoints: true },
      { idx: 41, when: 41, tag: "v42", breakpoints: true },
      { idx: 42, when: 42, tag: "v43", breakpoints: true },
      { idx: 43, when: 43, tag: "v44", breakpoints: true },
      { idx: 44, when: 44, tag: "v45", breakpoints: true },
      { idx: 45, when: 45, tag: "v46", breakpoints: true },
      { idx: 46, when: 46, tag: "v47", breakpoints: true },
      { idx: 47, when: 47, tag: "v48", breakpoints: true },
      { idx: 48, when: 48, tag: "v49", breakpoints: true },
      { idx: 49, when: 49, tag: "v50", breakpoints: true },
      { idx: 50, when: 50, tag: "v51", breakpoints: true },
      { idx: 51, when: 51, tag: "v52", breakpoints: true },
      { idx: 52, when: 52, tag: "v53", breakpoints: true },
      { idx: 53, when: 53, tag: "v54", breakpoints: false },
      { idx: 54, when: 54, tag: "v55", breakpoints: false },
      { idx: 55, when: 55, tag: "v56", breakpoints: false },
      { idx: 56, when: 56, tag: "v57", breakpoints: false },
      { idx: 57, when: 57, tag: "v58", breakpoints: false },
      { idx: 58, when: 58, tag: "v59", breakpoints: false },
      { idx: 59, when: 59, tag: "v60", breakpoints: false },
      { idx: 60, when: 60, tag: "v61", breakpoints: false },
      { idx: 61, when: 61, tag: "v62", breakpoints: false },
      { idx: 62, when: 62, tag: "v63", breakpoints: false },
      { idx: 63, when: 63, tag: "v64", breakpoints: false },
      { idx: 64, when: 64, tag: "v65", breakpoints: false },
      { idx: 65, when: 65, tag: "v66", breakpoints: false },
      { idx: 66, when: 66, tag: "v67", breakpoints: false },
      { idx: 67, when: 67, tag: "v68", breakpoints: false },
      { idx: 68, when: 68, tag: "v69", breakpoints: false },
      { idx: 69, when: 69, tag: "v70", breakpoints: false },
      { idx: 70, when: 70, tag: "v71", breakpoints: true },
      { idx: 71, when: 71, tag: "v72", breakpoints: false },
      { idx: 72, when: 72, tag: "v73", breakpoints: true },
      { idx: 73, when: 73, tag: "v74", breakpoints: true },
      { idx: 74, when: 74, tag: "v75", breakpoints: false },
      { idx: 75, when: 75, tag: "v76", breakpoints: true },
      { idx: 76, when: 76, tag: "v77", breakpoints: true },
      { idx: 77, when: 77, tag: "v78", breakpoints: true },
      { idx: 78, when: 78, tag: "v79", breakpoints: true },
      { idx: 79, when: 79, tag: "v80", breakpoints: true },
      { idx: 80, when: 80, tag: "v81", breakpoints: true },
      { idx: 81, when: 81, tag: "v82", breakpoints: true },
      { idx: 82, when: 82, tag: "v83", breakpoints: true },
      { idx: 83, when: 83, tag: "v84", breakpoints: true },
      { idx: 84, when: 84, tag: "v85", breakpoints: true },
      { idx: 85, when: 85, tag: "v86", breakpoints: true },
      { idx: 86, when: 86, tag: "v87", breakpoints: true },
      { idx: 87, when: 87, tag: "v88", breakpoints: true },
      { idx: 88, when: 88, tag: "v89", breakpoints: true },
      { idx: 89, when: 89, tag: "v91", breakpoints: true },
      { idx: 90, when: 90, tag: "v90", breakpoints: true },
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
    m0028: v29,
    m0029: v30,
    m0030: v31,
    m0031: v32,
    m0032: v33,
    m0033: v34,
    m0034: v35,
    m0035: v36,
    m0036: v37,
    m0037: v38,
    m0038: v39,
    m0039: v40,
    m0040: v41,
    m0041: v42,
    m0042: v43,
    m0043: v44,
    m0044: v45,
    m0045: v46,
    m0046: v47,
    m0047: v48,
    m0048: v49,
    m0049: v50,
    m0050: v51,
    m0051: v52,
    m0052: v53,
    m0053: v54,
    m0054: v55,
    m0055: v56,
    m0056: v57,
    m0057: v58,
    m0058: v59,
    m0059: v60,
    m0060: v61,
    m0061: v62,
    m0062: v63,
    m0063: v64,
    m0064: v65,
    m0065: v66,
    m0066: v67,
    m0067: v68,
    m0068: v69,
    m0069: v70,
    m0070: v71,
    m0071: v72,
    m0072: v73,
    m0073: v74,
    m0074: v75,
    m0075: v76,
    m0076: v77,
    m0077: v78,
    m0078: v79,
    m0079: v80,
    m0080: v81,
    m0081: v82,
    m0082: v83,
    m0083: v84,
    m0084: v85,
    m0085: v86,
    m0086: v87,
    m0087: v88,
    m0088: v89,
    m0089: v91,
    m0090: v90,
  },
} satisfies Parameters<typeof migrate>[1];
