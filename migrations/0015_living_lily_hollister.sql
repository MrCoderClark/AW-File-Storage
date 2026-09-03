CREATE TABLE `org_o365` (
	`org_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`client_id` text NOT NULL,
	`auth_method` text NOT NULL,
	`secret_ct` text,
	`secret_iv` text,
	`cert_key_ct` text,
	`cert_key_iv` text,
	`cert_thumbprint` text,
	`last_verified_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
