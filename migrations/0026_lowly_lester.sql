CREATE TABLE `agent_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`actor_id` text,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`payload` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `agent_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_activities_session_idx` ON `agent_activities` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`provider` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`status` text DEFAULT 'created' NOT NULL,
	`result` text,
	`url` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `agent_sessions_workspace_idx` ON `agent_sessions` (`workspace_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `agent_sessions_issue_idx` ON `agent_sessions` (`issue_id`);