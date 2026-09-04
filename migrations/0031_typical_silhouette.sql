DROP TABLE `team_memberships`;--> statement-breakpoint
DROP TABLE `teams`;--> statement-breakpoint
DROP TABLE `workspace_memberships`;--> statement-breakpoint
DROP TABLE `workspaces`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agent_sessions` (
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
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_agent_sessions`("id", "workspace_id", "issue_id", "agent_id", "provider", "actor_id", "actor_type", "status", "result", "url", "created_at", "updated_at") SELECT "id", "workspace_id", "issue_id", "agent_id", "provider", "actor_id", "actor_type", "status", "result", "url", "created_at", "updated_at" FROM `agent_sessions`;--> statement-breakpoint
DROP TABLE `agent_sessions`;--> statement-breakpoint
ALTER TABLE `__new_agent_sessions` RENAME TO `agent_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `agent_sessions_workspace_idx` ON `agent_sessions` (`workspace_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `agent_sessions_issue_idx` ON `agent_sessions` (`issue_id`);--> statement-breakpoint
CREATE TABLE `__new_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`linear_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`subtitle` text,
	`r2_key` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_attachments`("id", "workspace_id", "issue_id", "linear_id", "url", "title", "subtitle", "r2_key", "created_at") SELECT "id", "workspace_id", "issue_id", "linear_id", "url", "title", "subtitle", "r2_key", "created_at" FROM `attachments`;--> statement-breakpoint
DROP TABLE `attachments`;--> statement-breakpoint
ALTER TABLE `__new_attachments` RENAME TO `attachments`;--> statement-breakpoint
CREATE INDEX `attachments_issue_idx` ON `attachments` (`workspace_id`,`issue_id`);--> statement-breakpoint
CREATE INDEX `attachments_linear_idx` ON `attachments` (`workspace_id`,`linear_id`);--> statement-breakpoint
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
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_comments`("id", "workspace_id", "issue_id", "author_id", "body", "external_id", "external_source", "external_author", "created_at", "updated_at") SELECT "id", "workspace_id", "issue_id", "author_id", "body", "external_id", "external_source", "external_author", "created_at", "updated_at" FROM `comments`;--> statement-breakpoint
DROP TABLE `comments`;--> statement-breakpoint
ALTER TABLE `__new_comments` RENAME TO `comments`;--> statement-breakpoint
CREATE INDEX `comments_issue_idx` ON `comments` (`workspace_id`,`issue_id`);--> statement-breakpoint
CREATE INDEX `comments_author_idx` ON `comments` (`workspace_id`,`author_id`);--> statement-breakpoint
CREATE INDEX `comments_external_idx` ON `comments` (`workspace_id`,`external_source`,`external_id`);--> statement-breakpoint
CREATE TABLE `__new_cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`start_date` text,
	`end_date` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_cycles`("id", "workspace_id", "project_id", "name", "start_date", "end_date", "created_at", "updated_at") SELECT "id", "workspace_id", "project_id", "name", "start_date", "end_date", "created_at", "updated_at" FROM `cycles`;--> statement-breakpoint
