CREATE TABLE `intercom_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intercom_conversations_external_idx` ON `intercom_conversations` (`organization_id`,`conversation_id`);--> statement-breakpoint
CREATE INDEX `intercom_conversations_issue_idx` ON `intercom_conversations` (`issue_id`);