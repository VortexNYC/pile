DROP INDEX IF EXISTS repo_issues_source_repo_number_idx;
CREATE UNIQUE INDEX repo_issues_source_repo_number_idx ON repo_issues (source, repo, issue_number);
