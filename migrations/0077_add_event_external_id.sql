ALTER TABLE `support_ticket_events` ADD `external_id` text;
CREATE UNIQUE INDEX `support_ticket_events_ticket_external_type_idx` ON `support_ticket_events` (`ticket_id`, `external_id`, `type`);
