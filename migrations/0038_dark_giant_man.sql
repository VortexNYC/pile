ALTER TABLE `cycles` ADD `number` integer;--> statement-breakpoint
ALTER TABLE `cycles` ADD `status` text DEFAULT 'upcoming' NOT NULL;--> statement-breakpoint
ALTER TABLE `cycles` ADD `auto_rollover` integer DEFAULT true NOT NULL;