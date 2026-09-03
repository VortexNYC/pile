CREATE TABLE `team_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`team_id` text NOT NULL,
	`member_id` text NOT NULL,
	`member_type` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `team_memberships_workspace_idx` ON `team_memberships` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `team_memberships_member_idx` ON `team_memberships` (`team_id`,`member_id`,`member_type`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`owner_id` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`is_public` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `teams_workspace_idx` ON `teams` (`workspace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `teams_workspace_key_idx` ON `teams` (`workspace_id`,`key`);