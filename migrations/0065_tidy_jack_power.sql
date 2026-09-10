PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_support_ticket_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`user_id` text,
	`team_id` text,
	`is_primary` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "support_ticket_assignments_assignee_check" CHECK((
        ("__new_support_ticket_assignments"."user_id" IS NOT NULL AND "__new_support_ticket_assignments"."team_id" IS NULL)
        OR ("__new_support_ticket_assignments"."user_id" IS NULL AND "__new_support_ticket_assignments"."team_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
INSERT INTO `__new_support_ticket_assignments`("id", "ticket_id", "user_id", "team_id", "is_primary") SELECT "id", "ticket_id", "user_id", "team_id", "is_primary" FROM `support_ticket_assignments`;--> statement-breakpoint
DROP TABLE `support_ticket_assignments`;--> statement-breakpoint
ALTER TABLE `__new_support_ticket_assignments` RENAME TO `support_ticket_assignments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `support_ticket_assignments_user_unique_idx` ON `support_ticket_assignments` (`ticket_id`,`user_id`) WHERE "support_ticket_assignments"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `support_ticket_assignments_team_unique_idx` ON `support_ticket_assignments` (`ticket_id`,`team_id`) WHERE "support_ticket_assignments"."team_id" is not null;--> statement-breakpoint
CREATE INDEX `support_ticket_assignments_ticket_idx` ON `support_ticket_assignments` (`ticket_id`,`is_primary`);