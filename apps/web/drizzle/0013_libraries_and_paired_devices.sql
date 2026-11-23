-- Libraries (folders an account offers read-only to the devices it pairs, in its order), their catalogs with tombstones for files that went missing, device pairing requests and paired devices. A paired device is a grant of the new `device` resource in the existing OAuth grant store; codes and tokens are stored only as SHA-256 hashes.
CREATE TABLE `nimbus_device_pairing` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code_hash` text NOT NULL,
	`pairing_code_hash` text NOT NULL,
	`device_name` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`interval_seconds` integer NOT NULL,
	`last_polled_at` integer,
	`owner_id` text,
	`library_id` text,
	`decided_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`library_id`) REFERENCES `nimbus_library`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "nimbus_device_pairing_decision" CHECK(("nimbus_device_pairing"."state" IN ('approved', 'redeemed')) = ("nimbus_device_pairing"."owner_id" IS NOT NULL AND "nimbus_device_pairing"."library_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nimbus_device_pairing_device_code_hash_unique` ON `nimbus_device_pairing` (`device_code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `nimbus_device_pairing_pairing_code_hash_unique` ON `nimbus_device_pairing` (`pairing_code_hash`);--> statement-breakpoint
CREATE INDEX `nimbus_device_pairing_expiry` ON `nimbus_device_pairing` (`expires_at`);--> statement-breakpoint
CREATE TABLE `nimbus_library` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`catalog_changed_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `nimbus_library_owner` ON `nimbus_library` (`owner_id`);--> statement-breakpoint
CREATE TABLE `nimbus_library_folder` (
	`library_id` text NOT NULL,
	`path` text NOT NULL,
	`position` integer NOT NULL,
	`added_at` integer NOT NULL,
	`scanned_at` integer,
	PRIMARY KEY(`library_id`, `path`),
	FOREIGN KEY (`library_id`) REFERENCES `nimbus_library`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "nimbus_library_folder_not_root" CHECK("nimbus_library_folder"."path" <> '')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nimbus_library_folder_position` ON `nimbus_library_folder` (`library_id`,`position`);--> statement-breakpoint
CREATE TABLE `nimbus_library_item` (
	`id` text PRIMARY KEY NOT NULL,
	`library_id` text NOT NULL,
	`path` text NOT NULL,
	`added_at` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	`version` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`modified_at` integer NOT NULL,
	`fingerprint` text,
	`missing_since` integer,
	FOREIGN KEY (`library_id`) REFERENCES `nimbus_library`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nimbus_library_item_library_path` ON `nimbus_library_item` (`library_id`,`path`) WHERE "nimbus_library_item"."missing_since" IS NULL;--> statement-breakpoint
CREATE INDEX `nimbus_library_item_missing` ON `nimbus_library_item` (`library_id`,`missing_since`);--> statement-breakpoint
CREATE INDEX `nimbus_library_item_path` ON `nimbus_library_item` (`path`);--> statement-breakpoint
CREATE TABLE `nimbus_paired_device` (
	`grant_id` text PRIMARY KEY NOT NULL,
	`library_id` text,
	`device_name` text NOT NULL,
	`revoked_reason` text,
	FOREIGN KEY (`grant_id`) REFERENCES `nimbus_mcp_grant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`library_id`) REFERENCES `nimbus_library`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `nimbus_paired_device_library` ON `nimbus_paired_device` (`library_id`);--> statement-breakpoint
ALTER TABLE `nimbus_mcp_grant` ADD `resource` text DEFAULT 'mcp' NOT NULL;