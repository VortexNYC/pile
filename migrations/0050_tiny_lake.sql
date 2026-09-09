CREATE TABLE `emojis` (
  `id` text PRIMARY KEY,
  `organization_id` text NOT NULL REFERENCES organization(id) ON DELETE cascade,
  `name` text NOT NULL,
  `shortcut` text NOT NULL,
  `url` text NOT NULL,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX `emojis_organizationId_idx` ON `emojis` (`organization_id`);
CREATE INDEX `emojis_shortcut_idx` ON `emojis` (`organization_id`, `shortcut`);