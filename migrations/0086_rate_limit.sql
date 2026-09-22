CREATE TABLE IF NOT EXISTS `rate_limit` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
