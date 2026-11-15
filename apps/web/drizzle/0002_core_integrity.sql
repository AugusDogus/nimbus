CREATE TABLE `nimbus_dav_property` (
	`path` text NOT NULL,
	`namespace` text NOT NULL,
	`name` text NOT NULL,
	`xml` text NOT NULL,
	PRIMARY KEY(`path`, `namespace`, `name`)
);
--> statement-breakpoint
CREATE TABLE `nimbus_home` (
	`user_id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nimbus_home_path_unique` ON `nimbus_home` (`path`);--> statement-breakpoint
ALTER TABLE `nimbus_trash` ADD `detached_access` text DEFAULT '{"grants":[],"shares":[],"bookmarks":[],"properties":[]}' NOT NULL;