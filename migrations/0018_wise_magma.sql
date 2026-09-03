ALTER TABLE `workspaces` ADD `key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_key_unique` ON `workspaces` (`key`);