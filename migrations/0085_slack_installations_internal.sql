ALTER TABLE slack_installations ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slack_installations ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;

DROP INDEX IF EXISTS slack_installations_team_idx;

CREATE UNIQUE INDEX IF NOT EXISTS slack_installations_org_team_idx
  ON slack_installations (organization_id, team_id);
