-- Fold support_companies into workspace customers: the join table's
-- companyId is now a customer id, so the FK is dropped. The shadow
-- table goes away entirely.
CREATE TABLE `support_customer_companies_new` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`company_id` text NOT NULL,
	`company_name` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `support_customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `support_customer_companies_new` (id, customer_id, company_id, company_name, is_primary, created_at)
  SELECT id, customer_id, company_id, company_name, is_primary, created_at FROM `support_customer_companies`;
--> statement-breakpoint
DROP TABLE `support_customer_companies`;
--> statement-breakpoint
ALTER TABLE `support_customer_companies_new` RENAME TO `support_customer_companies`;
--> statement-breakpoint
CREATE UNIQUE INDEX `support_customer_companies_unique_idx` ON `support_customer_companies` (`customer_id`,`company_id`);
--> statement-breakpoint
CREATE INDEX `support_customer_companies_company_idx` ON `support_customer_companies` (`company_id`);
--> statement-breakpoint
DROP TABLE IF EXISTS `support_companies`;
