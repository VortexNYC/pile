CREATE UNIQUE INDEX IF NOT EXISTS `support_ticket_messages_event_unique_idx`
  ON `support_ticket_messages` (`event_id`);
CREATE UNIQUE INDEX IF NOT EXISTS `support_ticket_notes_event_unique_idx`
  ON `support_ticket_notes` (`event_id`);
