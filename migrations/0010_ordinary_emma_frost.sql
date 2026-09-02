CREATE TABLE `card_stat_daily` (
	`org_id` text NOT NULL,
	`file_id` text NOT NULL,
	`date` text NOT NULL,
	`metric` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`file_id`, `date`, `metric`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "card_stat_daily_metric_ck" CHECK("card_stat_daily"."metric" in ('view','scan','download'))
);
--> statement-breakpoint
CREATE INDEX `card_stat_daily_org_date_idx` ON `card_stat_daily` (`org_id`,`date`);--> statement-breakpoint
CREATE INDEX `card_stat_daily_org_file_idx` ON `card_stat_daily` (`org_id`,`file_id`);