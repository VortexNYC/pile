CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `comments_issue_idx` ON `comments` (`workspace_id`,`issue_id`);--> statement-breakpoint
CREATE INDEX `comments_author_idx` ON `comments` (`author_id`);--> statement-breakpoint
CREATE TABLE `linear_users` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text,
	`email` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `linear_users_workspace_idx` ON `linear_users` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `linear_users_email_idx` ON `linear_users` (`email`);