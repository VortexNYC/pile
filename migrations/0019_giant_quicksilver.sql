CREATE TABLE `github_users` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`github_login` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_users_workspace_login_idx` ON `github_users` (`workspace_id`,`github_login`);--> statement-breakpoint
CREATE UNIQUE INDEX `github_users_workspace_user_idx` ON `github_users` (`workspace_id`,`user_id`);