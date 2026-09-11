ALTER TABLE `webhook_deliveries`
  ADD COLUMN `status` TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE `webhook_deliveries`
  ADD COLUMN `attempt_count` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `webhook_deliveries`
  ADD COLUMN `payload` TEXT;
ALTER TABLE `webhook_deliveries`
  ADD COLUMN `last_error` TEXT;
ALTER TABLE `webhook_deliveries`
  ADD COLUMN `next_retry_at` TEXT;
ALTER TABLE `webhook_deliveries`
  ADD COLUMN `locked_at` TEXT;

UPDATE `webhook_deliveries`
  SET `status` = 'completed'
  WHERE `status` = 'pending';

CREATE INDEX IF NOT EXISTS `webhook_deliveries_status_idx`
  ON `webhook_deliveries` (`status`);
