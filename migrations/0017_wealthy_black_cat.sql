PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`author_id` text,
	`body` text NOT NULL,
	`external_id` text,
	`external_source` text,
	`external_author` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_comments`("id", "workspace_id", "issue_id", "author_id", "body", "external_id", "external_source", "external_author", "created_at", "updated_at") SELECT "id", "workspace_id", "issue_id", "author_id", "body", "external_id", "external_source", "external_author", "created_at", "updated_at" FROM `comments`;--> statement-breakpoint
DROP TABLE `comments`;--> statement-breakpoint
ALTER TABLE `__new_comments` RENAME TO `comments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `comments_issue_idx` ON `comments` (`workspace_id`,`issue_id`);--> statement-breakpoint
CREATE INDEX `comments_author_idx` ON `comments` (`workspace_id`,`author_id`);--> statement-breakpoint
CREATE INDEX `comments_external_idx` ON `comments` (`workspace_id`,`external_source`,`external_id`);