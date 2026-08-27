ALTER TABLE `two_factor` DROP COLUMN `verified`;--> statement-breakpoint
ALTER TABLE `two_factor` DROP COLUMN `failed_verification_count`;--> statement-breakpoint
ALTER TABLE `two_factor` DROP COLUMN `locked_until`;