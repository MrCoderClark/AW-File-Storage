CREATE TABLE `org_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`domain` text NOT NULL,
	`source` text NOT NULL,
	`verified_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_domains_domain_uq` ON `org_domains` (`domain`);--> statement-breakpoint
CREATE INDEX `org_domains_org_idx` ON `org_domains` (`org_id`);--> statement-breakpoint
CREATE TABLE `provision` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`status` text NOT NULL,
	`expires_at` integer NOT NULL,
	`assignments` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `provision_email_status_idx` ON `provision` (`email`,`status`);