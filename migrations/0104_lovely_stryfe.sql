CREATE TABLE `support_customer_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`support_customer_id` text NOT NULL,
	`type` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`external_id` text,
	`summary` text NOT NULL,
	`payload` text,
	`occurred_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`support_customer_id`) REFERENCES `support_customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `support_customer_events_customer_idx` ON `support_customer_events` (`support_customer_id`,`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `support_customer_events_external_idx` ON `support_customer_events` (`organization_id`,`source`,`external_id`);