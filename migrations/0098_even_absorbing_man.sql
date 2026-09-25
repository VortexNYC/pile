CREATE TABLE `scimConnectionBinding` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`connection_key` text NOT NULL,
	`provisioning_domain_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`decommissioned_at` integer,
	`decommission_status` text NOT NULL,
	`decommission_cursor_user_id` text,
	`decommission_reconciled_user_count` integer NOT NULL,
	`decommission_batch_count` integer NOT NULL,
	`decommission_revision` integer NOT NULL,
	`decommission_completed_at` integer,
	`decommission_lease_id` text,
	`decommission_lease_expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scimConnectionBinding_connection_key_unique` ON `scimConnectionBinding` (`connection_key`);--> statement-breakpoint
CREATE TABLE `scimGroup` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provisioning_domain_id` text NOT NULL,
	`revision` integer NOT NULL,
	`display_name` text NOT NULL,
	`display_name_key` text NOT NULL,
	`external_id` text,
	`external_id_key` text,
	`order_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scimGroup_display_name_key_unique` ON `scimGroup` (`display_name_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `scimGroup_external_id_key_unique` ON `scimGroup` (`external_id_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `scimGroup_order_key_unique` ON `scimGroup` (`order_key`);--> statement-breakpoint
CREATE TABLE `scimGroupMember` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`group_id` text NOT NULL,
	`scim_user_id` text NOT NULL,
	`membership_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `scimGroup`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scim_user_id`) REFERENCES `scimUser`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scimGroupMember_membership_key_unique` ON `scimGroupMember` (`membership_key`);--> statement-breakpoint
CREATE TABLE `scimIdentityTombstone` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provisioning_domain_id` text NOT NULL,
	`external_id` text NOT NULL,
	`external_id_key` text NOT NULL,
	`user_id` text NOT NULL,
	`profile` text NOT NULL,
	`deleted_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scimIdentityTombstone_external_id_key_unique` ON `scimIdentityTombstone` (`external_id_key`);--> statement-breakpoint
CREATE TABLE `scimManagedConnection` (
	`id` text PRIMARY KEY NOT NULL,
	`creation_request_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`provisioning_domain_id` text NOT NULL,
	`status` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`decommission_started_at` integer,
	`decommission_started_by` text,
	`decommissioned_at` integer,
	`decommissioned_by` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scimManagedConnection_creation_request_id_unique` ON `scimManagedConnection` (`creation_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scimManagedConnection_connection_id_unique` ON `scimManagedConnection` (`connection_id`);--> statement-breakpoint
CREATE TABLE `scimManagedConnectionEvent` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_record_id` text NOT NULL,
	`event_key` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`actor_id` text NOT NULL,
	`credential_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`connection_record_id`) REFERENCES `scimManagedConnection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scimManagedConnectionEvent_event_key_unique` ON `scimManagedConnectionEvent` (`event_key`);--> statement-breakpoint
CREATE TABLE `scimManagedCredential` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_record_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`token_digest` text NOT NULL,
	`hash_version` text NOT NULL,
	`active_slot_key` text NOT NULL,
	`status` text NOT NULL,
	`serialized_scopes` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`revoked_by` text,
	`decommissioned_at` integer,
	FOREIGN KEY (`connection_record_id`) REFERENCES `scimManagedConnection`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scimManagedCredential_credential_id_unique` ON `scimManagedCredential` (`credential_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scimManagedCredential_active_slot_key_unique` ON `scimManagedCredential` (`active_slot_key`);--> statement-breakpoint
CREATE TABLE `scimProjectionGrant` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provisioning_domain_id` text NOT NULL,
	`scim_user_id` text NOT NULL,
	`user_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`source_value` text,
	`role` text NOT NULL,
	`grant_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`scim_user_id`) REFERENCES `scimUser`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scimProjectionGrant_grant_key_unique` ON `scimProjectionGrant` (`grant_key`);--> statement-breakpoint
CREATE TABLE `scimSubject` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`profile_source_id` text,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scimSubject_user_id_unique` ON `scimSubject` (`user_id`);--> statement-breakpoint
CREATE TABLE `scimUser` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`provisioning_domain_id` text NOT NULL,
	`user_id` text NOT NULL,
	`connection_user_key` text NOT NULL,
	`user_name` text NOT NULL,
	`user_name_key` text NOT NULL,
	`primary_email` text NOT NULL,
	`work_email_value_index` text NOT NULL,
	`email_value_index` text NOT NULL,
	`display_name` text NOT NULL,
	`formatted_name` text NOT NULL,
	`given_name` text,
	`family_name` text,
	`serialized_emails` text NOT NULL,
	`serialized_attributes` text,
	`external_id` text,
	`external_id_key` text,
	`active` integer NOT NULL,
	`order_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scimUser_connection_user_key_unique` ON `scimUser` (`connection_user_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `scimUser_user_name_key_unique` ON `scimUser` (`user_name_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `scimUser_external_id_key_unique` ON `scimUser` (`external_id_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `scimUser_order_key_unique` ON `scimUser` (`order_key`);