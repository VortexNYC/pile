CREATE TABLE `initiatives` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`roadmap_id` text,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`start_date` text,
	`target_date` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`roadmap_id`) REFERENCES `roadmaps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `initiatives_organization_idx` ON `initiatives` (`organization_id`);--> statement-breakpoint
CREATE INDEX `initiatives_roadmap_idx` ON `initiatives` (`roadmap_id`);--> statement-breakpoint
CREATE TABLE `roadmaps` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `roadmaps_organization_idx` ON `roadmaps` (`organization_id`);--> statement-breakpoint
CREATE INDEX `roadmaps_org_name_idx` ON `roadmaps` (`organization_id`,`name`);