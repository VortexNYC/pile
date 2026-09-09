CREATE TABLE `email_inboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`address` text NOT NULL,
	`team_id` text,
	`project_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`period` text NOT NULL,
	`resource` text NOT NULL,
	`action` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_inboxes_organization_idx` ON `email_inboxes` (`organization_id`);
--> statement-breakpoint
CREATE INDEX `email_inboxes_address_idx` ON `email_inboxes` (`address`);
--> statement-breakpoint
CREATE INDEX `usage_records_organization_idx` ON `usage_records` (`organization_id`);
--> statement-breakpoint
CREATE INDEX `usage_records_period_idx` ON `usage_records` (`period`);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_records_period_resource_action_unique` ON `usage_records` (`organization_id`, `period`, `resource`, `action`);