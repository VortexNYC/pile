CREATE TABLE `notion_issue_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`notion_page_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notion_issue_mappings_workspace_page_idx` ON `notion_issue_mappings` (`organization_id`,`notion_page_id`);--> statement-breakpoint
CREATE INDEX `notion_issue_mappings_issue_idx` ON `notion_issue_mappings` (`organization_id`,`issue_id`);