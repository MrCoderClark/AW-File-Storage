ALTER TABLE `help_article` ADD `view_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `help_article` ADD `helpful_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `help_article` ADD `unhelpful_count` integer DEFAULT 0 NOT NULL;