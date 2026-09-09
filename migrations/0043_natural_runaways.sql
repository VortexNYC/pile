ALTER TABLE `projects` ADD `health` text DEFAULT 'on_track' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `archived_at` text;