CREATE TABLE `issue_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`from_issue_id` text NOT NULL,
	`to_issue_id` text NOT NULL,
	`type` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `issue_relations_from_idx` ON `issue_relations` (`workspace_id`,`from_issue_id`);--> statement-breakpoint
CREATE INDEX `issue_relations_to_idx` ON `issue_relations` (`workspace_id`,`to_issue_id`);--> statement-breakpoint
DROP INDEX `comments_author_idx`;--> statement-breakpoint
CREATE INDEX `comments_author_idx` ON `comments` (`workspace_id`,`author_id`);--> statement-breakpoint
ALTER TABLE `linear_users` ADD `linear_id` text NOT NULL;--> statement-breakpoint
CREATE INDEX `linear_users_linear_idx` ON `linear_users` (`workspace_id`,`linear_id`);