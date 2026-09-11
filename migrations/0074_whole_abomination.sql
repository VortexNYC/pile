DROP TABLE `support_slas`;--> statement-breakpoint
DROP TABLE `support_ticket_sla_events`;--> statement-breakpoint
ALTER TABLE `support_ticket_attachments` ADD `type` text DEFAULT 'screenshot' NOT NULL;