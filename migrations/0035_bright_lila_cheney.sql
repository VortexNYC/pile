CREATE TABLE `issue_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`requested_by_id` text NOT NULL,
	`approver_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`comment` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `issue_approvals_issue_idx` ON `issue_approvals` (`issue_id`);--> statement-breakpoint
CREATE INDEX `issue_approvals_organization_idx` ON `issue_approvals` (`organization_id`);