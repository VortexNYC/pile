CREATE TABLE `support_widget_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`key` text NOT NULL,
	`hmac_secret` text NOT NULL,
	`name` text NOT NULL,
	`allowed_origins` text DEFAULT '[]' NOT NULL,
	`greeting` text,
	`brand_color` text,
	`require_email` integer DEFAULT false NOT NULL,
	`require_challenge` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_widget_keys_key_idx` ON `support_widget_keys` (`key`);--> statement-breakpoint
CREATE INDEX `support_widget_keys_org_idx` ON `support_widget_keys` (`organization_id`);--> statement-breakpoint
CREATE TABLE `support_widget_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`widget_key_id` text NOT NULL,
	`token` text NOT NULL,
	`customer_id` text,
	`ticket_id` text,
	`external_id` text,
	`identity_verified` integer DEFAULT false NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`widget_key_id`) REFERENCES `support_widget_keys`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `support_customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_widget_sessions_token_idx` ON `support_widget_sessions` (`token`);--> statement-breakpoint
CREATE INDEX `support_widget_sessions_org_idx` ON `support_widget_sessions` (`organization_id`);--> statement-breakpoint
CREATE INDEX `support_widget_sessions_ticket_idx` ON `support_widget_sessions` (`ticket_id`);