DROP TABLE `cycles`;--> statement-breakpoint
ALTER TABLE `__new_cycles` RENAME TO `cycles`;--> statement-breakpoint
CREATE INDEX `cycles_workspace_idx` ON `cycles` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `cycles_project_idx` ON `cycles` (`project_id`);--> statement-breakpoint
CREATE TABLE `__new_github_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`repo` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_github_installations`("id", "workspace_id", "installation_id", "repo", "created_at") SELECT "id", "workspace_id", "installation_id", "repo", "created_at" FROM `github_installations`;--> statement-breakpoint
DROP TABLE `github_installations`;--> statement-breakpoint
ALTER TABLE `__new_github_installations` RENAME TO `github_installations`;--> statement-breakpoint
CREATE INDEX `github_installations_repo_idx` ON `github_installations` (`repo`);--> statement-breakpoint
CREATE INDEX `github_installations_workspace_idx` ON `github_installations` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `__new_github_users` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`github_login` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_github_users`("id", "workspace_id", "user_id", "github_login", "created_at") SELECT "id", "workspace_id", "user_id", "github_login", "created_at" FROM `github_users`;--> statement-breakpoint
DROP TABLE `github_users`;--> statement-breakpoint
ALTER TABLE `__new_github_users` RENAME TO `github_users`;--> statement-breakpoint
CREATE UNIQUE INDEX `github_users_workspace_login_idx` ON `github_users` (`workspace_id`,`github_login`);--> statement-breakpoint
CREATE UNIQUE INDEX `github_users_workspace_user_idx` ON `github_users` (`workspace_id`,`user_id`);--> statement-breakpoint
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
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_issue_history`("id", "workspace_id", "issue_id", "linear_id", "field", "from_value", "to_value", "actor_id", "created_at") SELECT "id", "workspace_id", "issue_id", "linear_id", "field", "from_value", "to_value", "actor_id", "created_at" FROM `issue_history`;--> statement-breakpoint
DROP TABLE `issue_history`;--> statement-breakpoint
ALTER TABLE `__new_issue_history` RENAME TO `issue_history`;--> statement-breakpoint
CREATE INDEX `issue_history_issue_idx` ON `issue_history` (`workspace_id`,`issue_id`);--> statement-breakpoint
CREATE INDEX `issue_history_created_idx` ON `issue_history` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_issue_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`from_issue_id` text NOT NULL,
	`to_issue_id` text NOT NULL,
	`type` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_issue_relations`("id", "workspace_id", "from_issue_id", "to_issue_id", "type", "created_at") SELECT "id", "workspace_id", "from_issue_id", "to_issue_id", "type", "created_at" FROM `issue_relations`;--> statement-breakpoint
DROP TABLE `issue_relations`;--> statement-breakpoint
ALTER TABLE `__new_issue_relations` RENAME TO `issue_relations`;--> statement-breakpoint
CREATE INDEX `issue_relations_from_idx` ON `issue_relations` (`workspace_id`,`from_issue_id`);--> statement-breakpoint
CREATE INDEX `issue_relations_to_idx` ON `issue_relations` (`workspace_id`,`to_issue_id`);--> statement-breakpoint
CREATE TABLE `__new_issue_subscribers` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`linear_user_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_issue_subscribers`("id", "workspace_id", "issue_id", "linear_user_id", "created_at") SELECT "id", "workspace_id", "issue_id", "linear_user_id", "created_at" FROM `issue_subscribers`;--> statement-breakpoint
DROP TABLE `issue_subscribers`;--> statement-breakpoint
ALTER TABLE `__new_issue_subscribers` RENAME TO `issue_subscribers`;--> statement-breakpoint
CREATE INDEX `issue_subscribers_issue_idx` ON `issue_subscribers` (`workspace_id`,`issue_id`);--> statement-breakpoint
CREATE INDEX `issue_subscribers_user_idx` ON `issue_subscribers` (`workspace_id`,`linear_user_id`);--> statement-breakpoint
CREATE TABLE `__new_labels` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_labels`("id", "workspace_id", "name", "color", "created_at") SELECT "id", "workspace_id", "name", "color", "created_at" FROM `labels`;--> statement-breakpoint
DROP TABLE `labels`;--> statement-breakpoint
ALTER TABLE `__new_labels` RENAME TO `labels`;--> statement-breakpoint
CREATE INDEX `labels_workspace_idx` ON `labels` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `__new_linear_users` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`linear_id` text NOT NULL,
	`name` text,
	`email` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_linear_users`("id", "workspace_id", "linear_id", "name", "email", "created_at") SELECT "id", "workspace_id", "linear_id", "name", "email", "created_at" FROM `linear_users`;--> statement-breakpoint
DROP TABLE `linear_users`;--> statement-breakpoint
ALTER TABLE `__new_linear_users` RENAME TO `linear_users`;--> statement-breakpoint
CREATE INDEX `linear_users_workspace_idx` ON `linear_users` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `linear_users_linear_idx` ON `linear_users` (`workspace_id`,`linear_id`);--> statement-breakpoint
CREATE INDEX `linear_users_email_idx` ON `linear_users` (`email`);--> statement-breakpoint
CREATE TABLE `__new_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`recipient_type` text DEFAULT 'user' NOT NULL,
	`issue_id` text NOT NULL,
	`type` text NOT NULL,
	`read` integer DEFAULT false NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_notifications`("id", "workspace_id", "recipient_id", "recipient_type", "issue_id", "type", "read", "metadata", "created_at", "updated_at") SELECT "id", "workspace_id", "recipient_id", "recipient_type", "issue_id", "type", "read", "metadata", "created_at", "updated_at" FROM `notifications`;--> statement-breakpoint
DROP TABLE `notifications`;--> statement-breakpoint
ALTER TABLE `__new_notifications` RENAME TO `notifications`;--> statement-breakpoint
CREATE INDEX `notifications_recipient_idx` ON `notifications` (`workspace_id`,`recipient_id`,`recipient_type`,`read`);--> statement-breakpoint
CREATE INDEX `notifications_issue_idx` ON `notifications` (`workspace_id`,`issue_id`);--> statement-breakpoint
CREATE TABLE `__new_outbound_webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`event` text NOT NULL,
	`payload` text NOT NULL,
	`url` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`status_code` integer,
	`error` text,
	`attempt_count` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subscription_id`) REFERENCES `webhook_subscriptions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_outbound_webhook_deliveries`("id", "workspace_id", "subscription_id", "event", "payload", "url", "status", "status_code", "error", "attempt_count", "created_at", "updated_at") SELECT "id", "workspace_id", "subscription_id", "event", "payload", "url", "status", "status_code", "error", "attempt_count", "created_at", "updated_at" FROM `outbound_webhook_deliveries`;--> statement-breakpoint
DROP TABLE `outbound_webhook_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_outbound_webhook_deliveries` RENAME TO `outbound_webhook_deliveries`;--> statement-breakpoint
CREATE INDEX `outbound_webhook_deliveries_workspace_idx` ON `outbound_webhook_deliveries` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `outbound_webhook_deliveries_subscription_idx` ON `outbound_webhook_deliveries` (`subscription_id`);--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`start_date` text,
	`end_date` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_projects`("id", "workspace_id", "name", "description", "status", "start_date", "end_date", "created_at", "updated_at") SELECT "id", "workspace_id", "name", "description", "status", "start_date", "end_date", "created_at", "updated_at" FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
