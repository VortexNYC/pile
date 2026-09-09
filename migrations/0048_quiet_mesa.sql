CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`project_id` text,
	`team_id` text,
	`name` text NOT NULL,
	`version` text,
	`status` text DEFAULT 'upcoming' NOT NULL,
	`notes` text,
	`planned_at` text,
	`released_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `releases_organization_idx` ON `releases` (`organization_id`);
--> statement-breakpoint
CREATE INDEX `releases_project_idx` ON `releases` (`project_id`);
--> statement-breakpoint
CREATE INDEX `releases_team_idx` ON `releases` (`team_id`);