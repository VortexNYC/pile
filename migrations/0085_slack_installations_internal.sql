-- D1 does not allow ALTER TABLE ... ADD COLUMN with a non-constant default
-- (CURRENT_TIMESTAMP), so the table is rebuilt to add `is_internal` and
-- `updated_at` with their real defaults.
CREATE TABLE `slack_installations_new` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`team_id` text NOT NULL,
	`team_name` text,
	`enterprise_id` text,
	`is_enterprise_install` integer DEFAULT false NOT NULL,
	`is_internal` integer DEFAULT false NOT NULL,
	`default_channel_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `slack_installations_new` (
	`id`, `organization_id`, `team_id`, `team_name`, `enterprise_id`,
	`is_enterprise_install`, `default_channel_id`, `created_at`, `updated_at`
)
SELECT
	`id`, `organization_id`, `team_id`, `team_name`, `enterprise_id`,
	`is_enterprise_install`, `default_channel_id`, `created_at`, `created_at`
FROM `slack_installations`;
--> statement-breakpoint
DROP TABLE `slack_installations`;
--> statement-breakpoint
ALTER TABLE `slack_installations_new` RENAME TO `slack_installations`;
--> statement-breakpoint
CREATE INDEX `slack_installations_org_idx` ON `slack_installations` (`organization_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_installations_org_team_idx` ON `slack_installations` (`organization_id`, `team_id`);
