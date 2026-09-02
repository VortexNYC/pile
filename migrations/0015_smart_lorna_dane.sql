PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_issue_history` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`linear_id` text,
	`field` text NOT NULL,
	`from_value` text,
	`to_value` text,
	`actor_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_issue_history`("id", "workspace_id", "issue_id", "linear_id", "field", "from_value", "to_value", "actor_id", "created_at") SELECT "id", "workspace_id", "issue_id", "linear_id", "field", "from_value", "to_value", "actor_id", "created_at" FROM `issue_history`;--> statement-breakpoint
DROP TABLE `issue_history`;--> statement-breakpoint
ALTER TABLE `__new_issue_history` RENAME TO `issue_history`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `issue_history_issue_idx` ON `issue_history` (`workspace_id`,`issue_id`);--> statement-breakpoint
CREATE INDEX `issue_history_created_idx` ON `issue_history` (`workspace_id`,`created_at`);