CREATE TABLE `nimbus_imported_icon_theme` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`extension` text NOT NULL,
	`licence` text,
	`bytes` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `imported_icon_theme_user_idx` ON `nimbus_imported_icon_theme` (`user_id`);