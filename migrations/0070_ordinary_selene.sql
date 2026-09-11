CREATE TABLE `support_saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`filter` text DEFAULT '{}' NOT NULL,
	`sort` text DEFAULT '{"by":"updated_at","direction":"desc"}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `support_saved_views_org_user_idx` ON `support_saved_views` (`organization_id`,`user_id`);