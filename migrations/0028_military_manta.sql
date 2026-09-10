CREATE TABLE `card_import_row` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`org_id` text NOT NULL,
	`row_number` integer NOT NULL,
	`contact_name` text,
	`payload_json` text NOT NULL,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claimed_at` integer,
	`file_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `card_import`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "card_import_row_outcome_ck" CHECK("card_import_row"."outcome" in ('pending','processing','published','skipped','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_import_row_import_rownum_uq` ON `card_import_row` (`import_id`,`row_number`);--> statement-breakpoint
CREATE INDEX `card_import_row_outcome_claimed_idx` ON `card_import_row` (`outcome`,`claimed_at`);--> statement-breakpoint
CREATE INDEX `card_import_row_org_import_idx` ON `card_import_row` (`org_id`,`import_id`);--> statement-breakpoint
CREATE TABLE `card_import` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`total_rows` integer DEFAULT 0 NOT NULL,
	`published_count` integer DEFAULT 0 NOT NULL,
	`skipped_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "card_import_status_ck" CHECK("card_import"."status" in ('pending','processing','completed','completed_with_errors','failed'))
);
--> statement-breakpoint
CREATE INDEX `card_import_org_created_idx` ON `card_import` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `card_import_org_actor_created_idx` ON `card_import` (`org_id`,`actor_user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `file` ADD `slug_base` text;--> statement-breakpoint
CREATE UNIQUE INDEX `file_org_slug_base_uq` ON `file` (`org_id`,`slug_base`) WHERE "file"."slug_base" is not null and "file"."deleted_at" is null;