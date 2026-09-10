CREATE TABLE `plain_customers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`external_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plain_customers_external_idx` ON `plain_customers` (`organization_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `plain_customers_customer_idx` ON `plain_customers` (`customer_id`);--> statement-breakpoint
CREATE TABLE `plain_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`external_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plain_threads_external_idx` ON `plain_threads` (`organization_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `plain_threads_ticket_idx` ON `plain_threads` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `zendesk_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`external_id` text NOT NULL,
	`ticket_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `zendesk_tickets_external_idx` ON `zendesk_tickets` (`organization_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `zendesk_tickets_ticket_idx` ON `zendesk_tickets` (`ticket_id`);