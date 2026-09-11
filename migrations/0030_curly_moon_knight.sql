CREATE TABLE `card_visit_event` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`file_id` text NOT NULL,
	`metric` text NOT NULL,
	`created_at` integer NOT NULL,
	`ip` text,
	`visitor_hash` text,
	`country` text,
	`region` text,
	`city` text,
	`postal` text,
	`latitude` real,
	`longitude` real,
	`timezone` text,
	`asn` integer,
	`as_org` text,
	`user_agent` text,
	`referrer` text,
	`src` text,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "card_visit_event_metric_ck" CHECK("card_visit_event"."metric" in ('view','scan','download','pdf'))
);
--> statement-breakpoint
CREATE INDEX `card_visit_event_org_created_idx` ON `card_visit_event` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `card_visit_event_org_file_created_idx` ON `card_visit_event` (`org_id`,`file_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `card_visit_event_org_metric_created_idx` ON `card_visit_event` (`org_id`,`metric`,`created_at`);--> statement-breakpoint
CREATE INDEX `card_visit_event_org_visitor_idx` ON `card_visit_event` (`org_id`,`visitor_hash`);