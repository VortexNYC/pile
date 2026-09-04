CREATE TABLE `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text DEFAULT 'default' NOT NULL,
	`name` text,
	`prefix` text,
	`start` text,
	`key` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`expires_at` integer,
	`reference_id` text NOT NULL,
	`last_refill_at` integer,
	`last_request` integer,
	`metadata` text,
	`rate_limit_max` integer,
	`rate_limit_time_window` integer,
	`remaining` integer,
	`refill_amount` integer,
	`refill_interval` integer,
	`rate_limit_enabled` integer DEFAULT true NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`permissions` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `apikey_key_unique` ON `apikey` (`key`);--> statement-breakpoint
CREATE INDEX `apikey_reference_idx` ON `apikey` (`reference_id`);--> statement-breakpoint
CREATE INDEX `apikey_reference_config_idx` ON `apikey` (`reference_id`,`config_id`);