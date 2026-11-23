CREATE TABLE `nimbus_undone_receipt` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nimbus_undone_receipt_expiry` ON `nimbus_undone_receipt` (`expires_at`);--> statement-breakpoint
CREATE TABLE `nimbus_mcp_upload_claim` (
	`key` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nimbus_mcp_upload_claim_expiry` ON `nimbus_mcp_upload_claim` (`expires_at`);