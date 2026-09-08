-- Better Auth 1.7 upgrade (spec 0023). HAND-EDITED per gotcha #9.
--
-- drizzle-kit's generated version also rebuilt `organization` and `member`
-- (CREATE __new_* / INSERT SELECT / DROP TABLE / RENAME) purely to add NOT NULL to
-- columns that already exist, already carry defaults, and are already populated in
-- every row -- a cosmetic constraint the 1.7 runtime does not need. Those rebuilds were
-- REMOVED: on D1 a parent-table rebuild IGNORES `PRAGMA foreign_keys=OFF` inside the
-- migration transaction, so `DROP TABLE organization` would cascade-wipe member/file/
-- audit_event/org_settings/org_o365/org_domains/... (gotcha #9). The DB keeps those
-- columns exactly as they are; only the additive twoFactor columns below are applied --
-- the 1.7 built-in 2FA-code lockout the runtime actually reads and writes.
--
-- The meta snapshot drizzle-kit wrote for 0022 records the (harmless) NOT NULL + slug
-- index rename, so a future `drizzle-kit generate` sees no diff and will not re-emit the
-- rebuild. Leaving that snapshot in place is intentional.
ALTER TABLE `two_factor` ADD `verified` integer DEFAULT true;--> statement-breakpoint
ALTER TABLE `two_factor` ADD `failed_verification_count` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `two_factor` ADD `locked_until` integer;
