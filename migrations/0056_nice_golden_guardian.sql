CREATE TABLE `import_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`job_id` text NOT NULL,
	`source` text NOT NULL,
	`type` text NOT NULL,
	`external_id` text NOT NULL,
	`vortex_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_mappings_job_external_idx` ON `import_mappings` (`job_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `import_mappings_organization_idx` ON `import_mappings` (`organization_id`);--> statement-breakpoint
CREATE TABLE `import_parent_links` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`job_id` text NOT NULL,
	`child_id` text NOT NULL,
	`parent_external_id` text NOT NULL,
	`resolved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_parent_links_job_idx` ON `import_parent_links` (`job_id`);--> statement-breakpoint
CREATE INDEX `import_parent_links_child_idx` ON `import_parent_links` (`child_id`);--> statement-breakpoint
CREATE INDEX `import_parent_links_parent_external_idx` ON `import_parent_links` (`job_id`,`parent_external_id`);