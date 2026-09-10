CREATE TABLE `support_slas` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`tier_id` text,
	`priority` text NOT NULL,
	`first_response_minutes` integer,
	`next_response_minutes` integer,
	`resolution_minutes` integer,
	`business_hours_only` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tier_id`) REFERENCES `support_tiers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_slas_org_name_idx` ON `support_slas` (`organization_id`,`name`);--> statement-breakpoint
CREATE TABLE `support_ticket_sla_events` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`sla_id` text NOT NULL,
	`type` text NOT NULL,
	`target_at` text NOT NULL,
	`met_at` text,
	`breached` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sla_id`) REFERENCES `support_slas`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `support_ticket_sla_events_ticket_type_idx` ON `support_ticket_sla_events` (`ticket_id`,`type`);--> statement-breakpoint
CREATE TABLE `support_tier_members` (
	`id` text PRIMARY KEY NOT NULL,
	`tier_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`tier_id`) REFERENCES `support_tiers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_tier_members_tier_user_idx` ON `support_tier_members` (`tier_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `support_tiers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`level` integer NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_tiers_org_name_idx` ON `support_tiers` (`organization_id`,`name`);--> statement-breakpoint
CREATE TABLE `support_user_status` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text NOT NULL,
	`until` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_user_status_org_user_idx` ON `support_user_status` (`organization_id`,`user_id`);