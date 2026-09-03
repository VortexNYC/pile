import { migrate } from "drizzle-orm/durable-sqlite/migrator";

const v1 = `CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  assignee_id TEXT,
  project_id TEXT,
  cycle_id TEXT,
  label_ids TEXT,
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
CREATE INDEX IF NOT EXISTS idx_issues_priority ON issues (priority, created_at DESC)`;

export const workspaceMigrations = {
  journal: {
    entries: [{ idx: 0, when: 0, tag: "v1", breakpoints: false }],
  },
  migrations: {
    m0000: v1,
  },
} satisfies Parameters<typeof migrate>[1];
