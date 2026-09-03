CREATE TABLE `github_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`repo` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `github_installations_repo_idx` ON `github_installations` (`repo`);--> statement-breakpoint
CREATE INDEX `github_installations_workspace_idx` ON `github_installations` (`workspace_id`);