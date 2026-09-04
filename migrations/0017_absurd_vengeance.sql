-- Widen the metric CHECK to allow 'pdf' (a .pdf save), which SQLite can only do
-- by rebuilding the table. Rows are copied BEFORE the drop, and card_stat_daily
-- is a leaf table (nothing references it), so the drop cascades to nothing.
--
-- The generator's `PRAGMA foreign_keys=OFF/ON` pair was removed by hand: D1
-- rejects it (only `defer_foreign_keys` is supported), and it is unnecessary
-- here because every copied row's organization/file parent is left untouched.
CREATE TABLE `__new_card_stat_daily` (
	`org_id` text NOT NULL,
	`file_id` text NOT NULL,
	`date` text NOT NULL,
	`metric` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`file_id`, `date`, `metric`),
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "card_stat_daily_metric_ck" CHECK("__new_card_stat_daily"."metric" in ('view','scan','download','pdf'))
);
--> statement-breakpoint
INSERT INTO `__new_card_stat_daily`("org_id", "file_id", "date", "metric", "count") SELECT "org_id", "file_id", "date", "metric", "count" FROM `card_stat_daily`;--> statement-breakpoint
DROP TABLE `card_stat_daily`;--> statement-breakpoint
ALTER TABLE `__new_card_stat_daily` RENAME TO `card_stat_daily`;--> statement-breakpoint
CREATE INDEX `card_stat_daily_org_date_idx` ON `card_stat_daily` (`org_id`,`date`);--> statement-breakpoint
CREATE INDEX `card_stat_daily_org_file_idx` ON `card_stat_daily` (`org_id`,`file_id`);