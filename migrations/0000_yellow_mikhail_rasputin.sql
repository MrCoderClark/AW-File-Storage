CREATE TABLE `account_lock` (
	`user_id` text PRIMARY KEY NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`lock_level` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_event` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`ip` text,
	`user_agent` text,
	`metadata_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_event_org_created_idx` ON `audit_event` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_event_org_target_idx` ON `audit_event` (`org_id`,`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `file_version` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`file_id` text NOT NULL,
	`version` integer NOT NULL,
	`size_bytes` integer NOT NULL,
	`checksum_sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_version_file_version_uq` ON `file_version` (`file_id`,`version`);--> statement-breakpoint
CREATE INDEX `file_version_org_file_idx` ON `file_version` (`org_id`,`file_id`);--> statement-breakpoint
CREATE TABLE `file` (
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
	CONSTRAINT "file_bucket_ck" CHECK("file"."bucket" in ('private','public')),
	CONSTRAINT "file_visibility_ck" CHECK("file"."visibility" in ('private','public')),
	CONSTRAINT "file_kind_ck" CHECK("file"."kind" in ('vcard','other')),
	CONSTRAINT "file_status_ck" CHECK("file"."status" in ('pending','uploading','validating','ready','failed'))
);
--> statement-breakpoint
CREATE INDEX `file_org_deleted_created_idx` ON `file` (`org_id`,`deleted_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `file_org_kind_idx` ON `file` (`org_id`,`kind`);--> statement-breakpoint
CREATE UNIQUE INDEX `file_public_slug_uq` ON `file` (`public_slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `file_org_checksum_uq` ON `file` (`org_id`,`checksum_sha256`) WHERE "file"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `upload_session` (
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
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `upload_session_org_expires_idx` ON `upload_session` (`org_id`,`expires_at`);