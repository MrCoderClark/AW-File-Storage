CREATE TABLE `org_settings` (
	`org_id` text PRIMARY KEY NOT NULL,
	`o365_sync_enabled` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Backfill (spec 0012, AC-8): give every existing org a settings row seeded from
-- the current global app_settings.o365_sync_enabled, so behaviour is unchanged at
-- cutover (O365 sync is currently ON in prod). Idempotent (skips orgs that already
-- have a row); a fresh DB with no orgs yet (e.g. the test D1) inserts nothing.
INSERT INTO `org_settings` (`org_id`, `o365_sync_enabled`, `updated_at`)
SELECT o.`id`,
       COALESCE((SELECT `o365_sync_enabled` FROM `app_settings` WHERE `id` = 'app'), 0),
       (strftime('%s','now') * 1000)
FROM `organization` o
WHERE NOT EXISTS (SELECT 1 FROM `org_settings` s WHERE s.`org_id` = o.`id`);
