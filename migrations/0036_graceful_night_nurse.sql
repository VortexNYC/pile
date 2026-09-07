CREATE TABLE `chat_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `chat_state_expires_idx` ON `chat_state` (`expires_at`);--> statement-breakpoint
CREATE TABLE `slack_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`team_id` text NOT NULL,
	`team_name` text,
	`enterprise_id` text,
	`is_enterprise_install` integer DEFAULT false NOT NULL,
	`default_channel_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `slack_installations_org_idx` ON `slack_installations` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `slack_installations_team_idx` ON `slack_installations` (`team_id`);