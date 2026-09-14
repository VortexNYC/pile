CREATE TABLE IF NOT EXISTS support_conversations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  slack_team_id TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  slack_thread_ts TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  support_ticket_id TEXT,
  is_external INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (organization_id) REFERENCES organization (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS support_conversations_slack_idx
  ON support_conversations (organization_id, slack_team_id, slack_channel_id, slack_thread_ts);

CREATE INDEX IF NOT EXISTS support_conversations_issue_idx
  ON support_conversations (organization_id, issue_id);
