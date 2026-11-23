CREATE TABLE `nimbus_dav_lock` (
	`token` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`depth` text NOT NULL,
	`owner` text NOT NULL,
	`timeout_seconds` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `nimbus_dav_lock_expiry` ON `nimbus_dav_lock` (`expires_at`);