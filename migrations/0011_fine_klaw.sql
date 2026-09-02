CREATE TABLE `app_settings` (
	`id` text PRIMARY KEY DEFAULT 'app' NOT NULL,
	`require_app_host_card_login` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL
);
