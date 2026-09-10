CREATE TABLE `support_ticket_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`user_id` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_ticket_assignments_unique_idx` ON `support_ticket_assignments` (`ticket_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `support_ticket_assignments_ticket_idx` ON `support_ticket_assignments` (`ticket_id`,`is_primary`);--> statement-breakpoint
CREATE TABLE `support_ticket_counters` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`next_number` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `support_ticket_events` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`type` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `support_ticket_events_ticket_created_idx` ON `support_ticket_events` (`ticket_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `support_ticket_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`label_id` text NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_ticket_labels_unique_idx` ON `support_ticket_labels` (`ticket_id`,`label_id`);--> statement-breakpoint
CREATE TABLE `support_ticket_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`direction` text NOT NULL,
	`text_content` text NOT NULL,
	`markdown_content` text,
	`channel` text NOT NULL,
	`customer_id` text,
	`user_id` text,
	FOREIGN KEY (`event_id`) REFERENCES `support_ticket_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `support_customers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `support_ticket_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`body` text NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `support_ticket_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `support_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`number` integer NOT NULL,
	`external_id` text,
	`external_source` text DEFAULT 'manual' NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`source_channel` text NOT NULL,
	`issue_id` text,
	`last_customer_message_at` text,
	`last_agent_message_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `support_customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_tickets_org_number_idx` ON `support_tickets` (`organization_id`,`number`);--> statement-breakpoint
CREATE INDEX `support_tickets_org_customer_idx` ON `support_tickets` (`organization_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `support_tickets_org_status_idx` ON `support_tickets` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `support_tickets_org_priority_idx` ON `support_tickets` (`organization_id`,`priority`);