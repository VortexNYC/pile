CREATE TABLE `reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reactions_target_idx` ON `reactions` (`organization_id`,`target_type`,`target_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `reactions_unique_idx` ON `reactions` (`organization_id`,`target_type`,`target_id`,`actor_id`,`emoji`);