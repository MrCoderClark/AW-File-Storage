CREATE TABLE `pending_email` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`send_after` integer NOT NULL,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pending_email_due_idx` ON `pending_email` (`sent_at`,`send_after`);--> statement-breakpoint
CREATE TABLE `scim_token` (
	`org_id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scim_token_hash_uq` ON `scim_token` (`token_hash`);