-- Links their owner turned off, by the SHA-256 of their token, so a visitor opening one is told the link was turned off rather than that it never existed. Kept for 90 days and at most 1,000 per owner; the indexes make pruning both cheap.
CREATE TABLE `nimbus_revoked_share` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`revoked_at` integer NOT NULL,
	FOREIGN KEY (`owner`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `nimbus_revoked_share_owner` ON `nimbus_revoked_share` (`owner`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `nimbus_revoked_share_revoked_at` ON `nimbus_revoked_share` (`revoked_at`);
