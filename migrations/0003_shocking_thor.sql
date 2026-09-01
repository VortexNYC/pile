CREATE TABLE `webhook_deliveries` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`event` text NOT NULL,
	`workspace_id` text,
	`processed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_workspace_idx` ON `webhook_deliveries` (`workspace_id`);