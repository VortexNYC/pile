-- Existing saved views were org-visible before sharing was added; keep them shared.
UPDATE `saved_views` SET `shared` = true WHERE `shared` = false;
