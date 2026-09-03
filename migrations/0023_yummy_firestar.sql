CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`filter` text NOT NULL,
	`search` text,
	`sort` text,
	`columns` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `saved_views_workspace_idx` ON `saved_views` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `saved_views_owner_idx` ON `saved_views` (`workspace_id`,`owner_id`);