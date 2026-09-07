ALTER TABLE `file` ADD `offboarded_at` integer;--> statement-breakpoint
ALTER TABLE `org_settings` ADD `o365_remove_on_offboard_enabled` integer DEFAULT false NOT NULL;