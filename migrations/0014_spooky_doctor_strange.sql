CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`linear_id` text NOT NULL,
	`name` text NOT NULL,
	`template_data` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `templates_workspace_idx` ON `templates` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `templates_linear_idx` ON `templates` (`workspace_id`,`linear_id`);