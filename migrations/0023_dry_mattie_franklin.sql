CREATE TABLE `help_article` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`category` text DEFAULT 'General' NOT NULL,
	`body_html` text DEFAULT '' NOT NULL,
	`excerpt` text,
	`page_key` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`shared` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`published_at` integer,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "help_article_status_ck" CHECK("help_article"."status" in ('draft','published'))
);
--> statement-breakpoint
CREATE INDEX `help_article_org_status_cat_idx` ON `help_article` (`org_id`,`status`,`category`,`sort_order`);--> statement-breakpoint
CREATE INDEX `help_article_org_pagekey_idx` ON `help_article` (`org_id`,`page_key`);--> statement-breakpoint
CREATE INDEX `help_article_shared_status_idx` ON `help_article` (`shared`,`status`);--> statement-breakpoint
CREATE TABLE `help_image` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`article_id` text,
	`r2_key` text NOT NULL,
	`content_type` text NOT NULL,
	`uploaded_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`article_id`) REFERENCES `help_article`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `help_image_org_article_idx` ON `help_image` (`org_id`,`article_id`);