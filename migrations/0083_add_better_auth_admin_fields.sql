ALTER TABLE `user` ADD `role` text DEFAULT 'admin' NOT NULL;
--> statement-breakpoint
ALTER TABLE `user` ADD `banned` integer DEFAULT false;
--> statement-breakpoint
ALTER TABLE `user` ADD `ban_reason` text;
--> statement-breakpoint
ALTER TABLE `user` ADD `ban_expires` integer;
--> statement-breakpoint
ALTER TABLE `session` ADD `impersonated_by` text;
