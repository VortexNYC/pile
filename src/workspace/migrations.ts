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

export const workspaceMigrations = {
  journal: {
    entries: [
      { idx: 0, when: 0, tag: "v1", breakpoints: false },
      { idx: 1, when: 1, tag: "v2", breakpoints: true },
    ],
  },
  migrations: {
    m0000: v1,
    m0001: v2,
  },
} satisfies Parameters<typeof migrate>[1];
