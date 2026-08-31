CREATE TABLE `org_social_link` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`state` text NOT NULL,
	`facebook` text,
	`x` text,
	`instagram` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_social_link_org_state_uq` ON `org_social_link` (`org_id`,`state`);