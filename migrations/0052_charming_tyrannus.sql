CREATE TABLE `notion_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`workspace_id` text,
	`token` text NOT NULL,
	`verification_token` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notion_installations_workspace_idx` ON `notion_installations` (`organization_id`,`workspace_id`);--> statement-breakpoint
CREATE INDEX `notion_installations_organization_idx` ON `notion_installations` (`organization_id`);--> statement-breakpoint
CREATE TABLE `notion_page_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`notion_page_id` text NOT NULL,
	`document_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notion_page_mappings_workspace_page_idx` ON `notion_page_mappings` (`organization_id`,`notion_page_id`);--> statement-breakpoint
CREATE INDEX `notion_page_mappings_document_idx` ON `notion_page_mappings` (`organization_id`,`document_id`);--> statement-breakpoint
CREATE TABLE `notion_users` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`notion_user_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notion_users_workspace_user_idx` ON `notion_users` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `notion_users_workspace_notion_idx` ON `notion_users` (`organization_id`,`notion_user_id`);