CREATE INDEX `projects_workspace_idx` ON `projects` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `__new_repo_branches` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`repo` text NOT NULL,
	`branch` text NOT NULL,
	`issue_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_repo_branches`("id", "workspace_id", "repo", "branch", "issue_id", "created_at") SELECT "id", "workspace_id", "repo", "branch", "issue_id", "created_at" FROM `repo_branches`;--> statement-breakpoint
DROP TABLE `repo_branches`;--> statement-breakpoint
ALTER TABLE `__new_repo_branches` RENAME TO `repo_branches`;--> statement-breakpoint
CREATE INDEX `repo_branches_repo_branch_idx` ON `repo_branches` (`repo`,`branch`);--> statement-breakpoint
CREATE TABLE `__new_repo_issues` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`repo` text NOT NULL,
	`issue_number` integer NOT NULL,
	`issue_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_repo_issues`("id", "workspace_id", "repo", "issue_number", "issue_id", "created_at") SELECT "id", "workspace_id", "repo", "issue_number", "issue_id", "created_at" FROM `repo_issues`;--> statement-breakpoint
DROP TABLE `repo_issues`;--> statement-breakpoint
ALTER TABLE `__new_repo_issues` RENAME TO `repo_issues`;--> statement-breakpoint
CREATE INDEX `repo_issues_repo_number_idx` ON `repo_issues` (`repo`,`issue_number`);--> statement-breakpoint
CREATE INDEX `repo_issues_workspace_idx` ON `repo_issues` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `__new_saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`filter` text NOT NULL,
	`search` text,
	`sort` text,
	`columns` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_saved_views`("id", "workspace_id", "owner_id", "name", "filter", "search", "sort", "columns", "created_at", "updated_at") SELECT "id", "workspace_id", "owner_id", "name", "filter", "search", "sort", "columns", "created_at", "updated_at" FROM `saved_views`;--> statement-breakpoint
DROP TABLE `saved_views`;--> statement-breakpoint
ALTER TABLE `__new_saved_views` RENAME TO `saved_views`;--> statement-breakpoint
CREATE INDEX `saved_views_workspace_idx` ON `saved_views` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `saved_views_owner_idx` ON `saved_views` (`workspace_id`,`owner_id`);--> statement-breakpoint
CREATE TABLE `__new_states` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`linear_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`color` text,
	`position` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_states`("id", "workspace_id", "linear_id", "name", "type", "color", "position", "created_at") SELECT "id", "workspace_id", "linear_id", "name", "type", "color", "position", "created_at" FROM `states`;--> statement-breakpoint
DROP TABLE `states`;--> statement-breakpoint
ALTER TABLE `__new_states` RENAME TO `states`;--> statement-breakpoint
CREATE INDEX `states_workspace_idx` ON `states` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `states_linear_idx` ON `states` (`workspace_id`,`linear_id`);--> statement-breakpoint
CREATE TABLE `__new_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`linear_id` text NOT NULL,
	`name` text NOT NULL,
	`template_data` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_templates`("id", "workspace_id", "linear_id", "name", "template_data", "created_at") SELECT "id", "workspace_id", "linear_id", "name", "template_data", "created_at" FROM `templates`;--> statement-breakpoint
DROP TABLE `templates`;--> statement-breakpoint
ALTER TABLE `__new_templates` RENAME TO `templates`;--> statement-breakpoint
CREATE INDEX `templates_workspace_idx` ON `templates` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `templates_linear_idx` ON `templates` (`workspace_id`,`linear_id`);--> statement-breakpoint
CREATE TABLE `__new_webhook_deliveries` (
	`delivery_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`event` text NOT NULL,
	`workspace_id` text,
	`processed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_webhook_deliveries`("delivery_id", "source", "event", "workspace_id", "processed_at") SELECT "delivery_id", "source", "event", "workspace_id", "processed_at" FROM `webhook_deliveries`;--> statement-breakpoint
DROP TABLE `webhook_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_webhook_deliveries` RENAME TO `webhook_deliveries`;--> statement-breakpoint
CREATE INDEX `webhook_deliveries_workspace_idx` ON `webhook_deliveries` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `__new_webhook_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`url` text NOT NULL,
	`events` text DEFAULT '*' NOT NULL,
	`secret` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_webhook_subscriptions`("id", "workspace_id", "url", "events", "secret", "created_at") SELECT "id", "workspace_id", "url", "events", "secret", "created_at" FROM `webhook_subscriptions`;--> statement-breakpoint
DROP TABLE `webhook_subscriptions`;--> statement-breakpoint
ALTER TABLE `__new_webhook_subscriptions` RENAME TO `webhook_subscriptions`;--> statement-breakpoint
CREATE INDEX `webhook_subscriptions_workspace_idx` ON `webhook_subscriptions` (`workspace_id`);