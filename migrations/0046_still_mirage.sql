ALTER TABLE `projects` ADD `lead_id` text;
--> statement-breakpoint
CREATE TABLE `project_members` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `project_members_project_idx` ON `project_members` (`project_id`);
--> statement-breakpoint
CREATE INDEX `project_members_user_idx` ON `project_members` (`user_id`);
--> statement-breakpoint
CREATE INDEX `project_members_organization_idx` ON `project_members` (`organization_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_members_project_user_unique` ON `project_members` (`project_id`, `user_id`);