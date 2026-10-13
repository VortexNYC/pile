-- Group SMS threads: a group conversation keys on sendblue's group_id
-- rather than any single phone.
ALTER TABLE `support_sms_threads` ADD `group_id` text;
