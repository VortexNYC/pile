CREATE TABLE `support_capture_links` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`public_key_id` text NOT NULL,
	`token` text NOT NULL,
	`name` text NOT NULL,
	`expires_at` text,
	`max_sessions` integer,
	`require_challenge` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`public_key_id`) REFERENCES `support_capture_public_keys`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_capture_links_token_idx` ON `support_capture_links` (`token`);--> statement-breakpoint
CREATE INDEX `support_capture_links_org_idx` ON `support_capture_links` (`organization_id`);--> statement-breakpoint
ALTER TABLE `support_capture_sessions` ADD `link_id` text REFERENCES support_capture_links(id);