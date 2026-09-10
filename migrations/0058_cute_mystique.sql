CREATE TABLE `support_companies` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`external_id` text,
	`external_source` text DEFAULT 'manual' NOT NULL,
	`name` text NOT NULL,
	`domain` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_companies_org_name_idx` ON `support_companies` (`organization_id`,`name`);--> statement-breakpoint
CREATE INDEX `support_companies_org_domain_idx` ON `support_companies` (`organization_id`,`domain`);--> statement-breakpoint
CREATE TABLE `support_customer_companies` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`company_id` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `support_customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `support_companies`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_customer_companies_unique_idx` ON `support_customer_companies` (`customer_id`,`company_id`);--> statement-breakpoint
CREATE INDEX `support_customer_companies_company_idx` ON `support_customer_companies` (`company_id`);--> statement-breakpoint
CREATE TABLE `support_customer_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`type` text NOT NULL,
	`value` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `support_customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_customer_identities_unique_idx` ON `support_customer_identities` (`customer_id`,`type`,`value`);--> statement-breakpoint
CREATE TABLE `support_customers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text,
	`external_id` text,
	`external_source` text DEFAULT 'manual' NOT NULL,
	`email` text NOT NULL,
	`full_name` text,
	`phone` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_customers_org_email_idx` ON `support_customers` (`organization_id`,`email`);--> statement-breakpoint
CREATE INDEX `support_customers_org_external_idx` ON `support_customers` (`organization_id`,`external_id`,`external_source`);