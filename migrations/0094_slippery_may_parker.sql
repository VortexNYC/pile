CREATE TABLE `changelog_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`published_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `changelog_entries_org_published_idx` ON `changelog_entries` (`organization_id`,`published_at`);--> statement-breakpoint
CREATE TABLE `changelog_entry_links` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`ticket_id` text,
	`issue_id` text,
	FOREIGN KEY (`entry_id`) REFERENCES `changelog_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "changelog_entry_links_target_check" CHECK(("changelog_entry_links"."ticket_id" IS NOT NULL OR "changelog_entry_links"."issue_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `changelog_entry_links_entry_idx` ON `changelog_entry_links` (`entry_id`);--> statement-breakpoint
CREATE INDEX `changelog_entry_links_ticket_idx` ON `changelog_entry_links` (`ticket_id`);