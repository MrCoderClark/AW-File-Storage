CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `invitation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`inviter_id` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inviter_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invitation_organizationId_idx` ON `invitation` (`organization_id`);--> statement-breakpoint
CREATE INDEX `invitation_email_idx` ON `invitation` (`email`);--> statement-breakpoint
CREATE TABLE `member` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_organizationId_idx` ON `member` (`organization_id`);--> statement-breakpoint
CREATE INDEX `member_userId_idx` ON `member` (`user_id`);--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`created_at` integer NOT NULL,
	`metadata` text,
	`storage_quota_bytes` integer DEFAULT 5497558138880,
	`storage_used_bytes` integer DEFAULT 0,
	`public_domain` text DEFAULT 'contacts.americaworks.com'
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_unique` ON `organization` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_uidx` ON `organization` (`slug`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`active_organization_id` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `two_factor` (
	`id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`backup_codes` text NOT NULL,
	`user_id` text NOT NULL,
	`verified` integer DEFAULT true,
	`failed_verification_count` integer DEFAULT 0,
	`locked_until` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `twoFactor_secret_idx` ON `two_factor` (`secret`);--> statement-breakpoint
CREATE INDEX `twoFactor_userId_idx` ON `two_factor` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`two_factor_enabled` integer DEFAULT false
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_account_lock` (
	`user_id` text PRIMARY KEY NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`lock_level` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_account_lock`("user_id", "failed_count", "locked_until", "lock_level") SELECT "user_id", "failed_count", "locked_until", "lock_level" FROM `account_lock`;--> statement-breakpoint
DROP TABLE `account_lock`;--> statement-breakpoint
ALTER TABLE `__new_account_lock` RENAME TO `account_lock`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_audit_event` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`ip` text,
	`user_agent` text,
	`metadata_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_audit_event`("id", "org_id", "actor_user_id", "action", "target_type", "target_id", "ip", "user_agent", "metadata_json", "created_at") SELECT "id", "org_id", "actor_user_id", "action", "target_type", "target_id", "ip", "user_agent", "metadata_json", "created_at" FROM `audit_event`;--> statement-breakpoint
DROP TABLE `audit_event`;--> statement-breakpoint
ALTER TABLE `__new_audit_event` RENAME TO `audit_event`;--> statement-breakpoint
CREATE INDEX `audit_event_org_created_idx` ON `audit_event` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_event_org_target_idx` ON `audit_event` (`org_id`,`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `__new_file_version` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`file_id` text NOT NULL,
	`version` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`checksum_sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_file_version`("id", "org_id", "file_id", "version", "size_bytes", "checksum_sha256", "storage_key", "uploaded_by", "created_at") SELECT "id", "org_id", "file_id", "version", "size_bytes", "checksum_sha256", "storage_key", "uploaded_by", "created_at" FROM `file_version`;--> statement-breakpoint
DROP TABLE `file_version`;--> statement-breakpoint
ALTER TABLE `__new_file_version` RENAME TO `file_version`;--> statement-breakpoint
CREATE UNIQUE INDEX `file_version_file_version_uq` ON `file_version` (`file_id`,`version`);--> statement-breakpoint
CREATE INDEX `file_version_org_file_idx` ON `file_version` (`org_id`,`file_id`);--> statement-breakpoint
CREATE TABLE `__new_file` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`original_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`checksum_sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`bucket` text NOT NULL,
	`visibility` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`failure_reason` text,
	`public_slug` text,
	`published_at` integer,
	`deleted_at` integer,
	`deleted_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deleted_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "file_bucket_ck" CHECK("__new_file"."bucket" in ('private','public')),
	CONSTRAINT "file_visibility_ck" CHECK("__new_file"."visibility" in ('private','public')),
	CONSTRAINT "file_kind_ck" CHECK("__new_file"."kind" in ('vcard','other')),
	CONSTRAINT "file_status_ck" CHECK("__new_file"."status" in ('pending','uploading','validating','ready','failed'))
);
--> statement-breakpoint
INSERT INTO `__new_file`("id", "org_id", "uploaded_by", "original_name", "content_type", "size_bytes", "checksum_sha256", "storage_key", "bucket", "visibility", "kind", "status", "failure_reason", "public_slug", "published_at", "deleted_at", "deleted_by", "created_at", "updated_at") SELECT "id", "org_id", "uploaded_by", "original_name", "content_type", "size_bytes", "checksum_sha256", "storage_key", "bucket", "visibility", "kind", "status", "failure_reason", "public_slug", "published_at", "deleted_at", "deleted_by", "created_at", "updated_at" FROM `file`;--> statement-breakpoint
DROP TABLE `file`;--> statement-breakpoint
ALTER TABLE `__new_file` RENAME TO `file`;--> statement-breakpoint
CREATE INDEX `file_org_deleted_created_idx` ON `file` (`org_id`,`deleted_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `file_org_kind_idx` ON `file` (`org_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `file_public_slug_uq` ON `file` (`public_slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `file_org_checksum_uq` ON `file` (`org_id`,`checksum_sha256`) WHERE "file"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `__new_upload_session` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`file_id` text NOT NULL,
	`staging_key` text NOT NULL,
	`declared_size_bytes` integer NOT NULL,
	`declared_content_type` text NOT NULL,
	`multipart_upload_id` text,
	`expires_at` integer NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_upload_session`("id", "org_id", "user_id", "file_id", "staging_key", "declared_size_bytes", "declared_content_type", "multipart_upload_id", "expires_at", "completed_at", "created_at") SELECT "id", "org_id", "user_id", "file_id", "staging_key", "declared_size_bytes", "declared_content_type", "multipart_upload_id", "expires_at", "completed_at", "created_at" FROM `upload_session`;--> statement-breakpoint
DROP TABLE `upload_session`;--> statement-breakpoint
ALTER TABLE `__new_upload_session` RENAME TO `upload_session`;--> statement-breakpoint
CREATE INDEX `upload_session_org_expires_idx` ON `upload_session` (`org_id`,`expires_at`);