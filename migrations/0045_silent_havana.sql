CREATE TABLE `push_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text,
	`provider` text DEFAULT 'fcm' NOT NULL,
	`token` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`token_id` text NOT NULL,
	`user_id` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `push_tokens_organization_idx` ON `push_tokens` (`organization_id`);
--> statement-breakpoint
CREATE INDEX `push_tokens_user_idx` ON `push_tokens` (`user_id`);
--> statement-breakpoint
CREATE INDEX `push_deliveries_organization_idx` ON `push_deliveries` (`organization_id`);
--> statement-breakpoint
CREATE INDEX `push_deliveries_token_idx` ON `push_deliveries` (`token_id`);
--> statement-breakpoint
CREATE INDEX `push_deliveries_user_idx` ON `push_deliveries` (`user_id`);