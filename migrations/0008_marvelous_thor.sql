CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`linear_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`subtitle` text,
	`r2_key` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attachments_issue_idx` ON `attachments` (`workspace_id`,`issue_id`);--> statement-breakpoint
CREATE INDEX `attachments_linear_idx` ON `attachments` (`workspace_id`,`linear_id`);