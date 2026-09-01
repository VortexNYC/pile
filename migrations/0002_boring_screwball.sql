CREATE TABLE `repo_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`repo` text NOT NULL,
	`issue_number` integer NOT NULL,
	`issue_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `repo_issues_repo_number_idx` ON `repo_issues` (`repo`,`issue_number`);--> statement-breakpoint
CREATE INDEX `repo_issues_workspace_idx` ON `repo_issues` (`workspace_id`);