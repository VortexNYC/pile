CREATE TABLE `support_autoresponders` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`trigger` text NOT NULL,
	`order` integer NOT NULL,
	`snippet_id` text,
	`conditions` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`snippet_id`) REFERENCES `support_snippets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `support_autoresponders_org_enabled_order_idx` ON `support_autoresponders` (`organization_id`,`enabled`,`order`);--> statement-breakpoint
CREATE TABLE `support_snippets` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`text_content` text NOT NULL,
	`markdown_content` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_snippets_organization_name_idx` ON `support_snippets` (`organization_id`,`name`);--> statement-breakpoint
CREATE INDEX `support_snippets_organization_idx` ON `support_snippets` (`organization_id`);--> statement-breakpoint
ALTER TABLE `labels` ADD `kind` text DEFAULT 'issue' NOT NULL;--> statement-breakpoint
ALTER TABLE `labels` ADD `updated_at` text DEFAULT '1970-01-01T00:00:00Z' NOT NULL;
UPDATE `labels` SET `updated_at` = CURRENT_TIMESTAMP;