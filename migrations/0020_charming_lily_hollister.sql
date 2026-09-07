ALTER TABLE `file` ADD `source` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `org_settings` ADD `o365_auto_card_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `org_settings` ADD `o365_auto_card_since` integer;