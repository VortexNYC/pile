CREATE TABLE `gitlab_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`project_path` text NOT NULL,
	`token` text NOT NULL,
	`webhook_secret` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gitlab_installations_project_path_idx` ON `gitlab_installations` (`organization_id`,`project_path`);--> statement-breakpoint
CREATE INDEX `gitlab_installations_organization_idx` ON `gitlab_installations` (`organization_id`);--> statement-breakpoint
CREATE TABLE `gitlab_users` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`gitlab_username` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gitlab_users_workspace_username_idx` ON `gitlab_users` (`organization_id`,`gitlab_username`);--> statement-breakpoint
CREATE UNIQUE INDEX `gitlab_users_workspace_user_idx` ON `gitlab_users` (`organization_id`,`user_id`);--> statement-breakpoint
DROP INDEX `repo_issues_repo_number_idx`;--> statement-breakpoint
ALTER TABLE `repo_issues` ADD `source` text DEFAULT 'github' NOT NULL;--> statement-breakpoint
CREATE INDEX `repo_issues_source_repo_number_idx` ON `repo_issues` (`source`,`repo`,`issue_number`);
