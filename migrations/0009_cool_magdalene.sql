CREATE TABLE `issue_history` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`linear_id` text NOT NULL,
	`field` text NOT NULL,
	`from_value` text,
	`to_value` text,
	`actor_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `issue_history_issue_idx` ON `issue_history` (`workspace_id`,`issue_id`);--> statement-breakpoint
CREATE INDEX `issue_history_created_idx` ON `issue_history` (`workspace_id`,`created_at`);