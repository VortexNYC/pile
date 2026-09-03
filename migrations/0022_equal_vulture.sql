CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`recipient_type` text DEFAULT 'user' NOT NULL,
	`issue_id` text NOT NULL,
	`type` text NOT NULL,
	`read` integer DEFAULT false NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `notifications_recipient_idx` ON `notifications` (`workspace_id`,`recipient_id`,`recipient_type`,`read`);--> statement-breakpoint
CREATE INDEX `notifications_issue_idx` ON `notifications` (`workspace_id`,`issue_id`);