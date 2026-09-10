PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_support_ticket_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`event_id` text NOT NULL,
	`external_id` text,
	`url` text,
	`file_name` text,
	`content_type` text,
	`size` integer,
	`r2_key` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `support_ticket_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_support_ticket_attachments`("id", "organization_id", "ticket_id", "event_id", "external_id", "url", "file_name", "content_type", "size", "r2_key", "created_at") SELECT "id", "organization_id", "ticket_id", "event_id", "external_id", "url", "file_name", "content_type", "size", "r2_key", "created_at" FROM `support_ticket_attachments`;--> statement-breakpoint
DROP TABLE `support_ticket_attachments`;--> statement-breakpoint
ALTER TABLE `__new_support_ticket_attachments` RENAME TO `support_ticket_attachments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `support_ticket_attachments_ticket_idx` ON `support_ticket_attachments` (`ticket_id`);--> statement-breakpoint
CREATE INDEX `support_ticket_attachments_event_idx` ON `support_ticket_attachments` (`event_id`);