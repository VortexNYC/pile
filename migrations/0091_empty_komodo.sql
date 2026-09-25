CREATE TABLE `support_ticket_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`customer_id` text,
	`voter_email` text NOT NULL,
	`priority` text,
	`cast_by_actor_type` text,
	`cast_by_actor_id` text,
	`source_ticket_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `support_customers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_ticket_votes_ticket_voter_idx` ON `support_ticket_votes` (`ticket_id`,`voter_email`);--> statement-breakpoint
CREATE INDEX `support_ticket_votes_org_ticket_idx` ON `support_ticket_votes` (`organization_id`,`ticket_id`);--> statement-breakpoint
CREATE INDEX `support_ticket_votes_customer_idx` ON `support_ticket_votes` (`customer_id`);