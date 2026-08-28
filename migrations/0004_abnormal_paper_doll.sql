PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_organization` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`logo` text,
	`created_at` integer NOT NULL,
	`metadata` text,
	`storage_quota_bytes` integer DEFAULT 10737418240,
	`storage_used_bytes` integer DEFAULT 0,
	`public_domain` text DEFAULT 'contacts.americaworks.com'
);
--> statement-breakpoint
INSERT INTO `__new_organization`("id", "name", "slug", "logo", "created_at", "metadata", "storage_quota_bytes", "storage_used_bytes", "public_domain") SELECT "id", "name", "slug", "logo", "created_at", "metadata", "storage_quota_bytes", "storage_used_bytes", "public_domain" FROM `organization`;--> statement-breakpoint
DROP TABLE `organization`;--> statement-breakpoint
ALTER TABLE `__new_organization` RENAME TO `organization`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_unique` ON `organization` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_slug_uidx` ON `organization` (`slug`);--> statement-breakpoint
ALTER TABLE `member` ADD `status` text DEFAULT 'active';