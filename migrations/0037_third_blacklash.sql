CREATE TABLE `user_workspace_preferences` (
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`default_view_id` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`organization_id`, `user_id`),
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_view_id`) REFERENCES `saved_views`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `view_favorites` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`view_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`view_id`) REFERENCES `saved_views`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `view_favorites_view_user_idx` ON `view_favorites` (`view_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `view_favorites_user_idx` ON `view_favorites` (`organization_id`,`user_id`);--> statement-breakpoint
ALTER TABLE `notifications` ADD `snoozed_until` text;--> statement-breakpoint
ALTER TABLE `saved_views` ADD `shared` integer DEFAULT false NOT NULL;