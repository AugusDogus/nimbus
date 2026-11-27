CREATE TABLE `nimbus_user_appearance` (
	`user_id` text PRIMARY KEY NOT NULL,
	`icon_theme` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
