CREATE TABLE `issue_subscribers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`linear_user_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `issue_subscribers_issue_idx` ON `issue_subscribers` (`workspace_id`,`issue_id`);--> statement-breakpoint
CREATE INDEX `issue_subscribers_user_idx` ON `issue_subscribers` (`workspace_id`,`linear_user_id`);