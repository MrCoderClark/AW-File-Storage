CREATE TABLE `help_category` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`parent_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `help_category_org_parent_idx` ON `help_category` (`org_id`,`parent_id`,`sort_order`);--> statement-breakpoint
ALTER TABLE `help_article` ADD `category_id` text;--> statement-breakpoint
ALTER TABLE `help_article` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `help_article` ADD `featured_image_id` text;--> statement-breakpoint
ALTER TABLE `help_article` ADD `related_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `help_article` ADD `audience` text DEFAULT 'all' NOT NULL;