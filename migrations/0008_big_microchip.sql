ALTER TABLE `file` ADD `contact_name` text;--> statement-breakpoint
ALTER TABLE `file` ADD `contact_org` text;--> statement-breakpoint
ALTER TABLE `file` ADD `contact_title` text;--> statement-breakpoint
ALTER TABLE `file` ADD `contact_email` text;--> statement-breakpoint
ALTER TABLE `file` ADD `category` text;--> statement-breakpoint
CREATE INDEX `file_org_deleted_id_idx` ON `file` (`org_id`,`deleted_at`,`id`);--> statement-breakpoint
CREATE INDEX `file_org_deleted_category_id_idx` ON `file` (`org_id`,`deleted_at`,`category`,`id`);--> statement-breakpoint
CREATE INDEX `file_org_deleted_status_id_idx` ON `file` (`org_id`,`deleted_at`,`status`,`id`);--> statement-breakpoint
CREATE INDEX `file_org_deleted_name_id_idx` ON `file` (`org_id`,`deleted_at`,`original_name`,`id`);--> statement-breakpoint
CREATE INDEX `file_org_deleted_size_id_idx` ON `file` (`org_id`,`deleted_at`,`size_bytes`,`id`);--> statement-breakpoint
CREATE INDEX `file_org_deleted_updated_id_idx` ON `file` (`org_id`,`deleted_at`,`updated_at`,`id`);