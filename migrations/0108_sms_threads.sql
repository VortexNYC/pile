-- Per-phone SMS threads: a Sendblue number's conversation binds to its
-- support ticket, the Devin concierge session answering it, and the
-- workspace-scoped API key the agent uses.
CREATE TABLE `support_sms_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`phone` text NOT NULL,
	`customer_id` text,
	`ticket_id` text,
	`devin_session_id` text,
	`api_key` text,
	`api_key_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `support_customers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_sms_threads_org_phone_idx` ON `support_sms_threads` (`organization_id`,`phone`);--> statement-breakpoint
CREATE INDEX `support_sms_threads_ticket_idx` ON `support_sms_threads` (`ticket_id`);
