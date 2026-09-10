CREATE TABLE `support_ticket_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`event_id` text NOT NULL,
	`external_id` text,
	`url` text NOT NULL,
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
CREATE INDEX `support_ticket_attachments_ticket_idx` ON `support_ticket_attachments` (`ticket_id`);--> statement-breakpoint
CREATE INDEX `support_ticket_attachments_event_idx` ON `support_ticket_attachments` (`event_id`);--> statement-breakpoint
ALTER TABLE `support_ticket_events` ADD `metadata` text;