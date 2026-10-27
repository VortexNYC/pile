-- VTX-752 — collapse duplicate labels (per organization+name+kind) and
-- states (per organization+name) onto the canonical row, re-point the
-- D1-side references, then enforce uniqueness so the dups cannot recur.
-- Canonical pick = earliest created_at, then lowest id — the same pick
-- mergeDuplicateLabels/mergeDuplicateStates make in the API cleanup path.

CREATE TABLE `_vtx752_dup_labels` AS
SELECT l.`id` AS `dup_id`, c.`id` AS `canonical_id`
FROM `labels` l
JOIN `labels` c
  ON c.`organization_id` = l.`organization_id`
 AND c.`name` = l.`name`
 AND c.`kind` = l.`kind`
 AND (c.`created_at` < l.`created_at`
      OR (c.`created_at` = l.`created_at` AND c.`id` < l.`id`));
--> statement-breakpoint
-- Joins whose ticket already carries the canonical label would violate
-- support_ticket_labels_unique_idx after the repoint — drop them first.
DELETE FROM `support_ticket_labels`
WHERE `label_id` IN (SELECT `dup_id` FROM `_vtx752_dup_labels`)
  AND EXISTS (
    SELECT 1 FROM `_vtx752_dup_labels` m
    JOIN `support_ticket_labels` keep
      ON keep.`ticket_id` = `support_ticket_labels`.`ticket_id`
     AND keep.`label_id` = m.`canonical_id`
    WHERE m.`dup_id` = `support_ticket_labels`.`label_id`
  );
--> statement-breakpoint
-- Remaining joins re-point at the canonical label.
UPDATE `support_ticket_labels`
SET `label_id` = (
  SELECT `canonical_id` FROM `_vtx752_dup_labels`
  WHERE `dup_id` = `support_ticket_labels`.`label_id`
)
WHERE `label_id` IN (SELECT `dup_id` FROM `_vtx752_dup_labels`);
--> statement-breakpoint
-- Issue label_ids CSVs and git_automation_states.state_id live in the
-- per-workspace Durable Object, not D1 — POST
-- /workspaces/{organizationId}/dedupe re-points (and drops dead ids) there.
DELETE FROM `labels`
WHERE `id` IN (SELECT `dup_id` FROM `_vtx752_dup_labels`);
--> statement-breakpoint
DROP TABLE `_vtx752_dup_labels`;
--> statement-breakpoint
CREATE TABLE `_vtx752_dup_states` AS
SELECT s.`id` AS `dup_id`, c.`id` AS `canonical_id`
FROM `states` s
JOIN `states` c
  ON c.`organization_id` = s.`organization_id`
 AND c.`name` = s.`name`
 AND (c.`created_at` < s.`created_at`
      OR (c.`created_at` = s.`created_at` AND c.`id` < s.`id`));
--> statement-breakpoint
DELETE FROM `states`
WHERE `id` IN (SELECT `dup_id` FROM `_vtx752_dup_states`);
--> statement-breakpoint
DROP TABLE `_vtx752_dup_states`;
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_unique_name_kind_idx` ON `labels` (`organization_id`,`name`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `states_unique_name_idx` ON `states` (`organization_id`,`name`);
